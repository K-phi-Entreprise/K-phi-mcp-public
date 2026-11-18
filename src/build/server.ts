/**
 * K-φ Capture: the second public MCP server of this repository, beside the
 * ledger analysis server (src/server.ts). Streamable HTTP, stateless.
 *
 *   POST /mcp      the MCP endpoint
 *   GET  /healthz
 *
 * It refuses to start without the engine's address and the shared secret: a
 * capture server that cannot reach the engine has nothing to offer, and saying
 * so at boot beats eight tools that all fail.
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { contextMiddleware, type RequestContext } from "../ratelimit.js";
import { HttpCaptureEngine } from "./engine.js";
import { INSTRUCTIONS, registerCaptureTools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3001);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://k-phi.com";
const KPHI_ENGINE_URL = process.env.KPHI_ENGINE_URL;
const KPHI_BUILD_SECRET = process.env.KPHI_BUILD_SECRET;
if (!(KPHI_ENGINE_URL && KPHI_BUILD_SECRET)) {
  console.error("FATAL: KPHI_ENGINE_URL and KPHI_BUILD_SECRET must both be set (the same secret as on the engine).");
  process.exit(1);
}
const engine = new HttpCaptureEngine({ baseUrl: KPHI_ENGINE_URL, secret: KPHI_BUILD_SECRET });
console.log("engine: K-Phi @ " + KPHI_ENGINE_URL);

const ICON_PNG = (() => {
  try { return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "icon-192.png")); }
  catch { return undefined; }
})();
const ICON_DATA_URI = ICON_PNG ? "data:image/png;base64," + ICON_PNG.toString("base64") : undefined;

const app = express();
app.set("trust proxy", true);
app.use(contextMiddleware);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, server: "capture", commit: (process.env.RENDER_GIT_COMMIT ?? "dev").slice(0, 9), deployed_at: process.env.RENDER_DEPLOY_TIME ?? null });
});
app.get(["/favicon.ico", "/icon.png"], (_req, res) => {
  if (!ICON_PNG) { res.status(404).end(); return; }
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(ICON_PNG);
});

app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
  const ctx = res.locals.ctx as RequestContext;
  const server = new McpServer({
    name: "k-phi-capture", version: "0.1.0", title: "K-Phi Capture: how your finance team works, scoped and planned",
    websiteUrl: PUBLIC_BASE_URL,
    ...(ICON_DATA_URI ? { icons: [{ src: ICON_DATA_URI, mimeType: "image/png", sizes: ["192x192"] }] } : {}),
  }, { instructions: INSTRUCTIONS });
  registerCaptureTools(server, { engine, ip: () => ctx.ip });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP error", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.all("/mcp", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

app.listen(PORT, () => console.log("K-Phi Capture MCP listening on :" + PORT));
