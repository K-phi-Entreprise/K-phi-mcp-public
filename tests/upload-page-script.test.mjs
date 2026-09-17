/**
 * upload-page-script.test.mjs — WHY: the upload page is one big TypeScript
 * template literal that emits a <script> the browser runs. Nothing in the
 * toolchain ever parses that script. `tsc` sees a valid template literal and
 * stops there; the page renders perfectly either way, because the HTML around
 * it is static. So a broken script is invisible until a human tries to use
 * the page and nothing responds — no drop, no click, no send.
 *
 * That is exactly what shipped. The English i18n pass (045431d) wrote
 * `assistant\'s` inside the template. Inside a template literal `\'` is an
 * escaped quote and collapses to a bare `'` before the browser sees it, which
 * closed the single-quoted JS string it sat in and took the whole <script>
 * down with it. Every visitor got an inert page, and the Anthropic listing
 * review was open at the time.
 *
 * So: extract the script the page really serves, and hand it to a parser.
 * Plus the small set of hooks the page cannot work without — a test that only
 * checked syntax would pass on a script that parses and wires nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { uploadPageHtml } from "../dist/upload-page.js";
import { renderReport } from "../dist/report-page.js";

const html = uploadPageHtml();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test("the page serves exactly one inline script", () => {
  assert.equal(scripts.length, 1, "expected one <script> block in the upload page");
  assert.ok(scripts[0].length > 500, "the script is suspiciously short");
});

test("the inline script PARSES — a template literal hides syntax errors from tsc", () => {
  /* new vm.Script compiles without running: same parser the browser uses,
     no DOM needed. A SyntaxError here is a dead page in production. */
  assert.doesNotThrow(
    () => new vm.Script(scripts[0], { filename: "upload-page-inline.js" }),
    (e) => { throw new Error("upload page script does not parse: " + e.message); },
  );
});

test("apostrophes are typographic, never backslash-escaped", () => {
  /* The specific trap, named rather than left to the parser to rediscover:
     \' inside the template collapses to ' and ends the enclosing string. */
  assert.ok(!/\\'/.test(scripts[0]),
    "found \\' in the emitted script — inside a template literal that collapses to a bare ' and breaks the string. Use ’.");
});

test("the script still wires the three things the page cannot work without", () => {
  const s = scripts[0];
  /* Parsing proves it is not broken; these prove it is not empty. */
  assert.match(s, /addEventListener\('change'/, "file input change handler missing");
  assert.match(s, /addEventListener\('drop'/, "drop handler missing");
  assert.match(s, /\.open\('PUT'/, "the send never issues the PUT");
});

test("the markup carries the elements the script reaches for", () => {
  /* A script that parses but addresses ids that no longer exist fails at
     runtime with the same visible symptom: a page that does nothing. */
  for (const id of ["f", "dz", "go", "msg", "bar", "pct", "dzl"]) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `element #${id} missing from the page`);
  }
  assert.match(html, /type="file"/, "no file input on the page");
});

/* The report page is built the same way — a template literal emitting scripts —
   and is what every analysis link opens. Same blind spot, same check. It is
   not broken today; this is here so it cannot become broken silently. */
const REPORT = {
  summary_markdown: "**Summary** — stable.",
  detected: { format: "csv", genre: "ledger", chart_of_accounts: "auto", currency: "USD",
              period: "2025-01..2025-12", entries: 17769, column_map: { acct: "Account" } },
  alerts: [], notes: [],
  kpis: [{ id: "revenue", label: "Revenue", unit: "USD", value: 40844447 },
         { id: "dscr", label: "DSCR", unit: "x", value: 0.9, status: "breach", threshold: 1.2 }],
};

test("every script on the report page parses too", () => {
  const rhtml = renderReport("an_parse_check", REPORT);
  const blocks = [...rhtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).filter((b) => b.trim().length > 0);
  assert.ok(blocks.length > 0, "no inline script found on the report page");
  blocks.forEach((b, i) => {
    assert.doesNotThrow(
      () => new vm.Script(b, { filename: `report-page-inline-${i}.js` }),
      (e) => { throw new Error(`report page script #${i} does not parse: ` + e.message); },
    );
    assert.ok(!/\\'/.test(b), `script #${i} contains \\' — collapses to a bare ' in a template literal`);
  });
});

test("no source marker or comment leaks into the rendered pages", () => {
  /* `/* i18n:fr-ok *\/` was appended to two lines INSIDE the report page's
     template literal. There it is not a comment — it is text, and it was
     printed on the page between the tiles and the KPI section, where the
     owner spotted it (2026-09-17). The marker now lives in an interpolated
     comment, ${/* … *\/ ""}, which keeps it on the source line for the
     english-only scanner and emits nothing. */
  const pages = { upload: html, report: renderReport("an_marker_check", REPORT) };
  for (const [name, page] of Object.entries(pages)) {
    assert.ok(!page.includes("i18n:fr-ok"), `${name} page leaks an i18n marker into its output`);
    /* the general form: a block comment outside <script> is text, not a comment */
    const outsideScripts = page.replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/g, "");
    assert.ok(!/\/\*[\s\S]*?\*\//.test(outsideScripts.replace(/<style>[\s\S]*?<\/style>/g, "")),
      `${name} page prints a /* … */ comment as visible text`);
  }
});
