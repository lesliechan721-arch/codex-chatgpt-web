const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, timingSafeEqual } = require("node:crypto");
const { readPolicyFile } = require("./api-access-settings.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

/** Keep the application endpoint and authentication available without an account runtime. */
async function listenAccountNotReady({ applicationHome, environment = process.env }) {
  const endpointPath = path.join(applicationHome, "service-endpoint.json");
  let port = 17841;
  let endpointExists = false;
  try {
    if (!fs.lstatSync(endpointPath).isFile()) throw new Error("Invalid service endpoint file");
    const endpoint = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
    if (endpoint.version !== 1) throw new Error("Invalid service endpoint version");
    port = endpoint.port;
    endpointExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { port = JSON.parse(fs.readFileSync(path.join(applicationHome, "config.json"), "utf8")).port; }
    catch (configError) { if (configError.code !== "ENOENT") throw configError; }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid application service port");
  const { policy } = readPolicyFile(path.join(applicationHome, "api-access.json"));
  const requestedHost = environment.CODEX_CHATGPT_WEB_BIND_HOST?.trim();
  if (requestedHost && !["127.0.0.1", "0.0.0.0"].includes(requestedHost)) throw new Error("Invalid service bind host");
  const host = requestedHost === "0.0.0.0" && policy.mode === "api-key" ? "0.0.0.0" : "127.0.0.1";
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
      response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store", "connection": "close" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_request_target", message: "Invalid request target" } }));
      request.resume();
      return;
    }
    let status = 503;
    let code = "account_not_ready";
    let message = "No account is ready. Open Launcher to select an account and complete setup.";
    if (policy.mode === "api-key" && (pathname === "/v1" || pathname.startsWith("/v1/"))) {
      const bearer = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.headers.authorization || "");
      const actual = createHash("sha256").update(bearer?.[1] || "").digest();
      if (!bearer || !timingSafeEqual(actual, Buffer.from(policy.keySha256, "hex"))) {
        status = 401; code = "invalid_api_key"; message = "A valid local API key is required";
        response.setHeader("www-authenticate", 'Bearer realm="codex-chatgpt-web"');
      } else if (!["/v1/models", "/v1/responses", "/v1/responses/compact"].includes(pathname)) {
        status = 404; code = "endpoint_not_supported"; message = "Endpoint not supported";
      }
    }
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "connection": "close" });
    response.end(JSON.stringify({ error: { type: status === 401 ? "authentication_error" : "server_error", code, message } }));
    request.resume();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  if (!endpointExists) {
    try { writePrivateFileAtomic(endpointPath, `${JSON.stringify({ version: 1, port })}\n`); }
    catch (error) { server.close(); throw error; }
  }
  return {
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

module.exports = { listenAccountNotReady };
