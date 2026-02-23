FROM node:20-alpine

# tini as PID 1 for correct signal propagation when killing child MCP processes
RUN apk add --no-cache tini

WORKDIR /app

# Install only the HTTP wrapper's dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY mcp-runner.js ./

# MCP packages install here (Docker named volume mounted at runtime)
RUN mkdir -p /mcps

EXPOSE 9000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "mcp-runner.js"]
