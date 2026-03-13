import OpenAI from "openai";
import axios, { AxiosRequestConfig } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { LITELLM_BASE_URL, LITELLM_MASTER_KEY, OPENAI_API_KEY, HTTPS_PROXY } from "./config";

export function getAgent(url: string): HttpsProxyAgent<string> | undefined {
  const proxy = getProxyForUrl(url);
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

export async function httpRequest(config: AxiosRequestConfig): Promise<any> {
  const url = String(config.url ?? "");
  const agent = getAgent(url);
  return axios.request({
    ...config,
    proxy: false,
    httpsAgent: agent,
    httpAgent: agent,
  });
}

export const client = new OpenAI({
  apiKey: LITELLM_MASTER_KEY,
  baseURL: LITELLM_BASE_URL,
  timeout: 300_000,
  maxRetries: 0,
});

export let whisperClient: OpenAI | null = null;
if (OPENAI_API_KEY) {
  const proxyAgent = HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined;
  whisperClient = new OpenAI({
    apiKey: OPENAI_API_KEY,
    timeout: 90_000,
    maxRetries: 0,
    // @ts-ignore — httpAgent is a valid undocumented option for node-fetch transport
    httpAgent: proxyAgent,
  });
}
