Place the PingOne MCP Server binary here as 'pingone-mcp-server' before building the Docker image.

This directory is ignored by git; do NOT commit proprietary binaries.

To build:
  cp /Users/cprice/Downloads/pingone-mcp-server ./bin/pingone-mcp-server
  docker build -t your-registry/mcp-admin-agent:latest .

Checksum (optional):
  shasum -a 256 bin/pingone-mcp-server > bin/pingone-mcp-server.sha256
  shasum -a 256 -c bin/pingone-mcp-server.sha256
