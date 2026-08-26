import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "smoke", version: "0.0.1" });
await c.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp")));
const r = await c.callTool({ name: "kphi_analyze_ledger", arguments: { content: "Date,Account,AccountName,Debit,Credit\n2025-01-05,10100,Cash,10.00,0.00\n2025-01-05,40000,Sales,0.00,10.00\n" } });
const id = r.structuredContent.analysis_id;
const page = await (await fetch("http://localhost:3000/a/" + id)).text();
console.log("[dashboard]", page.includes("K-Φ — Analyse") ? "rendu ✓" : "ÉCHEC", "| CTA /open:", page.includes(`/a/${id}/open`) ? "✓" : "✗", "| taille", page.length);
await c.close();
