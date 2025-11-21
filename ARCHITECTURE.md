# Architecture Documentation

## Overview

The MCP Admin Agent is a multi-user web application that provides session-isolated access to the PingOne MCP Server. It enables multiple Sales Engineers to simultaneously build PingOne demos using their own credentials without interfering with each other.

## Authentication Architecture

### Two-Layer Authentication Model

The system uses **two distinct authentication layers** that serve different purposes:

#### Layer 1: Agent Access Control (Session-based)
**Purpose**: Identify and isolate users within the web application

- **Technology**: Express session middleware with signed cookies
- **Credentials**: None required - automatic session assignment
- **Scope**: Access to the web interface and session-isolated resources
- **Lifecycle**: 30 minutes of inactivity
- **Storage**: In-memory (can be replaced with Redis for multi-pod deployments)

#### Layer 2: PingOne API Access (OAuth/OIDC via MCP Server)
**Purpose**: Authenticate each user against their PingOne environment

- **Technology**: OAuth 2.0 Authorization Code flow (handled by MCP server)
- **Credentials**: User-provided PingOne environment ID, client ID, and user login
- **Scope**: PingOne API access for that specific environment
- **Lifecycle**: Managed by MCP server (token refresh, expiry)
- **Storage**: MCP server's local credential storage

### Critical Design Decision: Why No Client Credentials for the Agent?

The Agent **intentionally does not** use PingOne client credentials (client_credentials grant) because:

1. **It doesn't call PingOne APIs directly**
   - The Agent is a proxy/router, not an API client
   - All PingOne API calls are made by the MCP server subprocesses
   - The Agent only routes messages between browsers and MCP servers

2. **User-level isolation is required**
   - Each Sales Engineer manages their own PingOne environment
   - Client credentials would provide a single service account's access
   - User credentials ensure proper audit trails and permissions

3. **Security principle: Least privilege**
   - The Agent has no access to PingOne data
   - Compromise of the Agent does not expose PingOne credentials
   - Each MCP server instance runs with minimal privileges (user's own)

4. **Demo/training use case**
   - Sales Engineers use their own demo environments
   - No shared service account or credentials needed
   - Each SE controls their own authentication lifecycle

## Component Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Sales Engineer (Browser)                │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ HTTP Session │  │ OAuth Prompt │  │  Tool Calls  │      │
│  │   Cookie     │  │    Modal     │  │   WebSocket  │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
└─────────┼──────────────────┼──────────────────┼──────────────┘
          │                  │                  │
          │                  │                  │
┌─────────┼──────────────────┼──────────────────┼──────────────┐
│         ▼                  │                  ▼              │
│  ┌─────────────┐           │           ┌─────────────┐      │
│  │  Express    │           │           │  WebSocket  │      │
│  │  Session    │           │           │   Server    │      │
│  │ Middleware  │           │           │   (/ws)     │      │
│  └──────┬──────┘           │           └──────┬──────┘      │
│         │                  │                  │              │
│         │   MCP Admin Agent (Node.js)        │              │
│         │                  │                  │              │
│         ▼                  │                  ▼              │
│  ┌─────────────────────────┴──────────────────────────┐     │
│  │            SessionManager                          │     │
│  │  ┌──────────────────────────────────────────────┐  │     │
│  │  │  Map<SessionID, UserSession>                 │  │     │
│  │  │    - session-abc: UserSession {              │  │     │
│  │  │        mcpClient: StdioMcpClient #1          │  │     │
│  │  │        wsConnections: Set<WebSocket>         │  │     │
│  │  │        promptResolvers: Map                  │  │     │
│  │  │      }                                        │  │     │
│  │  │    - session-def: UserSession {              │  │     │
│  │  │        mcpClient: StdioMcpClient #2          │  │     │
│  │  │        ...                                    │  │     │
│  │  │      }                                        │  │     │
│  │  └──────────────────────────────────────────────┘  │     │
│  └──────────────┬──────────────────┬──────────────────┘     │
└─────────────────┼──────────────────┼────────────────────────┘
                  │                  │
       ┌──────────▼──────┐  ┌────────▼─────────┐
       │ MCP Server #1   │  │  MCP Server #2   │
       │  (Child Proc)   │  │   (Child Proc)   │
       │                 │  │                  │
       │  User A's       │  │  User B's        │
       │  Credentials    │  │  Credentials     │
       └────────┬────────┘  └────────┬─────────┘
                │                    │
                │ OAuth Token A      │ OAuth Token B
                ▼                    ▼
       ┌────────────────────────────────────┐
       │      PingOne API                   │
       │  (Environment A)  (Environment B)  │
       └────────────────────────────────────┘
```

## Request Flow Examples

### Scenario 1: First Connection

1. **User opens browser** → `http://agent-url/`
2. **Express creates session** → Sets cookie `connect.sid=abc123`
3. **Browser loads UI** → Connects WebSocket with session cookie
4. **SessionManager** → Creates new `UserSession` for `session-abc123`
5. **Spawns MCP server** → Child process starts, unauthenticated
6. **MCP initializes** → Lists available tools (no auth needed yet)
7. **Browser receives** → `{ type: 'welcome', tools: [...], sessionId: 'abc123' }`

### Scenario 2: First Tool Call (Requires Auth)

1. **User clicks tool** → `{ type: 'callTool', name: 'list-users', args: {} }`
2. **SessionManager routes** → To MCP server instance for `session-abc123`
3. **MCP server detects** → No auth token available
4. **MCP sends prompt** → `prompts/get` request via stdio
5. **SessionManager receives** → Routes to user's WebSocket connections
6. **Browser displays** → OAuth modal with fields for credentials
7. **User enters** → Environment ID, Client ID, username, password
8. **Browser sends** → `{ type: 'promptResponse', id: 'prompt-123', response: {...} }`
9. **SessionManager resolves** → Promise from step 4 with user's response
10. **MCP server uses** → Credentials to complete OAuth flow
11. **MCP opens browser** → OAuth consent page (if needed)
12. **User approves** → OAuth callback completes
13. **MCP stores token** → In its local credential cache
14. **MCP executes tool** → With authenticated API call
15. **Result returned** → `{ type: 'toolResult', name: 'list-users', result: [...] }`

### Scenario 3: Subsequent Tool Calls

1. **User calls another tool** → `{ type: 'callTool', name: 'create-user', args: {...} }`
2. **SessionManager routes** → To same MCP server instance
3. **MCP uses cached token** → No prompt needed
4. **API call succeeds** → Result returned immediately
5. **If token expired** → MCP may prompt for re-auth (back to Scenario 2)

### Scenario 4: Multiple Users Simultaneously

```
Time  SE-1 (session-A)           SE-2 (session-B)
────  ────────────────────────   ────────────────────────
T0    Connects → MCP #1 spawned  
T1    Auth prompt → enters creds
T2                                Connects → MCP #2 spawned
T3    OAuth flow completes        
T4    list-users succeeds         Auth prompt → enters creds
T5    create-user succeeds        OAuth flow completes
T6                                list-groups succeeds
T7    Both users working in parallel with isolated MCP servers
```

## Session Lifecycle Management

### Creation
- Triggered on first WebSocket connection or REST API call with a new session ID
- SessionManager spawns dedicated MCP server subprocess
- MCP server initializes but remains unauthenticated until needed

### Activity Tracking
- Every WebSocket message updates `lastActivity` timestamp
- Every REST API call updates `lastActivity` timestamp
- Browser refresh/reconnect within timeout maintains session

### Cleanup Triggers
1. **Idle timeout** (30 minutes):
   - No active WebSocket connections AND
   - No activity for 30+ minutes
   - Checked every 5 minutes by cleanup interval

2. **Graceful shutdown** (SIGTERM):
   - All sessions destroyed immediately
   - All MCP server subprocesses terminated
   - All WebSocket connections closed with code 1000

3. **Manual cleanup** (future enhancement):
   - Could add admin API to force-terminate sessions
   - Could add user logout button

### Resource Cleanup Sequence
1. Reject all pending prompt promises
2. Close all WebSocket connections for that session
3. Clear prompt resolver map
4. Remove session from SessionManager map
5. MCP server subprocess garbage collected (process dies when references cleared)

## Security Considerations

### What This Architecture Protects Against

✅ **Session hijacking** - HttpOnly cookies prevent XSS access  
✅ **Credential sharing** - Each user authenticates independently  
✅ **Cross-user contamination** - Complete process isolation per session  
✅ **Agent compromise** - Agent has no PingOne credentials to leak  
✅ **Unauthorized API access** - MCP server enforces auth before tool execution  

### What This Architecture Does NOT Protect Against

❌ **Unauthenticated Agent access** - Anyone can connect and get a session  
❌ **Resource exhaustion** - No limit on concurrent sessions (yet)  
❌ **Network eavesdropping** - Use HTTPS in production  
❌ **DDoS** - No rate limiting implemented  

### Production Hardening Recommendations

1. **Add Agent-level authentication**
   - SSO/SAML before reaching the Agent
   - API tokens for programmatic access
   - IP allowlisting for corporate networks

2. **Rate limiting**
   - Limit sessions per IP
   - Limit tool calls per session
   - Limit WebSocket connections per session

3. **Resource limits**
   - Max concurrent MCP server instances
   - CPU/memory limits per subprocess
   - Timeout for long-running tool calls

4. **Audit logging**
   - Log all tool invocations with session ID
   - Log authentication events
   - Export to SIEM for analysis

5. **Secure session storage**
   - Use Redis for multi-pod deployments
   - Enable session encryption
   - Set secure=true for cookies (HTTPS only)

## Scaling Considerations

### Current Architecture: Single-Node
- In-memory session storage
- MCP servers as child processes on same host
- Works for: Development, small teams, single-pod K8s deployment

### Multi-Node Scaling (Future)
Would require:
1. **Shared session store** (Redis, Memcached)
2. **Sticky sessions** or session affinity at load balancer
3. **Shared filesystem** for MCP server credential storage (or per-pod isolation)
4. **Health checks** that consider session count
5. **Graceful draining** on pod termination

### Alternative: Serverless per Session
Could containerize each MCP server separately:
- One pod per user session
- Agent becomes pure router (no child processes)
- Better isolation, higher overhead
- Better for long-running demo environments

## Troubleshooting Guide

### "No session" error on WebSocket
- **Cause**: Cookie not sent with WebSocket upgrade request
- **Fix**: Ensure same-origin policy, check browser console for cookie issues

### "Session not found for prompt handling"
- **Cause**: Session cleaned up while prompt was in flight
- **Fix**: Increase idle timeout or improve reconnect logic

### Multiple prompts for same auth
- **Cause**: MCP server loses token or token expires
- **Fix**: Check MCP server credential storage, may need to configure longer token lifetimes in PingOne

### Tools not appearing in list
- **Cause**: MCP server failed to initialize
- **Fix**: Check MCP server logs (stderr), verify binary path and permissions

## Future Enhancements

### Short-term
- [ ] Admin dashboard to view active sessions
- [ ] Session persistence across server restarts (Redis)
- [ ] Configurable idle timeout per deployment
- [ ] Health endpoint with session metrics

### Medium-term
- [ ] Multi-pod deployment support with Redis session store
- [ ] Rate limiting per session/IP
- [ ] Audit log export (JSON, Splunk, etc.)
- [ ] Session replay/debugging tools

### Long-term
- [ ] AI-assisted demo building (use MCP tools as AI agent tools)
- [ ] Pre-configured demo templates
- [ ] Collaboration features (shared sessions for training)
- [ ] Integration with PingOne SSO for Agent authentication
