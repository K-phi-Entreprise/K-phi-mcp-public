/**
 * The capture tools: how a finance team works, captured in the assistant, turned
 * into one reviewed picture, a K-φ scope, a plan, and a sandbox shaped like the
 * group. Several people, one case: the first session opens it and gets a code,
 * colleagues join with that code in their own session.
 *
 * This server holds no logic of its own. The contract, the merge, the conflicts,
 * the block catalogue and the checks are the engine's (K-phi-engine); a refusal
 * comes back with the engine's reasons, word for word, so the assistant can fix
 * exactly what is wrong. Structure only: the engine refuses any capture holding
 * a figure, so none is ever stored.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EngineDown, type CaptureEngine, type EngineReply } from "./engine.js";

export interface CaptureDeps {
  engine: CaptureEngine;
  /** the caller's address, for the engine's per-connection limits */
  ip: () => string;
}

export const INSTRUCTIONS =
  "K-φ Capture looks at how a finance or treasury team actually works and brings back three things: the context " +
  "(systems, companies, banks, accounts, flows, hand work, routines), the scope (the K-φ blocks that answer it, " +
  "and what stays custom), and the improvement plan, with a sandbox shaped like the group. Use it when someone " +
  "asks to map, review or improve how their treasury, cash, forecasting or FP&A work is done, or to see what K-φ " +
  "would take over. Flow: 1) capture_format once, and follow it exactly; 2) capture_open_case for a new company, " +
  "or capture_join_case when the person gives a code from a colleague; 3) look at the work with what this session " +
  "can already see (the person's connected apps, their browser, their files, their screen if they allow it) and " +
  "ask about what it cannot see; 4) show the capture to the person and send it with capture_submit only once they " +
  "agree; 5) when everyone has been captured, capture_case shows the merged picture and its conflicts; a person " +
  "settles each one (capture_review); 6) write the scope and the plan (capture_scope); 7) capture_sandbox builds " +
  "the sandbox. Rules that are not negotiable. Read only: look, never type, click, submit or download in the " +
  "person's systems. Structure only: names, counts, cadence and shapes; never an amount, a balance or an account " +
  "number, which the engine refuses. Say what you could see and what you could not: mark each item observed (seen " +
  "on a screen or in a file) or stated (the person said it), and record the routines that exist but were not " +
  "covered. Ask about what was not shown: month end, quarter end, audits, exceptions. Never present the sandbox's " +
  "figures as the company's: they are simulated. A case and everything in it is deleted after 14 days.";

const text = (s: string) => ({ type: "text" as const, text: s });
const fail = (message: string) => ({ content: [text(message)], isError: true });

/** an engine refusal, with its reasons: what to fix, in the engine's words */
function refused(r: EngineReply, lead: string) {
  const errors = Array.isArray(r.body.errors) ? r.body.errors as Array<{ at?: string; message?: string }> : [];
  const lines = errors.slice(0, 40).map(e => "- " + String(e.message ?? e.at ?? "").slice(0, 400));
  const more = errors.length > 40 ? "\n- and " + (errors.length - 40) + " more" : "";
  const msg = String(r.body.message ?? r.body.error ?? "refused");
  return {
    content: [text(lead + " " + msg + (lines.length ? "\n\n" + lines.join("\n") + more : ""))],
    structuredContent: { refused: true, error: r.body.error ?? null, ...(r.body.stage ? { stage: r.body.stage } : {}), errors },
    isError: true,
  };
}
async function guard(run: () => Promise<ReturnType<typeof refused> | { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> }>) {
  try { return await run(); }
  catch (e) {
    if (e instanceof EngineDown) return fail(e.message + ". Nothing was lost on the person's side: try again in a minute.");
    throw e;
  }
}

interface Conflict { id: string; list: string; item: string; field: string; resolved?: boolean; value?: unknown; values: Array<{ value: unknown; by: string[] }> }
interface Participant { id: string; role: string }
const STAGES: Record<string, string> = {
  collect: "collecting: conflicts are open, a person has to settle them",
  review: "reviewed: every conflict is settled (or there was none); the scope can be written",
  scoped: "scoped: the scope is written; the plan is next",
  planned: "planned: scope and plan are written",
};
function caseText(b: Record<string, unknown>): string {
  const people = (b.participants as Participant[] | undefined) ?? [];
  const conflicts = (b.conflicts as Conflict[] | undefined) ?? [];
  const open = conflicts.filter(c => !c.resolved);
  const lines: string[] = [];
  lines.push("**Stage:** " + (STAGES[String(b.stage)] ?? String(b.stage)));
  lines.push("**Captured:** " + (people.length ? people.map(p => p.role + " (" + p.id + ")").join(", ") : "nobody yet"));
  if (open.length) {
    lines.push("", "**" + open.length + " conflict" + (open.length > 1 ? "s" : "") + " to settle with a person** (capture_review):");
    for (const c of open) lines.push("- `" + c.id + "`: " + c.values.map(v => JSON.stringify(v.value) + " (" + v.by.join(", ") + ")").join(" vs "));
  }
  const stale = (b.stale_decisions as Array<{ id: string; why: string }> | undefined) ?? [];
  if (stale.length) lines.push("", "**Decisions that no longer apply:** " + stale.map(s => s.id).join(", "));
  const warnings = (b.warnings as Array<{ message: string }> | undefined) ?? [];
  if (warnings.length) lines.push("", ...warnings.slice(0, 12).map(w => "> " + w.message));
  if (b.reminder) lines.push("", String(b.reminder));
  return lines.join("\n");
}

export function registerCaptureTools(server: McpServer, deps: CaptureDeps) {
  const { engine } = deps;
  const CASE = z.string().regex(/^c_[0-9a-f]{12}$/).describe("The case id returned by capture_open_case or capture_join_case");

  server.registerTool("capture_format", {
    title: "The capture format and the K-φ blocks",
    description:
      "The contract a capture, a scope and a plan must follow (lists, fields, allowed values, rules), and the K-φ " +
      "block catalogue (what each block does, the hand work it answers, the records it needs, the blocks it stands " +
      "on). Call it once at the start of a session and follow it exactly: the engine refuses anything else.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => guard(async () => {
    const r = await engine.call("GET", "capture/format");
    if (!r.ok) return refused(r, "The format could not be read:");
    return {
      content: [text(
        "The capture contract and the block catalogue are in the structured result.\n\n" +
        "- A **capture** is one person's session: `{ kind: \"kphi-capture\", version: 1, case: { company }, participant: { id, role }, session: { date, minutes, eyes }, context: { systems, entities, banks, accounts, flows, manual_steps, routines }, open_questions }`.\n" +
        "- Every item has an `id` (lower case, dashes) and an `evidence`: `observed` or `stated`.\n" +
        "- No figure anywhere: no amount, balance, IBAN or account number.\n" +
        "- The **scope** answers every block of the catalogue, on or off, with the reason and what was captured that calls for it.\n" +
        "- The **plan** says what happens to every piece of hand work: replaced by a step, or kept by hand with the reason.")],
      structuredContent: r.body,
    };
  }));

  server.registerTool("capture_open_case", {
    title: "Open a case for a company",
    description:
      "Open a case for one company and get its code. The person shares the code with the colleagues who should " +
      "also be captured; each gives it to their own assistant (capture_join_case). Use capture_join_case instead " +
      "when the person already has a code.",
    inputSchema: { company: z.string().min(1).max(120).describe("The company's or the group's name") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ company }) => guard(async () => {
    const r = await engine.call("POST", "capture/case", { company, ip: deps.ip() });
    if (!r.ok) return refused(r, "The case could not be opened:");
    return {
      content: [text(
        "Case opened for **" + String(r.body.company) + "**.\n\n" +
        "**Code to share with colleagues: `" + String(r.body.code) + "`**\n\n" +
        "Give the code to the person, in those words: each colleague gives it to their own assistant to add their view to the same case.\n\n" +
        String(r.body.reminder ?? ""))],
      structuredContent: r.body,
    };
  }));

  server.registerTool("capture_join_case", {
    title: "Join a colleague's case with its code",
    description: "Join the case a colleague opened, with the code they shared (for example MERIDIAN-7K2Q9F). Returns the case id and who has been captured so far.",
    inputSchema: { code: z.string().min(3).max(40).describe("The code, as the person gives it") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ code }) => guard(async () => {
    const r = await engine.call("POST", "capture/join", { code, ip: deps.ip() });
    if (!r.ok) return refused(r, "No case was joined:");
    const people = (r.body.participants as Participant[] | undefined) ?? [];
    return {
      content: [text(
        "Joined the case of **" + String(r.body.company) + "**.\n\n" +
        "Already captured: " + (people.length ? people.map(p => p.role + " (" + p.id + ")").join(", ") : "nobody yet") + ".\n" +
        "Choose a participant id nobody uses yet for this person.\n\n" + String(r.body.reminder ?? ""))],
      structuredContent: r.body,
    };
  }));

  server.registerTool("capture_submit", {
    title: "Add one person's capture to the case",
    description:
      "Send one person's capture to the case, once the person has read it and agreed. The engine checks it against " +
      "the contract and refuses it with the reasons if anything is wrong, or if it holds a figure. A new capture " +
      "reopens a case that already had a scope. Pass replace:true only for the same person's new session.",
    inputSchema: {
      case: CASE,
      capture: z.record(z.string(), z.unknown()).describe("The capture, as capture_format describes it"),
      replace: z.boolean().optional().describe("true when this replaces the same person's earlier capture"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (a) => guard(async () => {
    const r = await engine.call("POST", "capture/" + a.case + "/capture", { capture: a.capture, replace: a.replace === true });
    if (!r.ok) return refused(r, "The capture was not added:");
    return {
      content: [text(
        "Capture added for **" + String(r.body.participant) + "**" + (r.body.replaced ? " (replacing the earlier one)" : "") + "." +
        (r.body.reopened ? " The case is reopened: its scope and plan were written from the earlier picture and have been dropped." : "") +
        "\n\n" + caseText(r.body))],
      structuredContent: r.body,
    };
  }));

  server.registerTool("capture_case", {
    title: "The case as it stands",
    description: "The merged picture of everyone captured so far: who showed or said what, the conflicts between people, the stage, and the scope and plan once written.",
    inputSchema: { case: CASE },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (a) => guard(async () => {
    const r = await engine.call("GET", "capture/" + a.case);
    if (!r.ok) return refused(r, "The case could not be read:");
    return { content: [text("**" + String(r.body.company) + "**\n\n" + caseText(r.body))], structuredContent: r.body };
  }));

  server.registerTool("capture_review", {
    title: "Record what a person settled",
    description:
      "Record a person's decision on one or more conflicts. The value must be one of those people gave; pass " +
      "other:true when the review settled on something nobody said. Never decide in the person's place: put each " +
      "conflict to them with who said what. Settling a conflict reopens a case that already had a scope.",
    inputSchema: {
      case: CASE,
      decisions: z.array(z.object({
        id: z.string().describe("The conflict id, as capture_case gives it"),
        value: z.unknown().describe("The value the person settled on"),
        note: z.string().max(300).optional().describe("Why, in a few words, without figures"),
        other: z.boolean().optional(),
      })).min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (a) => guard(async () => {
    const r = await engine.call("POST", "capture/" + a.case + "/review", { decisions: a.decisions });
    if (!r.ok) return refused(r, "Nothing was settled:");
    return { content: [text(String(r.body.settled) + " conflict(s) settled.\n\n" + caseText(r.body))], structuredContent: r.body };
  }));

  server.registerTool("capture_scope", {
    title: "Write the scope and the plan",
    description:
      "Write the case's scope (structure, every block on or off with its reason, sources, proposed rules, custom " +
      "items) and, with it or later, the plan. Refused while a conflict is open, when a block that is on lacks the " +
      "blocks it stands on or a source for its records, or when a piece of hand work is neither replaced nor kept " +
      "with a reason. The refusal lists what to fix.",
    inputSchema: {
      case: CASE,
      scope: z.record(z.string(), z.unknown()).describe("The scope, as capture_format describes it"),
      plan: z.record(z.string(), z.unknown()).optional().describe("The plan, as capture_format describes it"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (a) => guard(async () => {
    const r = await engine.call("POST", "capture/" + a.case + "/scope", { scope: a.scope, ...(a.plan ? { plan: a.plan } : {}) });
    if (!r.ok) return refused(r, "The scope was not written:");
    return { content: [text("Written.\n\n" + caseText(r.body))], structuredContent: r.body };
  }));

  server.registerTool("capture_sandbox", {
    title: "Build the sandbox from the scope",
    description:
      "Build a K-φ sandbox shaped like the group in the scope: its companies, countries, currencies, industry and a " +
      "size band, with simulated books. The first call prepares the data and answers that it is preparing: call " +
      "again after about 30 seconds with the same arguments. Tell the person, every time, what the sandbox does " +
      "not reflect (the result lists it) and that its figures are simulated, not theirs.",
    inputSchema: {
      case: CASE,
      size: z.enum(["small", "mid", "large"]).optional().describe("A size band for the simulated figures; mid when not given"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (a) => guard(async () => {
    const ap = await engine.call("POST", "capture/" + a.case + "/apply", a.size ? { size: a.size } : {});
    if (!ap.ok) return refused(ap, "No sandbox yet:");
    const notBuilt = (ap.body.not_built as Array<{ what: string; why: string }> | undefined) ?? [];
    const adjustments = (ap.body.adjustments as Array<{ what: string; why: string }> | undefined) ?? [];
    const st = await engine.call("POST", "build/start", { ...(ap.body.start as Record<string, unknown>), ip: deps.ip() });
    if (st.status === 202) {
      return {
        content: [text("The sandbox's data is being prepared (the first time for this group). Call capture_sandbox again in about 30 seconds with the same arguments.")],
        structuredContent: { state: "preparing", retry_after_sec: 30, adjustments, not_built: notBuilt },
      };
    }
    if (!st.ok) return refused(st, "The sandbox could not be built:");
    const build = String(st.body.buildId);
    const link = await engine.call("POST", "build/" + build + "/open-link", {});
    const url = link.ok ? String(link.body.url) : null;
    const lines = [
      "The sandbox is ready: K-φ shaped like **" + String((ap.body.start as { custom: { company: string } }).custom.company) + "**.",
      url ? "\n## [Open the sandbox in K-φ](" + url + ")\n\nRead only, link valid 24 hours." : "\nThe sandbox was built, but its link could not be made on this deployment.",
      "\n**What it does not reflect** (say this to the person):",
      ...notBuilt.map(n => "- " + n.why),
    ];
    if (adjustments.length) lines.push("\n**Changed to fit the simulation:**", ...adjustments.map(x => "- " + x.why));
    lines.push("\n" + String(st.body.reminder ?? ""));
    return {
      content: [text(lines.join("\n"))],
      structuredContent: { state: "ready", build, url, expires_at: st.body.expires_at ?? null, adjustments, not_built: notBuilt },
    };
  }));
}
