import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { ZodSchema, z } from 'zod';

// Basic JSON-RPC 2.0 types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: any;
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  workingDirectory?: string;
  initCapabilities?: Record<string, any>;
  onPrompt?: (params: any) => Promise<any>;
  onResourceRequest?: (params: any) => Promise<any>;
}

export class StdioMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, (res: JsonRpcResponse) => void>();
  private buffer = '';
  private tools: McpToolDefinition[] = [];
  private initialized = false;

  constructor(private readonly opts: McpClientOptions) {}

  start() {
    if (this.child) return;
    // Pre-flight existence check for clearer diagnostics
    try {
      if (!fs.existsSync(this.opts.command)) {
        throw new Error(`MCP server binary not found at path: ${this.opts.command}`);
      }
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.workingDirectory,
      env: { ...process.env, ...(this.opts.env || {}) }
    });
    this.child = child;

    child.on('error', err => {
      console.error('[MCP SPAWN ERROR]', err.message);
    });

    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.processBuffer();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      console.error('[MCP STDERR]', chunk.toString('utf8'));
    });
    child.on('exit', code => {
      console.warn(`[MCP SERVER EXIT] code=${code}`);
      this.child = undefined;
    });
  }

  private async handleServerRequest(req: JsonRpcRequest) {
    try {
      let result: any;
      
      if (req.method === 'prompts/get' && this.opts.onPrompt) {
        result = await this.opts.onPrompt(req.params);
      } else if (req.method === 'resources/read' && this.opts.onResourceRequest) {
        result = await this.opts.onResourceRequest(req.params);
      } else {
        // Method not supported
        this.sendResponse(req.id, undefined, {
          code: -32601,
          message: `Method not found: ${req.method}`
        });
        return;
      }
      
      this.sendResponse(req.id, result);
    } catch (error) {
      this.sendResponse(req.id, undefined, {
        code: -32603,
        message: (error as Error).message
      });
    }
  }

  private sendResponse(id: string, result?: any, error?: { code: number; message: string }) {
    if (!this.child) return;
    const res: JsonRpcResponse = { jsonrpc: '2.0', id, result, error };
    this.child.stdin.write(JSON.stringify(res) + '\n');
  }

  private processBuffer() {
    // Assume messages are separated by newlines (common pattern). Adjust if spec differs.
    const parts = this.buffer.split(/\n/);
    // Keep last partial line in buffer if not ending with newline
    this.buffer = parts.pop() || '';
    for (const raw of parts) {
      if (!raw.trim()) continue;
      let msg: JsonRpcResponse | JsonRpcRequest;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        console.error('Failed to parse MCP chunk:', raw);
        continue;
      }
      if ('id' in msg && ('result' in msg || 'error' in msg)) {
        const handler = this.pending.get(msg.id);
        if (handler) {
          this.pending.delete(msg.id);
          handler(msg as JsonRpcResponse);
        }
      } else if ('method' in msg && !('result' in msg || 'error' in msg)) {
        const request = msg as JsonRpcRequest;
        // Handle server-originated requests that need a response
        if ('id' in request) {
          this.handleServerRequest(request);
        } else {
          // Handle server-originated notifications
          if (request.method === 'tools/list') {
            this.tools = request.params?.tools ?? [];
          }
        }
      }
    }
  }

  private sendRequest<T = any>(method: string, params?: any, schema?: ZodSchema<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('MCP process not started'));
      const id = uuid();
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.pending.set(id, (res: JsonRpcResponse) => {
        if (res.error) {
          return reject(new Error(`${res.error.code}: ${res.error.message}`));
        }
        if (schema) {
          try {
            resolve(schema.parse(res.result));
          } catch (e) {
            reject(e);
          }
        } else {
          resolve(res.result);
        }
      });
      this.child.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  async initialize() {
    if (this.initialized) return;
    this.start();
    // Minimal handshake; adjust to server expectations
    const capabilities = {
      ...(this.opts.initCapabilities ?? {}),
      prompts: this.opts.onPrompt ? {} : undefined,
      resources: this.opts.onResourceRequest ? { subscribe: false } : undefined
    };
    await this.sendRequest('initialize', {
      clientInfo: { name: 'mcp-admin-agent', version: '0.1.0' },
      capabilities
    }).catch(err => {
      console.warn('Initialize failed:', err.message);
    });
    // Fetch tools explicitly if server supports method
    try {
      const result = await this.sendRequest('tools/list');
      this.tools = result?.tools ?? [];
    } catch (e) {
      console.warn('Tool listing failed:', (e as Error).message);
    }
    this.initialized = true;
  }

  listTools() {
    return this.tools;
  }

  async callTool(name: string, args: any) {
    return this.sendRequest('tools/call', { name, arguments: args });
  }
}
