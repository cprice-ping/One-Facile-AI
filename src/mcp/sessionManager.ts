import { StdioMcpClient, McpClientOptions } from './stdioClient.js';
import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

interface UserSession {
  sessionId: string;
  mcpClient?: StdioMcpClient;
  wsConnections: Set<WebSocket>;
  lastActivity: number;
  promptResolvers: Map<string, {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeout: NodeJS.Timeout;
  }>;
  workDir: string;
  pingoneConfig?: {
    environmentId: string;
    clientId: string;
    region: string;
    topLevelDomain: string;
  };
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private readonly IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private readonly mcpOptions: Omit<McpClientOptions, 'onPrompt' | 'onResourceRequest'>
  ) {
    // Periodic cleanup of idle sessions
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleSessions();
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  async getOrCreateSession(sessionId: string): Promise<UserSession> {
    let session = this.sessions.get(sessionId);
    
    if (!session) {
      console.log(`[SESSION] Creating new session: ${sessionId}`);
      
      // Create session-specific working directory for credential isolation
      const sessionWorkDir = path.join(os.tmpdir(), 'mcp-sessions', sessionId);
      if (!fs.existsSync(sessionWorkDir)) {
        fs.mkdirSync(sessionWorkDir, { recursive: true });
      }
      console.log(`[SESSION ${sessionId}] Working directory: ${sessionWorkDir}`);

      session = {
        sessionId,
        mcpClient: undefined,
        wsConnections: new Set(),
        lastActivity: Date.now(),
        promptResolvers: new Map(),
        workDir: sessionWorkDir,
        pingoneConfig: undefined
      };

      this.sessions.set(sessionId, session);
    }

    session.lastActivity = Date.now();
    return session;
  }

  async initializeMcpClient(sessionId: string, config: {
    environmentId: string;
    clientId: string;
    region: string;
    topLevelDomain: string;
  }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.mcpClient) {
      console.log(`[SESSION ${sessionId}] MCP client already initialized`);
      return;
    }

    console.log(`[SESSION ${sessionId}] 🚀 Initializing MCP client with config:`, {
      environmentId: config.environmentId,
      clientId: config.clientId,
      region: config.region,
      topLevelDomain: config.topLevelDomain
    });
    session.pingoneConfig = config;

    // Create MCP client with user-provided PingOne configuration
    const mcpEnv = {
      ...this.mcpOptions.env,
      PINGONE_MCP_ENVIRONMENT_ID: config.environmentId,
      PINGONE_AUTHORIZATION_CODE_CLIENT_ID: config.clientId,
      PINGONE_REGION_CODE: config.region,
      PINGONE_TOP_LEVEL_DOMAIN: config.topLevelDomain
    };
    
    console.log(`[SESSION ${sessionId}] 📝 MCP Environment variables:`, Object.keys(mcpEnv));

    const mcpClient = new StdioMcpClient({
      ...this.mcpOptions,
      workingDirectory: session.workDir,
      env: mcpEnv,
      onPrompt: async (params) => {
        return this.handlePromptForSession(sessionId, params);
      },
      onResourceRequest: async (params) => {
        console.log(`[SESSION ${sessionId}] Resource request:`, params);
        return { contents: [] };
      }
    });

    console.log(`[SESSION ${sessionId}] 🔄 Calling MCP client.initialize()...`);
    await mcpClient.initialize();
    session.mcpClient = mcpClient;
    console.log(`[SESSION ${sessionId}] ✅ MCP client initialized successfully with ${mcpClient.listTools().length} tools`);
    
    // Now trigger the login command to establish OAuth session
    console.log(`[SESSION ${sessionId}] 🔐 Triggering login command...`);
    await this.triggerLogin(sessionId, config);
  }

  private async triggerLogin(sessionId: string, config: {
    environmentId: string;
    clientId: string;
    region: string;
    topLevelDomain: string;
  }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    return new Promise((resolve, reject) => {
      console.log(`[SESSION ${sessionId}] 🚀 Spawning login process...`);
      
      const loginProcess = spawn(this.mcpOptions.command!, ['login'], {
        cwd: session.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PINGONE_MCP_ENVIRONMENT_ID: config.environmentId,
          PINGONE_AUTHORIZATION_CODE_CLIENT_ID: config.clientId,
          PINGONE_REGION_CODE: config.region,
          PINGONE_TOP_LEVEL_DOMAIN: config.topLevelDomain,
          PINGONE_AUTHORIZATION_CODE_SCOPES: 'openid'
        }
      });

      let stdout = '';
      let stderr = '';

      loginProcess.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        console.log(`[SESSION ${sessionId}] [LOGIN] ${output.trim()}`);
      });

      loginProcess.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        console.log(`[SESSION ${sessionId}] [LOGIN STDERR] ${output.trim()}`);
      });

      loginProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`[SESSION ${sessionId}] ✅ Login completed successfully`);
          resolve();
        } else {
          console.log(`[SESSION ${sessionId}] ❌ Login failed with code ${code}`);
          console.log(`[SESSION ${sessionId}] stdout:`, stdout);
          console.log(`[SESSION ${sessionId}] stderr:`, stderr);
          // Don't reject - OAuth might have completed in browser even if process exits non-zero
          resolve();
        }
      });

      loginProcess.on('error', (err) => {
        console.error(`[SESSION ${sessionId}] ❌ Login process error:`, err);
        reject(err);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        console.log(`[SESSION ${sessionId}] ⏰ Login timeout, killing process`);
        loginProcess.kill();
        // Still resolve - user might have completed OAuth
        resolve();
      }, 5 * 60 * 1000);
    });
  }

  private async handlePromptForSession(sessionId: string, params: any): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found for prompt handling`);
    }

    console.log(`[SESSION ${sessionId}] 🔔 PROMPT REQUEST:`, JSON.stringify(params, null, 2));

    return new Promise((resolve, reject) => {
      const promptId = `${sessionId}-${Date.now()}`;
      const timeout = setTimeout(() => {
        console.log(`[SESSION ${sessionId}] ⏰ Prompt timeout: ${promptId}`);
        session.promptResolvers.delete(promptId);
        reject(new Error('Prompt timeout - no client response'));
      }, 120000); // 2 minute timeout

      session.promptResolvers.set(promptId, { resolve, reject, timeout });

      // Broadcast to all WebSocket connections for this session
      const promptMsg = JSON.stringify({
        type: 'prompt',
        id: promptId,
        params
      });

      let sentCount = 0;
      for (const ws of session.wsConnections) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            console.log(`[SESSION ${sessionId}] 📤 Sending prompt to WebSocket client`);
            ws.send(promptMsg);
            sentCount++;
          }
        } catch (e) {
          console.error(`[SESSION ${sessionId}] Failed to send prompt to client:`, e);
        }
      }

      if (sentCount === 0) {
        clearTimeout(timeout);
        session.promptResolvers.delete(promptId);
        console.log(`[SESSION ${sessionId}] ❌ No connected clients to handle prompt`);
        reject(new Error('No connected clients to handle prompt'));
      } else {
        console.log(`[SESSION ${sessionId}] ✅ Prompt sent to ${sentCount} client(s), waiting for response...`);
      }
    });
  }

  handlePromptResponse(sessionId: string, promptId: string, response: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`[SESSION] Prompt response for unknown session: ${sessionId}`);
      return;
    }

    const resolver = session.promptResolvers.get(promptId);
    if (resolver) {
      clearTimeout(resolver.timeout);
      session.promptResolvers.delete(promptId);
      console.log(`[SESSION ${sessionId}] ✅ Prompt resolved: ${promptId}`);
      console.log(`[SESSION ${sessionId}] 📥 Response:`, JSON.stringify(response, null, 2));
      resolver.resolve(response);
    } else {
      console.warn(`[SESSION ${sessionId}] ⚠️  Unknown prompt ID: ${promptId}`);
    }
  }

  addWebSocketConnection(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.wsConnections.add(ws);
      session.lastActivity = Date.now();
      console.log(`[SESSION ${sessionId}] WebSocket connected (total: ${session.wsConnections.size})`);
    }
  }

  removeWebSocketConnection(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.wsConnections.delete(ws);
      session.lastActivity = Date.now();
      console.log(`[SESSION ${sessionId}] WebSocket disconnected (remaining: ${session.wsConnections.size})`);
      
      // Don't immediately cleanup - let idle timeout handle it
      // This allows users to refresh browser without losing session
    }
  }

  private cleanupIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      const idleTime = now - session.lastActivity;
      
      // Only cleanup if idle AND no active connections
      if (idleTime > this.IDLE_TIMEOUT && session.wsConnections.size === 0) {
        console.log(`[SESSION ${sessionId}] Cleaning up idle session (idle: ${Math.round(idleTime / 60000)}min)`);
        this.destroySession(sessionId);
      }
    }
  }

  private destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Reject any pending prompts
    for (const [promptId, resolver] of session.promptResolvers.entries()) {
      clearTimeout(resolver.timeout);
      resolver.reject(new Error('Session terminated'));
    }
    session.promptResolvers.clear();

    // Close all WebSocket connections
    for (const ws of session.wsConnections) {
      try {
        ws.close(1000, 'Session terminated');
      } catch (e) {
        console.error('Error closing WebSocket:', e);
      }
    }
    session.wsConnections.clear();

    // Note: StdioMcpClient doesn't have a cleanup method yet
    // The child process will be garbage collected when the reference is removed
    
    this.sessions.delete(sessionId);
    console.log(`[SESSION ${sessionId}] Destroyed`);
  }

  shutdown(): void {
    console.log('[SESSION MANAGER] Shutting down all sessions');
    clearInterval(this.cleanupInterval);
    
    for (const sessionId of this.sessions.keys()) {
      this.destroySession(sessionId);
    }
  }

  // For REST API access
  getSessionMcpClient(sessionId: string): StdioMcpClient | undefined {
    return this.sessions.get(sessionId)?.mcpClient;
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }
}
