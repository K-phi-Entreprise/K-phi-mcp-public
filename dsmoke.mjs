import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "smoke", version: "0.0.1" });
await c.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp")));
const csv = "Date,Entity,Account,AccountName,Debit,Credit\n" +
  ["2025-01","2025-02","2025-03"].flatMap(p => [
    `${p}-15,E1,11000,Accounts Receivable,100.00,0.00`, `${p}-15,E1,40000,Revenue,0.00,1000.00`, `${p}-15,E1,10100,Cash,900.00,0.00`,
    `${p}-15,E2,11000,Accounts Receivable,900.00,0.00`, `${p}-15,E2,40000,Revenue,0.00,1000.00`, `${p}-15,E2,10100,Cash,100.00,0.00`,
  ]).join("\n") + "\n";
const r = await c.callTool({ name: "kphi_analyze_ledger", arguments: { content: csv } });
const sc = r.structuredContent;
console.log("[contrat]", sc.report_version, "| forecast:", !!sc.forecast, "| scopes entité:", Object.keys(sc.forecast?.by_entity ?? {}).join(","));
const page = await (await fetch("http://localhost:3000/a/" + sc.analysis_id)).text();
console.log("[dashboard] bouton:", /id="bF"/.test(page) ? "✓" : "✗", "| __FC embarqué:", page.includes("__FC=") && !page.includes("__FC=null") ? "✓" : "✗ (null)");
await c.close();
