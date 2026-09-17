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
