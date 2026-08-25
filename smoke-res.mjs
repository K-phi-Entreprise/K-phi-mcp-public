import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "smoke", version: "0.0.1" });
await c.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp")));
const ls = await c.listResources();
console.log("[resources]", ls.resources.map(r => r.uri));
const g = await c.readResource({ uri: "kphi://mapping-guide" });
console.log("[guide]", g.contents[0].text.split("\n")[0], "…", g.contents[0].text.length, "chars");
await c.close();
