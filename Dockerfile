# Multi-stage build
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

# Final runtime image with embedded MCP server binary.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts and dependencies
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist/frontend ./dist/frontend

# Copy PingOne MCP Server binary (must be placed at build context bin/pingone-mcp-server before build)
COPY bin/pingone-mcp-server /opt/pingone/pingone-mcp-server
RUN chmod +x /opt/pingone/pingone-mcp-server

ENV MCP_SERVER_COMMAND=/opt/pingone/pingone-mcp-server \
	PINGONE_AUTHORIZATION_CODE_SCOPES=openid

EXPOSE 3000
CMD ["node", "dist/server.js"]
