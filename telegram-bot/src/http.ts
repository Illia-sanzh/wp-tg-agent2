import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HTTPS_PROXY } from "./config";

export const agentAxios = axios.create({ proxy: false });

export const externalAxios = axios.create({
  proxy: false,
  ...(HTTPS_PROXY ? { httpsAgent: new HttpsProxyAgent(HTTPS_PROXY) } : {}),
});
