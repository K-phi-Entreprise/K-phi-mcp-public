/**
 * capture-tools.test.mjs — WHY: the capture server holds no logic of its own;
 * its whole job is to carry the engine's answers to the assistant without
 * losing or bending them. So what is tested is the carrying: the right route
 * for each tool, the engine's refusal reasons relayed word for word, the
 * "preparing" answer of a sandbox, an engine failure said as such (never as the
 * person's fault), and the shared secret never appearing in anything returned.
 *
 * A real McpServer wired in memory, driven by the SDK client, on a scripted
 * engine. The same flow against the real engine is checked outside this repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCaptureTools, INSTRUCTIONS } from "../dist/build/tools.js";
import { HttpCaptureEngine, EngineDown } from "../dist/build/engine.js";

const CASE = "c_0123456789ab";
const FOOT = { case: CASE, expires_at: "2026-12-02T10:00:00.000Z", reminder: "This case and everything captured in it are deleted on 2026-12-02." };

/** a scripted engine: answers by "METHOD path", records every call */
function scripted(answers) {
  const calls = [];
  return {
    calls,
    async call(method, path, body) {
      calls.push({ method, path, body });
      const a = answers[method + " " + path];
      if (!a) return { status: 404, ok: false, body: { error: "unknown", message: "no such route in the script: " + method + " " + path } };
      const r = typeof a === "function" ? a(body, calls) : a;
      if (r instanceof Error) throw r;
      return { status: r.status ?? 200, ok: (r.status ?? 200) < 300, body: r.body };
    },
  };
}
async function boot(engine) {
  const server = new McpServer({ name: "capture-test", version: "0.0.0" }, { instructions: INSTRUCTIONS });
  registerCaptureTools(server, { engine, ip: () => "203.0.113.5" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "capture-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
}
const textOf = (r) => r.content.filter(c => c.type === "text").map(c => c.text).join("\n");

test("eight tools, each with a title and a description; reads are marked read only", async () => {
  const c = await boot(scripted({}));
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map(t => t.name), ["capture_format", "capture_open_case", "capture_join_case", "capture_submit", "capture_case", "capture_review", "capture_scope", "capture_sandbox"]);
  for (const t of tools) { assert.ok(t.title && t.description.length > 60, t.name); }
  const ro = Object.fromEntries(tools.map(t => [t.name, t.annotations.readOnlyHint]));
  assert.deepEqual(ro, { capture_format: true, capture_open_case: false, capture_join_case: true, capture_submit: false, capture_case: true, capture_review: false, capture_scope: false, capture_sandbox: false });
});

test("the instructions carry the rules that are not negotiable", () => {
  for (const must of ["Read only", "never type, click, submit", "Structure only", "never an amount", "observed", "stated", "simulated", "14 days"])
    assert.ok(INSTRUCTIONS.includes(must), "instructions lack: " + must);
});

test("open a case: the code is given to share; the caller's address goes to the engine for its limits", async () => {
  const e = scripted({ "POST capture/case": { body: { company: "Meridian Trading", code: "MERIDIAN-7K2Q9F", ...FOOT } } });
  const r = await (await boot(e)).callTool({ name: "capture_open_case", arguments: { company: "Meridian Trading" } });
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /MERIDIAN-7K2Q9F/);
  assert.match(textOf(r), /deleted on 2026-12-02/);
  assert.deepEqual(e.calls[0], { method: "POST", path: "capture/case", body: { company: "Meridian Trading", ip: "203.0.113.5" } });
  assert.equal(r.structuredContent.case, CASE);
});

test("join with a code: who is already there; an unknown code is the engine's refusal, said as such", async () => {
  const e = scripted({ "POST capture/join": (b) => b.code === "MERIDIAN-7K2Q9F"
    ? { body: { company: "Meridian Trading", stage: "review", participants: [{ id: "treasurer", role: "Treasurer" }], ...FOOT } }
    : { status: 404, body: { error: "unknown_code", message: "No case with this code: check it with the colleague who opened the case (it expires after 14 days)" } } });
  const c = await boot(e);
  const ok = await c.callTool({ name: "capture_join_case", arguments: { code: "MERIDIAN-7K2Q9F" } });
  assert.match(textOf(ok), /Treasurer \(treasurer\)/);
  const no = await c.callTool({ name: "capture_join_case", arguments: { code: "MERIDIAN-AAAAAA" } });
  assert.equal(no.isError, true);
  assert.match(textOf(no), /check it with the colleague who opened the case/);
  assert.equal(no.structuredContent.error, "unknown_code");
});

test("a refused capture comes back with every reason, word for word, and nothing is said to be added", async () => {
  const errors = [
    { code: "figure", at: "context.manual_steps[0].what", message: "context.manual_steps[0].what holds an amount: a capture holds structure, never figures. Describe it in words, or leave it out" },
    { code: "ref", at: "context.accounts[0].bank", message: "context.accounts[0].bank names \"nowhere\", which is not in banks" },
  ];
  const e = scripted({ ["POST capture/" + CASE + "/capture"]: { status: 422, body: { error: "invalid_capture", message: "2 thing(s) to fix in the capture", errors } } });
  const r = await (await boot(e)).callTool({ name: "capture_submit", arguments: { case: CASE, capture: { kind: "kphi-capture" } } });
  assert.equal(r.isError, true);
  for (const x of errors) assert.ok(textOf(r).includes(x.message), "missing reason: " + x.code);
  assert.doesNotMatch(textOf(r), /Capture added/);
  assert.deepEqual(r.structuredContent.errors, errors);
  assert.deepEqual(e.calls[0].body, { capture: { kind: "kphi-capture" }, replace: false });
});

test("an accepted capture: the conflicts are listed with who said what; a reopened case is said to be", async () => {
  const body = { participant: "controller", replaced: false, reopened: true, stage: "collect",
    participants: [{ id: "treasurer", role: "Treasurer" }, { id: "controller", role: "Financial controller" }],
    conflicts: [{ id: "entities:asia:currency", list: "entities", item: "asia", field: "currency", resolved: false, values: [{ value: "SGD", by: ["controller"] }, { value: "USD", by: ["treasurer"] }] }],
    warnings: [{ code: "conflicts_open", message: "1 conflict to settle before a scope can be written" }], stale_decisions: [], ...FOOT };
  const e = scripted({ ["POST capture/" + CASE + "/capture"]: { body } });
  const r = await (await boot(e)).callTool({ name: "capture_submit", arguments: { case: CASE, capture: {}, replace: true } });
  const t = textOf(r);
  assert.match(t, /Capture added for \*\*controller\*\*/);
  assert.match(t, /reopened/);
  assert.match(t, /`entities:asia:currency`: "SGD" \(controller\) vs "USD" \(treasurer\)/);
  assert.match(t, /1 conflict to settle with a person/);
  assert.equal(e.calls[0].body.replace, true);
});

test("review and scope go to their routes; a scope refused before the review says so with the stage", async () => {
  const e = scripted({
    ["POST capture/" + CASE + "/review"]: { body: { settled: 1, stage: "review", participants: [], conflicts: [], warnings: [], stale_decisions: [], ...FOOT } },
    ["POST capture/" + CASE + "/scope"]: (b) => b.plan
      ? { body: { stage: "planned", participants: [], conflicts: [], warnings: [], stale_decisions: [], ...FOOT } }
      : { status: 422, body: { error: "invalid_scope", message: "1 thing(s) to fix", stage: "collect", errors: [{ code: "unreviewed", at: "conflicts", message: "1 conflict is not settled: the scope and the plan are written after the review, from one agreed picture" }] } },
  });
  const c = await boot(e);
  const rv = await c.callTool({ name: "capture_review", arguments: { case: CASE, decisions: [{ id: "entities:asia:currency", value: "USD", note: "Functional currency" }] } });
  assert.match(textOf(rv), /1 conflict\(s\) settled/);
  assert.deepEqual(e.calls[0].body.decisions, [{ id: "entities:asia:currency", value: "USD", note: "Functional currency" }]);
  const early = await c.callTool({ name: "capture_scope", arguments: { case: CASE, scope: { structure: {} } } });
  assert.equal(early.isError, true);
  assert.match(textOf(early), /written after the review/);
  assert.equal(early.structuredContent.stage, "collect");
  const done = await c.callTool({ name: "capture_scope", arguments: { case: CASE, scope: { structure: {} }, plan: { steps: [] } } });
  assert.match(textOf(done), /planned: scope and plan are written/);
});

test("the sandbox: preparing the first time, then the link, with what it does not reflect said every time", async () => {
  const start = { dataset: "custom", custom: { industry: "commodities", company: "Meridian Trading", entities: [], baseCurrency: "CHF", revenue: 100000000 } };
  const not_built = [{ what: "accounts", why: "the sandbox has the simulated group's own bank accounts, not the 5 captured" }, { what: "figures", why: "all amounts are illustrative (size band \"mid\"): a capture holds none" }];
  let n = 0;
  const e = scripted({
    ["POST capture/" + CASE + "/apply"]: { body: { start, adjustments: [{ what: "country", why: "no country captured: taken from the currency" }], not_built, ...FOOT } },
    "POST build/start": () => (++n === 1
      ? { status: 202, body: { state: "preparing", retry_after_sec: 30 } }
      : { body: { buildId: "b_0123456789ab", expires_at: "2026-11-21T10:00:00.000Z", reminder: "This build is deleted on 2026-11-21 unless it is claimed." } }),
    "POST build/b_0123456789ab/open-link": { body: { url: "https://k-phi.test/api/internal/sandbox/open?t=abc", expires_in: 86400 } },
  });
  const c = await boot(e);
  const first = await c.callTool({ name: "capture_sandbox", arguments: { case: CASE } });
  assert.equal(first.structuredContent.state, "preparing");
  assert.match(textOf(first), /again in about 30 seconds/);
  const second = await c.callTool({ name: "capture_sandbox", arguments: { case: CASE } });
  assert.equal(second.structuredContent.state, "ready");
  const t = textOf(second);
  assert.match(t, /\[Open the sandbox in K-φ\]\(https:\/\/k-phi\.test\/api\/internal\/sandbox\/open\?t=abc\)/);
  for (const x of not_built) assert.ok(t.includes(x.why));
  assert.match(t, /no country captured: taken from the currency/);
  /* the inputs of the build are the engine's own, untouched, plus the caller's address */
  assert.deepEqual(e.calls.find(x => x.path === "build/start").body, { ...start, ip: "203.0.113.5" });
});

test("no sandbox before a scope: the engine's reason, and no build is started", async () => {
  const e = scripted({ ["POST capture/" + CASE + "/apply"]: { status: 422, body: { error: "not_ready", message: "The case is at stage \"review\": a sandbox is built from a scope, written after the review", stage: "review", errors: [] } } });
  const r = await (await boot(e)).callTool({ name: "capture_sandbox", arguments: { case: CASE, size: "small" } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /a sandbox is built from a scope/);
  assert.equal(e.calls.length, 1);
  assert.deepEqual(e.calls[0].body, { size: "small" });
});

test("an engine that is down is said to be down: never the person's fault, never a thrown error", async () => {
  const e = scripted({ "POST capture/case": new EngineDown("The K-φ engine failed (503)", 503) });
  const r = await (await boot(e)).callTool({ name: "capture_open_case", arguments: { company: "X" } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /engine failed \(503\).*try again in a minute/);
});

test("a malformed case id never reaches the engine", async () => {
  const e = scripted({});
  const c = await boot(e);
  const r = await c.callTool({ name: "capture_case", arguments: { case: "../keys" } }).catch(err => ({ isError: true, thrown: String(err) }));
  assert.equal(r.isError, true);
  assert.equal(e.calls.length, 0);
});

test("the engine client: the secret and the gate header on every call; 4xx is an answer, 5xx and 401 are failures", async () => {
  const seen = [];
  const reply = (status, body) => ({ status, json: async () => body });
  const script = { "/api/internal/capture/format": reply(200, { contract: {} }), "/api/internal/capture/join": reply(404, { error: "unknown_code" }), "/api/internal/capture/case": reply(500, {}), "/api/internal/build/start": reply(401, { error: "unauthorized" }), "/api/internal/capture/x/apply": reply(404, { error: "not_enabled" }) };
  const eng = new HttpCaptureEngine({ baseUrl: "https://engine.test/", secret: "s3cret-value", fetchImpl: async (url, init) => { seen.push({ url, init }); return script[new URL(url).pathname]; } });
  const ok = await eng.call("GET", "capture/format");
  assert.deepEqual([ok.status, ok.ok], [200, true]);
  assert.equal(seen[0].url, "https://engine.test/api/internal/capture/format");
  assert.equal(seen[0].init.headers["X-Build-Secret"], "s3cret-value");
  assert.equal(seen[0].init.headers["X-Requested-With"], "XMLHttpRequest");
  assert.equal(seen[0].init.body, undefined);
  const no = await eng.call("POST", "capture/join", { code: "X" });
  assert.deepEqual([no.status, no.ok, no.body.error], [404, false, "unknown_code"]);
  assert.equal(seen[1].init.body, JSON.stringify({ code: "X" }));
  await assert.rejects(() => eng.call("POST", "capture/case", {}), /engine failed \(500\)/);
  await assert.rejects(() => eng.call("POST", "build/start", {}), /not connected to the K-φ engine/);
  await assert.rejects(() => eng.call("POST", "capture/x/apply", {}), /not connected to the K-φ engine/);
  const down = new HttpCaptureEngine({ baseUrl: "https://engine.test", secret: "s3cret-value", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(() => down.call("GET", "capture/format"), (err) => err instanceof EngineDown && !/s3cret/.test(err.message));
});
