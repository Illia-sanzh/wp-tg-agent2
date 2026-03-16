import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HTTPS_PROXY, AGENT_AUTH_TOKEN } from "./config";

export const agentAxios = axios.create({
  proxy: false,
  ...(AGENT_AUTH_TOKEN ? { headers: { Authorization: `Bearer ${AGENT_AUTH_TOKEN}` } } : {}),
});

export const externalAxios = axios.create({
  proxy: false,
  ...(HTTPS_PROXY ? { httpsAgent: new HttpsProxyAgent(HTTPS_PROXY) } : {}),
});
