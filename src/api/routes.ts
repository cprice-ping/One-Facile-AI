import express from 'express';
import { SessionManager } from '../mcp/sessionManager.js';
import { ChatService, ChatMessage } from '../ai/chatService.js';

const chatService = new ChatService();

export function buildRouter(sessionManager: SessionManager) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/tools', async (req, res) => {
    const sessionId = req.session?.id;
    if (!sessionId) {
      return res.status(401).json({ error: 'No session' });
    }

    try {
      const userSession = await sessionManager.getOrCreateSession(sessionId);
      res.json({ tools: userSession.mcpClient.listTools() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post('/tools/:name/call', async (req, res) => {
    const sessionId = req.session?.id;
    if (!sessionId) {
      return res.status(401).json({ error: 'No session' });
    }

    const name = req.params.name;
    const args = req.body || {};
    
    try {
      const userSession = await sessionManager.getOrCreateSession(sessionId);
      sessionManager.touchSession(sessionId); // Update activity timestamp
      const result = await userSession.mcpClient.callTool(name, args);
      res.json({ result });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post('/chat', async (req, res) => {
    const sessionId = req.session?.id;
    if (!sessionId) {
      return res.status(401).json({ error: 'No session' });
    }

    const messages: ChatMessage[] = req.body.messages || [];
    
    try {
      const userSession = await sessionManager.getOrCreateSession(sessionId);
      sessionManager.touchSession(sessionId);
      
      const result = await chatService.chatCompletion(messages, userSession.mcpClient);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
