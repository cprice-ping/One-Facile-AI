#!/bin/bash
# Test setup script for MCP Admin Agent
# This script helps you authenticate with PingOne and test the client

set -e

echo "=== MCP Admin Agent Test Setup ==="
echo ""

# Check if environment variables are set
if [ -z "$PINGONE_ENVIRONMENT_ID" ]; then
  echo "❌ PINGONE_ENVIRONMENT_ID not set"
  echo "   Set it with: export PINGONE_ENVIRONMENT_ID=<your-env-id>"
  exit 1
fi

if [ -z "$PINGONE_AUTHORIZATION_CODE_CLIENT_ID" ]; then
  echo "❌ PINGONE_AUTHORIZATION_CODE_CLIENT_ID not set"
  echo "   Set it with: export PINGONE_AUTHORIZATION_CODE_CLIENT_ID=<your-client-id>"
  exit 1
fi

# Set defaults for optional vars
export PINGONE_TOP_LEVEL_DOMAIN="${PINGONE_TOP_LEVEL_DOMAIN:-.com}"
export PINGONE_REGION_CODE="${PINGONE_REGION_CODE:-NA}"
export PINGONE_AUTHORIZATION_CODE_SCOPES="${PINGONE_AUTHORIZATION_CODE_SCOPES:-openid}"

echo "✅ Configuration:"
echo "   Environment ID: $PINGONE_ENVIRONMENT_ID"
echo "   Client ID: $PINGONE_AUTHORIZATION_CODE_CLIENT_ID"
echo "   Region: $PINGONE_REGION_CODE"
echo "   Top Level Domain: $PINGONE_TOP_LEVEL_DOMAIN"
echo ""

# Step 1: Login
echo "Step 1: Authenticating with PingOne..."
./bin/pingone-mcp-server login
echo ""

# Step 2: Check session
echo "Step 2: Verifying session..."
./bin/pingone-mcp-server session
echo ""

echo "✅ Authentication complete!"
echo ""
echo "You can now test the client in one of two ways:"
echo ""
echo "Option A - Start the dev server:"
echo "  npm run dev"
echo ""
echo "Option B - Run a quick stdio test:"
echo "  ./test-stdio.sh"
echo ""
