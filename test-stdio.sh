#!/bin/bash
# Quick stdio test of the MCP server
# This simulates what the Node.js client does

set -e

echo "=== Testing MCP Server via stdio ==="
echo ""

# Set defaults
export PINGONE_TOP_LEVEL_DOMAIN="${PINGONE_TOP_LEVEL_DOMAIN:-.com}"
export PINGONE_REGION_CODE="${PINGONE_REGION_CODE:-NA}"
export PINGONE_AUTHORIZATION_CODE_SCOPES="${PINGONE_AUTHORIZATION_CODE_SCOPES:-openid}"

# Check session first
echo "Checking session status..."
./bin/pingone-mcp-server session
echo ""

# Send initialize request
echo "Sending initialize request..."
echo '{"jsonrpc":"2.0","id":"init-1","method":"initialize","params":{"clientInfo":{"name":"test-client","version":"1.0"},"capabilities":{"tools":{"list":true,"call":true}}}}' | \
  ./bin/pingone-mcp-server run --disable-read-only

echo ""
echo "If you see a valid JSON-RPC response above, the MCP server is working!"
echo ""
