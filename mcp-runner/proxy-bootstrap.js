/**
 * Proxy bootstrap — loaded via NODE_OPTIONS="--require /app/proxy-bootstrap.js"
 * in every spawned MCP child process.
 *
 * global-agent patches Node's http.get/request and https.get/request to route
 * through HTTP_PROXY / HTTPS_PROXY. It also patches undici's global fetch().
 */
"use strict";

const { bootstrap } = require("global-agent");

// global-agent reads GLOBAL_AGENT_HTTP_PROXY / GLOBAL_AGENT_HTTPS_PROXY,
// but also supports the standard env vars when we set this flag:
process.env.GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE = "";

bootstrap();
