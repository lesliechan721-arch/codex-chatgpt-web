const http = require("node:http");
const https = require("node:https");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const modelMetadata = require("./codex-model-metadata.cjs");

const MAX_MODELS_BYTES = 4 * 1024 * 1024;

function proxyUrlFromPac(value) {
  if (typeof value !== "string") throw new Error("upstream-fetch-failed");
  const first = value.split(";")[0]?.trim();
  if (first === "DIRECT") return null;
  const match = /^(PROXY|HTTPS) ([^\s/;]+)$/.exec(first || "");
  if (!match) throw new Error("upstream-fetch-failed");
  return `${match[1] === "HTTPS" ? "https" : "http"}://${match[2]}`;
}

function agentFor(target, proxyUrl) {
  if (!proxyUrl) return undefined;
  return target.protocol === "https:" ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
}

async function requestModels(target, apiKey, proxyUrl) {
  return await new Promise((resolve, reject) => {
    const agent = agentFor(target, proxyUrl);
    const request = (target.protocol === "https:" ? https : http).request(target, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "accept-encoding": "identity",
      },
      ...(agent ? { agent } : {}),
      signal: AbortSignal.timeout(15_000),
    }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error("upstream-fetch-failed"));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_MODELS_BYTES) {
          request.destroy(new Error("upstream-fetch-failed"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.once("error", () => reject(new Error("upstream-fetch-failed")));
    request.end();
  });
}

function extractModelIds(value) {
  try { return modelMetadata.parseUpstreamDiscovery(value).ids; }
  catch { throw new Error("upstream-fetch-failed"); }
}

async function fetchUpstreamModelCatalog({ baseUrl, apiKey, proxy, resolveProxy, globalProxyUrl }) {
  const target = new URL("models", baseUrl);
  let proxyUrl = null;
  if (proxy.mode === "custom") proxyUrl = proxy.url;
  else if (proxy.mode === "global" && globalProxyUrl) proxyUrl = globalProxyUrl;
  else if (proxy.mode === "global" && typeof resolveProxy === "function") {
    try { proxyUrl = proxyUrlFromPac(await resolveProxy(target.href)); }
    catch { throw new Error("upstream-fetch-failed"); }
  }
  let text;
  try { text = await requestModels(target, apiKey, proxyUrl); }
  catch { throw new Error("upstream-fetch-failed"); }
  try {
    const raw = JSON.parse(text);
    const discovery = modelMetadata.parseUpstreamDiscovery(raw);
    return { raw, discovery };
  }
  catch { throw new Error("upstream-fetch-failed"); }
}

async function fetchUpstreamModelIds(input) {
  return (await fetchUpstreamModelCatalog(input)).discovery.ids;
}

module.exports = { extractModelIds, fetchUpstreamModelCatalog, fetchUpstreamModelIds, proxyUrlFromPac };
