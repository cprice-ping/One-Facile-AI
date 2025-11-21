import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { SessionManager } from './mcp/sessionManager.js';
import { buildRouter } from './api/routes.js';
import { ChatService, ChatMessage } from './ai/chatService.js';

const PORT = process.env.PORT || '3000';

declare module 'express-session' {
  interface SessionData {
    mcpSessionId: string;
  }
}

const chatService = new ChatService();

async function main() {
  const defaultBinaryPath = path.join(process.cwd(), 'bin', 'pingone-mcp-server');
  
  // Create session manager with MCP configuration
  const sessionManager = new SessionManager({
    command: process.env.MCP_SERVER_COMMAND || defaultBinaryPath,
    args: ['run', '--disable-read-only'],
    env: {
      PINGONE_MCP_DEBUG: process.env.PINGONE_MCP_DEBUG,
      PINGONE_MCP_ENVIRONMENT_ID: process.env.PINGONE_ENVIRONMENT_ID,
      PINGONE_AUTHORIZATION_CODE_CLIENT_ID: process.env.PINGONE_CLIENT_ID,
      PINGONE_AUTHORIZATION_CODE_SCOPES: process.env.PINGONE_AUTHORIZATION_CODE_SCOPES || 'openid',
      PINGONE_TOP_LEVEL_DOMAIN: process.env.PINGONE_TOP_LEVEL_DOMAIN || '.com',
      PINGONE_REGION_CODE: process.env.PINGONE_REGION_CODE || 'NA',
      PINGONE_MCP_INTERACTIVE: 'true'  // Enable interactive prompting
    },
    initCapabilities: {
      tools: { list: true, call: true }
    }
  });

  const app = express();
  
  // Session middleware
  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'mcp-admin-agent-secret-change-in-production',
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 30 * 60 * 1000 // 30 minutes
    }
  });
  
  app.use(sessionMiddleware);
  app.use(express.json());
  app.use('/api', buildRouter(sessionManager));
  app.use('/', express.static(path.join(process.cwd(), 'src', 'frontend')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    // Parse session from WebSocket upgrade request
    await new Promise<void>((resolve) => {
      sessionMiddleware(req as any, {} as any, () => resolve());
    });
    
    const sessionId = (req as any).session?.id;
    if (!sessionId) {
      ws.close(1008, 'No session');
      return;
    }

    console.log(`[WS] Connection from session: ${sessionId}`);
    
    try {
      // Get or create MCP instance for this session
      const userSession = await sessionManager.getOrCreateSession(sessionId);
      sessionManager.addWebSocketConnection(sessionId, ws);
      
      // Check if MCP client is initialized
      const needsConfig = !userSession.mcpClient;
      
      // Send welcome with this session's tools (or empty if not configured)
      ws.send(JSON.stringify({ 
        type: 'welcome', 
        tools: userSession.mcpClient?.listTools() || [],
        sessionId,
        needsConfig
      }));

      ws.on('message', async raw => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        
        if (msg.type === 'configurePingOne') {
          // User providing PingOne configuration
          try {
            await sessionManager.initializeMcpClient(sessionId, {
              environmentId: msg.config.environmentId,
              clientId: msg.config.clientId,
              region: msg.config.region,
              topLevelDomain: msg.config.topLevelDomain
            });
            
            ws.send(JSON.stringify({
              type: 'configured',
              tools: userSession.mcpClient?.listTools() || []
            }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', error: (e as Error).message }));
          }
        } else if (msg.type === 'callTool') {
          try {
            if (!userSession.mcpClient) {
              ws.send(JSON.stringify({ type: 'error', error: 'PingOne not configured. Please provide configuration first.' }));
              return;
            }
            const result = await userSession.mcpClient.callTool(msg.name, msg.args || {});
            ws.send(JSON.stringify({ type: 'toolResult', name: msg.name, result }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', error: (e as Error).message }));
          }
        } else if (msg.type === 'chat') {
          // Handle chat message with streaming
          try {
            if (!userSession.mcpClient) {
              ws.send(JSON.stringify({ type: 'error', error: 'PingOne not configured. Please provide configuration first.' }));
              return;
            }
            const messages: ChatMessage[] = msg.messages || [];
            
            for await (const chunk of chatService.chat(
              messages, 
              userSession.mcpClient,
              undefined, // onToolCall
              async (promptId, params) => {
                // Prompt during chat - send to client and wait for response
                return new Promise((resolve, reject) => {
                  const timeout = setTimeout(() => {
                    reject(new Error('Prompt timeout - no client response'));
                  }, 120000);
                  
                  // Store in session's prompt resolvers
                  userSession.promptResolvers.set(promptId, { resolve, reject, timeout });
                  
                  // Send prompt to client
                  ws.send(JSON.stringify({
                    type: 'prompt',
                    id: promptId,
                    params
                  }));
                });
              }
            )) {
              if (chunk.type === 'text' && chunk.content) {
                ws.send(JSON.stringify({ 
                  type: 'chatDelta', 
                  content: chunk.content 
                }));
              } else if (chunk.type === 'tool_call') {
                ws.send(JSON.stringify({ 
                  type: 'chatToolCall', 
                  toolName: chunk.toolName,
                  toolArgs: chunk.toolArgs
                }));
              } else if (chunk.type === 'tool_result') {
                ws.send(JSON.stringify({ 
                  type: 'chatToolResult', 
                  toolName: chunk.toolName,
                  result: chunk.toolResult
                }));
              } else if (chunk.type === 'done') {
                ws.send(JSON.stringify({ type: 'chatDone' }));
              } else if (chunk.type === 'error') {
                ws.send(JSON.stringify({ type: 'error', error: chunk.error }));
              }
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', error: (e as Error).message }));
          }
        } else if (msg.type === 'promptResponse') {
          // Client is responding to a prompt request
          sessionManager.handlePromptResponse(sessionId, msg.id, msg.response);
        }
      });

      ws.on('close', () => {
        sessionManager.removeWebSocketConnection(sessionId, ws);
      });
    } catch (error) {
      console.error(`[WS] Error setting up session ${sessionId}:`, error);
      ws.close(1011, 'Internal error');
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] Received SIGTERM, cleaning up...');
    sessionManager.shutdown();
    server.close(() => {
      console.log('[SHUTDOWN] Server closed');
      process.exit(0);
    });
  });

  server.listen(parseInt(PORT, 10), () => {
    console.log(`Server listening on :${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
