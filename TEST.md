# Testing the MCP Admin Agent

## Prerequisites

You need PingOne credentials:
- **Environment ID**: The UUID of your PingOne environment
- **Client ID**: An OAuth 2.0 authorization code client configured in that environment

## Step-by-Step Testing

### 1. Set Environment Variables

```bash
export PINGONE_ENVIRONMENT_ID="your-environment-id-here"
export PINGONE_AUTHORIZATION_CODE_CLIENT_ID="your-client-id-here"

# Optional (these have defaults):
export PINGONE_REGION_CODE="NA"  # or CA, EU, AP, AU
export PINGONE_TOP_LEVEL_DOMAIN=".com"  # or .ca, .eu, .asia, .com.au
export PINGONE_AUTHORIZATION_CODE_SCOPES="openid"
```

### 2. Authenticate

Run the login command to establish a session:

```bash
./bin/pingone-mcp-server login
```

This will:
- Open your browser for authentication
- Store the session credentials locally
- Display session expiry information

Alternatively, use the setup script:

```bash
chmod +x test-setup.sh
./test-setup.sh
```

### 3. Verify Session

Check that your session is active:

```bash
./bin/pingone-mcp-server session
```

You should see:
- Session ID
- Expiry timestamp
- Token Status: `Valid`

### 4. Test the MCP Server Directly (Optional)

Quick stdio test to verify the server responds:

```bash
chmod +x test-stdio.sh
./test-stdio.sh
```

This sends a JSON-RPC `initialize` request and shows the response.

### 5. Start the Web Client

```bash
npm run dev
```

The server will:
- Spawn the MCP server as a child process
- Initialize the connection
- List available tools
- Start Express on port 8080

### 6. Test via Browser

Open http://localhost:8080 in your browser.

You should see:
- List of available PingOne tools
- A form to call tools with JSON arguments

### 7. Test via REST API

```bash
# List tools
curl http://localhost:8080/api/tools | jq

# Call a tool (example: list environments)
curl -X POST http://localhost:8080/api/tools/list-pingone-environments/call \
  -H "Content-Type: application/json" \
  -d '{}' | jq
```

### 8. Test via WebSocket

Use the browser console or a WebSocket client:

```javascript
const ws = new WebSocket('ws://localhost:8080/ws');

ws.onmessage = (event) => {
  console.log('Received:', JSON.parse(event.data));
};

// Call a tool
ws.send(JSON.stringify({
  type: 'callTool',
  name: 'list-pingone-environments',
  args: {}
}));
```

## Troubleshooting

### Session Expired

If you see `Token Status: Expired` or warnings about expired sessions:

```bash
./bin/pingone-mcp-server login
```

### Missing Environment Variables

The MCP server needs environment configuration. The web client passes these from the shell environment where `npm run dev` was started:

```bash
# Make sure these are exported before starting npm run dev
export PINGONE_ENVIRONMENT_ID="..."
export PINGONE_AUTHORIZATION_CODE_CLIENT_ID="..."
```

### MCP Server Not Found

If the server fails to start with "binary not found":

1. Verify the binary exists:
   ```bash
   ls -l bin/pingone-mcp-server
   ```

2. Make it executable:
   ```bash
   chmod +x bin/pingone-mcp-server
   ```

### Port Already in Use

Change the port:

```bash
PORT=3000 npm run dev
```

## Session Lifecycle

- **Login**: User authenticates via browser OAuth flow
- **Session Storage**: Credentials stored in local filesystem (outside this repo)
- **Expiry**: Tokens expire after ~2 hours
- **Refresh**: Re-run `login` command when expired
- **Logout**: `./bin/pingone-mcp-server logout` to clear session

## Next Steps

Once authenticated and the server is running:

1. Explore available tools via `/api/tools`
2. Test tool calls via WebSocket for interactive results
3. Build UI features on top of the WebSocket protocol
4. Add authentication/authorization to the web client itself
