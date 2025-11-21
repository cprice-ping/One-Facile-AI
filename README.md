# MCP Admin Agent

A multi-user Model Context Protocol (MCP) web client that provides session-isolated PingOne MCP Server instances for Sales Engineers to build PingOne demos. Each user gets their own isolated MCP server instance with independent authentication and state management.

## Features
- **Per-user session isolation** - Each Sales Engineer gets a dedicated MCP server instance
- **Cookie-based sessions** - Automatic session management via `express-session`
- **Interactive OAuth flow** - MCP server handles PingOne authentication via browser prompts
- **Multiple interfaces** - REST API, WebSocket, and browser UI
- **Auto-cleanup** - Idle sessions cleaned up after 30 minutes of inactivity
- **Graceful shutdown** - Proper resource cleanup on termination
- **No build step** - Simple HTML/JS single-page interface served from `/`
- **Containerized** - Docker image with embedded MCP server binary; K8s-ready

## Architecture

### Authentication Flow
The Agent uses a **two-layer authentication model**:

1. **Agent Access** (Session-based)
   - Users receive a session cookie when connecting to the web interface
   - Session ID determines which MCP server instance to use
   - No PingOne credentials required at this layer
   - Sessions expire after 30 minutes of inactivity

2. **PingOne API Access** (Person-based via MCP Server)
   - Each MCP server instance authenticates independently
   - Authentication handled by the MCP server via interactive OAuth prompts
   - User (Sales Engineer) enters PingOne credentials in browser modal
   - MCP server completes OAuth/OIDC flow and manages tokens
   - Each user's MCP server uses their PingOne credentials

**Important**: The Agent itself does **not** authenticate to PingOne. It acts as a proxy/router that:
- Manages session-isolated MCP server instances
- Routes tool calls to the correct user's MCP server
- Forwards OAuth prompts from MCP servers to browser clients
- Has no direct access to PingOne APIs

```
Sales Engineer ──> Agent (Web App) ──> MCP Server ──> PingOne APIs
                   [Session Cookie]    [User's OAuth]  [User's Token]
                   
Multiple SEs:
SE-1 [session-A] ──> MCP Instance #1 ──> PingOne Env #1
SE-2 [session-B] ──> MCP Instance #2 ──> PingOne Env #2
SE-3 [session-C] ──> MCP Instance #3 ──> PingOne Env #3
```

### Session Isolation
- Each session ID maps to a dedicated MCP server subprocess
- Sessions are created on first connection (WebSocket or REST API)
- Multiple browser tabs from same user share one session
- MCP servers auto-cleanup when session is idle for 30+ minutes with no active connections
- Browser refresh preserves session (reconnects to existing MCP instance)

## Requirements
- Node.js 20+
- The `pingone-mcp-server` binary accessible in container (image layer, mounted volume, or secret).
- **No PingOne credentials required to start the Agent**
- Sales Engineers provide their own PingOne credentials when prompted during first tool use

## Environment Variables

### Agent Configuration
```
PORT=8080                                    # HTTP server port
SESSION_SECRET=change-me-in-production       # Session signing secret (generate random string)
NODE_ENV=production                          # Set to 'production' for secure cookies
OPENAI_API_KEY=sk-...                        # OpenAI API key for chat agent
OPENAI_MODEL=gpt-4o                          # OpenAI model (default: gpt-4o)
```

### MCP Server Configuration (Optional)
These are **optional** and can be provided by Sales Engineers during the OAuth prompt instead:
```
MCP_SERVER_COMMAND=/opt/pingone/pingone-mcp-server  # Path to MCP server binary
PINGONE_MCP_ENVIRONMENT_ID=<env_id>                  # Optional: Pre-configure environment
PINGONE_CLIENT_ID=<worker_app_client_id>             # Optional: Pre-configure client
PINGONE_TOP_LEVEL_DOMAIN=.com                        # Default: .com (or .ca, .eu, .asia, .com.au)
PINGONE_REGION_CODE=NA                               # Default: NA (or CA, EU, AP, AU)
PINGONE_AUTHORIZATION_CODE_SCOPES=openid             # Default: openid
```

**Note**: If `PINGONE_MCP_ENVIRONMENT_ID` and `PINGONE_CLIENT_ID` are not set, the MCP server will prompt users for these values during authentication.

## Local Development
```bash
npm install
npm run dev
# Visit http://localhost:3000
```

On first connection, you'll be prompted to configure your PingOne connection:
1. **Environment ID** - The UUID of your PingOne environment
2. **Client ID** - The OAuth client ID configured in that environment (authorization code flow)
3. **Region Code** - Your PingOne region (NA, EU, CA, AP, AU, SG)
4. **Top Level Domain** - Your PingOne TLD (.com, .eu, .ca, .asia, .com.au)

After providing these details, the MCP server will handle OAuth authentication automatically when you use tools. A browser window will open for you to complete the login flow.

Each browser session gets its own isolated MCP server instance with independent authentication.

## REST API

All REST endpoints require a valid session cookie (automatically set on first request).

- `GET /api/health` – health check (no session required)
- `GET /api/tools` – list discovered tools for your session's MCP instance
- `POST /api/tools/<name>/call` – invoke tool (JSON body as arguments) using your session's MCP instance

Each session gets its own isolated set of tools and state.

## WebSocket Protocol (`/ws`)

WebSocket connections are automatically associated with your HTTP session cookie.

Messages from server:
```json
{ "type": "welcome", "tools": [ { "name": "..." } ], "sessionId": "abc123" }
{ "type": "toolResult", "name": "toolName", "result": {...} }
{ "type": "error", "error": "message" }
{ "type": "prompt", "id": "promptId", "params": { "name": "...", "arguments": [...] } }
```
Messages to server:
```json
{ "type": "callTool", "name": "toolName", "args": {"key": "value"} }
{ "type": "promptResponse", "id": "promptId", "response": {...} }
```

**Prompt Handling**: When the MCP server needs user input (e.g., PingOne credentials, OAuth consent), it sends a `prompt` message. The browser UI displays a modal dialog, and user responses are sent back via `promptResponse`.

## Kubernetes Deployment

### Security Considerations
- **No PingOne credentials in secrets**: The Agent does not require PingOne credentials to run
- **User-provided auth**: Each Sales Engineer authenticates with their own PingOne credentials
- **Session secret**: Generate a strong random string for `SESSION_SECRET`
- **Network isolation**: Consider restricting access via ingress/network policies
- **Optional**: Add additional authentication layer (SSO, basic auth) before the Agent if needed

### Image-Layer Binary Embedding
Place the PingOne MCP server binary at `bin/pingone-mcp-server` before building. The Dockerfile copies it into `/opt/pingone/pingone-mcp-server` and sets `MCP_SERVER_COMMAND` accordingly.

```bash
cp /Users/cprice/Downloads/pingone-mcp-server bin/pingone-mcp-server
shasum -a 256 bin/pingone-mcp-server > bin/pingone-mcp-server.sha256  # optional integrity record
shasum -a 256 -c bin/pingone-mcp-server.sha256
```

1. Build & push image:
```bash
docker build -t your-registry/mcp-admin-agent:latest .
docker push your-registry/mcp-admin-agent:latest
```
2. Create secrets (edit `k8s/secret-example.yaml` then apply) – **Optional: only needed if pre-configuring environment**:
```bash
# Required: OpenAI API key for chat agent
kubectl create secret generic openai-api \
  --from-literal=apiKey=sk-your-openai-key-here

# Required: Session secret for cookie signing
kubectl create secret generic mcp-agent-session \
  --from-literal=SESSION_SECRET=$(openssl rand -base64 32)

# Optional: Pre-configure PingOne environment for all users
kubectl create secret generic pingone-admin \
  --from-literal=environmentId=your-env-id \
  --from-literal=clientId=your-client-id
```
3. Deploy:
```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```
4. Access via ingress or `kubectl port-forward svc/mcp-admin-agent 8080:80`.

## Adjustments & Next Steps
- **Multi-tenancy** ✅ Implemented - Each user gets isolated MCP server instance
- **Session management** ✅ Implemented - Cookie-based sessions with auto-cleanup
- **Prompt routing** ✅ Implemented - OAuth prompts routed to correct user
- Add authentication layer to the Agent itself (SSO, basic auth) if exposing publicly
- Implement streaming partial results if MCP server supports incremental output
- Harden: connection limits per session, rate limiting
- Persist audit log of tool calls per user/session
- Add session storage backend (Redis) for multi-pod deployments
- Monitor resource usage per MCP instance

## Use Case: Sales Engineer Demo Builder

This Agent is designed for Sales Engineers to:
1. Access the web interface (gets automatic session)
2. Authenticate with their PingOne environment credentials (via OAuth prompt)
3. Use PingOne MCP tools to build/configure demo environments
4. Work independently without interfering with other SEs
5. Session persists across browser tabs/refreshes for seamless workflow

Each SE can:
- Manage their own PingOne tenant
- Create users, apps, policies for demos
- Work in parallel with other SEs
- Walk away and resume later (within session timeout)

## Disclaimer
This is a reference implementation for multi-user MCP client scenarios. Key architectural decisions:

- **No Agent-level PingOne authentication**: The Agent does not use client credentials or authenticate to PingOne. All PingOne API access is performed by session-isolated MCP servers using individual user credentials.
- **Session-based isolation**: Each user session spawns a dedicated MCP server subprocess, ensuring complete isolation of state and credentials.
- **User authentication via MCP**: PingOne authentication is handled by the MCP server through interactive OAuth prompts, not by the Agent.
- **Production readiness**: Add appropriate authentication/authorization layer before the Agent if deploying to shared/public environments.

Adapt message framing if the PingOne MCP server expects different JSON-RPC packaging. Enhance schema validation with `zod` per tool input definitions when available.
