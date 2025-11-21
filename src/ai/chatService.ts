import OpenAI from 'openai';
import { StdioMcpClient, McpToolDefinition } from '../mcp/stdioClient.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatStreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'prompt';
  content?: string;
  toolName?: string;
  toolArgs?: any;
  toolResult?: any;
  error?: string;
  promptId?: string;
  promptParams?: any;
}

export class ChatService {
  private openai: OpenAI;
  private systemPrompt = `You are a helpful AI assistant for Sales Engineers building PingOne demos. You have access to PingOne MCP Server tools that allow you to manage PingOne environments, users, applications, and more.

CRITICAL INSTRUCTION - Response Length:
- After calling ANY tool that returns a list or data (like list-*, get-*, read-*, fetch-*), respond with ONLY 1-3 words maximum
- DO NOT mention counts or numbers - the formatted display shows the count
- Examples: "Done", "Complete", "Here you go", "Success"
- DO NOT say "Found X items" or enumerate data - the user sees formatted results
- DO NOT describe what was returned - just acknowledge completion

When a user asks you to do something:
1. Use the appropriate PingOne tools to accomplish the task
2. After the tool executes, provide ONLY a brief acknowledgment (1-3 words, no counts)
3. If you get an authentication error, explain they need to authenticate first

If you encounter an error about "no active auth session", explain:
"You need to authenticate with PingOne first. The server will prompt you for your Environment ID, Region, and Client ID, then open a browser for OAuth login."

Available capabilities include:
- Managing PingOne environments
- Creating and managing users
- Setting up applications and OAuth clients
- Configuring authentication policies
- Managing groups and roles`;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY
    });
  }

  /**
   * Convert MCP tool definitions to OpenAI function format
   */
  private convertMcpToolsToOpenAI(mcpTools: McpToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
    return mcpTools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description || `Execute ${tool.name}`,
        parameters: tool.inputSchema || {
          type: 'object',
          properties: {},
          required: []
        }
      }
    }));
  }

  /**
   * Chat with streaming support and automatic tool execution
   */
  async *chat(
    messages: ChatMessage[],
    mcpClient: StdioMcpClient,
    onToolCall?: (name: string, args: any) => void,
    onPrompt?: (promptId: string, params: any) => Promise<any>
  ): AsyncGenerator<ChatStreamChunk> {
    try {
      // Get available MCP tools
      const mcpTools = mcpClient.listTools();
      const openaiTools = this.convertMcpToolsToOpenAI(mcpTools);

      // Build messages with system prompt
      const fullMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: this.systemPrompt },
        ...messages.map(msg => {
          if (msg.role === 'tool') {
            return {
              role: 'tool' as const,
              content: msg.content,
              tool_call_id: msg.tool_call_id!
            };
          }
          return {
            role: msg.role as 'user' | 'assistant' | 'system',
            content: msg.content,
            tool_calls: msg.tool_calls
          };
        })
      ];

      let continueLoop = true;
      let currentMessages = fullMessages;
      let justExecutedListTool = false; // Track across loop iterations

      while (continueLoop) {
        continueLoop = false;

        // Call OpenAI with streaming
        const stream = await this.openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          messages: currentMessages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          stream: true
        });

        let currentToolCalls: Array<{
          id: string;
          name: string;
          arguments: string;
        }> = [];
        let textContent = '';
        let toolCallIndex = -1;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;

          // Handle text content
          if (delta?.content) {
            textContent += delta.content;
            
            // Only yield text if we haven't just executed a list tool, or if it's very short
            if (!justExecutedListTool || textContent.length < 50) {
              yield {
                type: 'text',
                content: delta.content
              };
            }
          }

          // Handle tool calls
          if (delta?.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              if (toolCall.index !== undefined) {
                toolCallIndex = toolCall.index;
              }

              if (!currentToolCalls[toolCallIndex]) {
                currentToolCalls[toolCallIndex] = {
                  id: toolCall.id || '',
                  name: '',
                  arguments: ''
                };
              }

              if (toolCall.function?.name) {
                currentToolCalls[toolCallIndex].name = toolCall.function.name;
              }
              if (toolCall.function?.arguments) {
                currentToolCalls[toolCallIndex].arguments += toolCall.function.arguments;
              }
              if (toolCall.id) {
                currentToolCalls[toolCallIndex].id = toolCall.id;
              }
            }
          }

          // Check if finished
          if (chunk.choices[0]?.finish_reason === 'tool_calls' || chunk.choices[0]?.finish_reason === 'stop') {
            break;
          }
        }

        // If we have tool calls, execute them
        if (currentToolCalls.length > 0) {
          continueLoop = true;

          // Add assistant message with tool calls to history
          const assistantMessage: OpenAI.Chat.ChatCompletionMessageParam = {
            role: 'assistant',
            content: textContent || null,
            tool_calls: currentToolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: tc.arguments
              }
            }))
          };
          currentMessages = [...currentMessages, assistantMessage];

          // Execute each tool call
          const toolResults: OpenAI.Chat.ChatCompletionMessageParam[] = [];
          
          // Reset flag, then set if we execute a list tool
          justExecutedListTool = false;

          for (const toolCall of currentToolCalls) {
            try {
              const args = JSON.parse(toolCall.arguments);
              
              // Check if this is a list/get/read type tool
              const isListTool = toolCall.name.startsWith('list-') || 
                                 toolCall.name.startsWith('get-') || 
                                 toolCall.name.startsWith('read-') ||
                                 toolCall.name.startsWith('fetch-') ||
                                 toolCall.name.includes('list') ||
                                 toolCall.name.includes('search');
              
              if (isListTool) {
                justExecutedListTool = true;
              }
              
              yield {
                type: 'tool_call',
                toolName: toolCall.name,
                toolArgs: args
              };

              if (onToolCall) {
                onToolCall(toolCall.name, args);
              }

              // Execute via MCP
              const result = await mcpClient.callTool(toolCall.name, args);

              yield {
                type: 'tool_result',
                toolName: toolCall.name,
                toolResult: result
              };

              toolResults.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(result)
              });
            } catch (error) {
              const errorMsg = (error as Error).message;
              yield {
                type: 'error',
                error: `Tool ${toolCall.name} failed: ${errorMsg}`
              };

              toolResults.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: errorMsg })
              });
            }
          }

          // Add tool results to messages and continue loop
          currentMessages = [...currentMessages, ...toolResults];
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield {
        type: 'error',
        error: (error as Error).message
      };
    }
  }

  /**
   * Non-streaming chat for REST API
   */
  async chatCompletion(
    messages: ChatMessage[],
    mcpClient: StdioMcpClient
  ): Promise<{ message: ChatMessage; toolCalls: Array<{ name: string; args: any; result: any }> }> {
    const toolCalls: Array<{ name: string; args: any; result: any }> = [];
    let responseContent = '';
    let responseToolCalls: any[] = [];

    for await (const chunk of this.chat(messages, mcpClient, (name, args) => {
      // Track tool calls
    })) {
      if (chunk.type === 'text' && chunk.content) {
        responseContent += chunk.content;
      } else if (chunk.type === 'tool_call' && chunk.toolName) {
        const tc = { name: chunk.toolName, args: chunk.toolArgs, result: null };
        toolCalls.push(tc);
      } else if (chunk.type === 'tool_result' && chunk.toolResult) {
        const lastCall = toolCalls[toolCalls.length - 1];
        if (lastCall) {
          lastCall.result = chunk.toolResult;
        }
      } else if (chunk.type === 'error') {
        throw new Error(chunk.error);
      }
    }

    return {
      message: {
        role: 'assistant',
        content: responseContent,
        tool_calls: responseToolCalls.length > 0 ? responseToolCalls : undefined
      },
      toolCalls
    };
  }
}
