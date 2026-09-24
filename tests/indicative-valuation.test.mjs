/**
 * The indicative valuation range (owner, 2026-09-24): "a range is more
 * honest, and it is a teaser: refine it in the platform."
 * The engine call (token, then the range route) and the text the assistant
 * receives: a range, never one figure, what was assumed, the invitation to
 * refine in K-Φ, and the caution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KphiHttpEngine, EngineError } from "../dist/engine-http.js";
import { formatIndicative } from "../dist/tools.js";

const SAMPLE = {
  indicative: true,
  range: { low: 1_800_000, high: 2_600_000 },
  currency: "USD",
  based_on: { ledger_months: 12, from: "2025-09", to: "2026-08", annualised: false, revenue: 4_200_000, ebitda: 630_000, ebitda_margin: 0.15, net_debt: 150_000 },
  methods: ["discounted cash flows", "EV/EBITDA comparables"],
  assumed: [
    { input: "Risk-free rate", value: 0.04, basis: "assumed 4%" },
    { input: "Unlevered beta", value: 1.33, basis: "Software (System & Application)" },
    { input: "Working capital", value: 0.10, basis: "assumed 10% of revenue" },
  ],
  not_measured: ["working capital from your receivables and payables", "cash burn and runway from your bank"],
  refine: { message: "This is an indicative range from your ledger alone.", url: "https://k-phi.com/app" },
  caution: "Indicative only: not a valuation, not a fair-market-value opinion, not a 409A.",
};

test("the text states a range, never a single figure", () => {
  const t = formatIndicative(SAMPLE);
  assert.match(t, /^Indicative equity value: between 1,800,000 and 2,600,000 USD\./);
  assert.doesNotMatch(t, /worth \d|value is \d|valued at \d/i);
});

test("the text lists what was assumed and what a full valuation would measure", () => {
  const t = formatIndicative(SAMPLE);
  assert.match(t, /Assumed, not measured:/);
  assert.match(t, /- Risk-free rate: 4\.0% \(assumed 4%\)/);
  assert.match(t, /- Unlevered beta: 1\.33/);            /* a beta is not a percentage */
  assert.match(t, /A full valuation would measure instead: working capital from your receivables and payables/);
});

test("the invitation points to this analysis's workspace when there is one", () => {
  assert.match(formatIndicative(SAMPLE, "https://k-phi.com/open/abc"), /Open this analysis in K-Φ to refine it: https:\/\/k-phi\.com\/open\/abc/);
  assert.match(formatIndicative(SAMPLE), /https:\/\/k-phi\.com\/app/);
});

test("the caution is always the last line", () => {
  const lines = formatIndicative(SAMPLE).split("\n");
  assert.equal(lines[lines.length - 1], SAMPLE.caution);
});

test("the engine call mints a sandbox token, then posts to the range route with it", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith("/api/internal/sandbox/token")) return new Response(JSON.stringify({ token: "tok-123" }), { status: 200 });
    if (String(url).endsWith("/api/valuation/indicative")) return new Response(JSON.stringify(SAMPLE), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  try {
    const eng = new KphiHttpEngine({ baseUrl: "https://engine.test", serviceSecret: "s", retryDelayMs: 5 });
    const v = await eng.indicativeValuation("tenant-1", { industry: "Software", country: "US" });
    assert.deepEqual(v.range, SAMPLE.range);
    const call = seen.find(c => c.url.endsWith("/api/valuation/indicative"));
    assert.equal(call.init.method, "POST");
    assert.equal(new Headers(call.init.headers).get("authorization"), "Bearer tok-123");
    assert.deepEqual(JSON.parse(call.init.body), { industry: "Software", country: "US" });
  } finally { globalThis.fetch = orig; }
});

test("an engine refusal (no positive EBITDA) comes back as a readable error", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).endsWith("/token")
    ? new Response(JSON.stringify({ token: "t" }), { status: 200 })
    : new Response(JSON.stringify({ error: "EBITDA over the last 12 months is not positive" }), { status: 422 });
  try {
    const eng = new KphiHttpEngine({ baseUrl: "https://engine.test", serviceSecret: "s", retryDelayMs: 5 });
    await assert.rejects(eng.indicativeValuation("t", {}), (e) => e instanceof EngineError && /EBITDA/.test(e.message) && e.status === 422);
  } finally { globalThis.fetch = orig; }
});
