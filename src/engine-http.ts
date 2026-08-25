/**
 * KphiHttpEngine — implémentation réelle de AnalysisEngine (Option B, variante
 * "tenant sandbox unique + une version par analyse").
 *
 * Flux par analyse :
 *   1. parse local (parse-ledger.ts) → entries[] normalisées
 *   2. POST /api/internal/sandbox/token      → JWT de service (secret partagé)   [nouveau côté moteur]
 *   3. POST /api/gl/import  { ver: anon_<id>, mode: replace, entries }           [existe]
 *   4. GET  /api/statements?ver=anon_<id>    → kpi, ratios, pl, bs               [existe]
 *   5. DELETE /api/versions/anon_<id>        → purge                              [existe]
 *      (+ cron côté moteur qui purge toute version anon_* > 24 h : filet)
 *
 * Isolation : chaque requête au moteur est scopée par `ver`. Rien ici ne lit
 * jamais "toutes les versions". C'est le contrat à préserver côté moteur.
 */
import type { AnalysisEngine, AnalysisResult, AnalyzeInput, Kpi } from "./engine.js";
import { parseLedger, ParseError } from "./parse-ledger.js";

export interface KphiHttpEngineConfig {
  baseUrl: string;          // https://k-phi.com (ou l'URL Render du moteur)
  serviceSecret: string;    // = KPHI_SANDBOX_SECRET côté moteur
  timeoutMs?: number;       // défaut 60 s
  purgeAfterRead?: boolean; // défaut true
}

export class KphiHttpEngine implements AnalysisEngine {
  private timeout: number;
  private purge: boolean;

  constructor(private cfg: KphiHttpEngineConfig) {
    if (!cfg.baseUrl || !cfg.serviceSecret) throw new Error("KphiHttpEngine: baseUrl et serviceSecret requis");
    this.timeout = cfg.timeoutMs ?? 60_000;
    this.purge = cfg.purgeAfterRead ?? true;
  }

  async analyze(input: AnalyzeInput): Promise<AnalysisResult> {
    const parsed = parseLedger(input.content);
    const ver = `anon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const token = await this.serviceToken();
    try {
      await this.importVersion(token, ver, parsed.entries, parsed.period_to);
      const stmts = await this.statements(token, ver);
      return toAnalysisResult(parsed, stmts, input);
    } finally {
      if (this.purge) this.deleteVersion(token, ver).catch(e => console.error("sandbox purge failed", ver, e));
    }
  }

  async analyzeFromStorage(_storageKey: string, _opts: Omit<AnalyzeInput, "content">): Promise<AnalysisResult> {
    // TODO : lire le fichier depuis l'object storage puis appeler analyze().
    throw new Error("analyzeFromStorage: object storage non branché");
  }

  /* ----------------------------------------------------------------- */

  private async serviceToken(): Promise<string> {
    const r = await this.fetch("/api/internal/sandbox/token", {
      method: "POST",
      headers: { "X-Sandbox-Secret": this.cfg.serviceSecret },
    });
    const j = await r.json() as { token?: string; error?: string };
    if (!r.ok || !j.token) throw new Error(`sandbox token: ${r.status} ${j.error ?? ""}`);
    return j.token;
  }

  private async importVersion(token: string, ver: string, entries: unknown[], vdatePeriod: string) {
    const vdate = vdatePeriod ? `${vdatePeriod}-01` : new Date().toISOString().slice(0, 10);
    const r = await this.fetch("/api/gl/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ver, vdate, mode: "replace", version_type: "ACTUALS", entries }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(`import: ${r.status} ${j.error ?? ""}`);
    }
  }

  private async statements(token: string, ver: string): Promise<StatementsPayload> {
    const r = await this.fetch(`/api/statements?ver=${encodeURIComponent(ver)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json() as StatementsPayload & { error?: string; message?: string };
    if (!r.ok) throw new Error(`statements: ${r.status} ${j.error ?? ""} ${j.message ?? ""}`);
    return j;
  }

  private async deleteVersion(token: string, ver: string) {
    const r = await this.fetch(`/api/versions/${encodeURIComponent(ver)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok && r.status !== 404) throw new Error(`delete version: ${r.status}`);
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      return await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, { ...init, signal: ctrl.signal });
    } finally { clearTimeout(t); }
  }
}

/* ------------------------------------------------------------------ */
/* Mapping sortie moteur → AnalysisResult                               */
/* ------------------------------------------------------------------ */

interface StatementsPayload {
  kpi?: Record<string, unknown>;
  ratios?: Record<string, unknown> | null;
  pl?: Array<{ cat?: string; nm?: string; amt?: number; [k: string]: unknown }>;
  bs?: Array<{ cat?: string; nm?: string; amt?: number }>;
  warnings?: string[];
  scope?: { rows?: number };
}

/**
 * Les clés exactes de `kpi`/`ratios` viennent de modules/kpi.js (moteur navigateur
 * exécuté serveur). Elles ne sont pas figées ici : on cherche chaque KPI attendu
 * sous plusieurs noms plausibles, et on expose de toute façon TOUT `kpi` et
 * `ratios` en brut dans `raw` pour ajuster le mapping sur un vrai retour.
 */
const KPI_SPEC: Array<{ id: string; label: string; unit: string; keys: string[] }> = [
  { id: "revenue",         label: "Chiffre d'affaires",   unit: "CCY", keys: ["revenue", "sales", "turnover", "ca", "netRevenue"] },
  { id: "ebitda",          label: "EBITDA",               unit: "CCY", keys: ["ebitda", "EBITDA"] },
  { id: "ebitda_margin",   label: "Marge d'EBITDA",       unit: "%",   keys: ["ebitdaMargin", "ebitda_margin", "ebitdaPct"] },
  { id: "net_income",      label: "Résultat net",         unit: "CCY", keys: ["netIncome", "net_income", "netResult", "result"] },
  { id: "cash",            label: "Trésorerie",           unit: "CCY", keys: ["cash", "closingCash", "cashBalance", "treasury"] },
  { id: "working_capital", label: "BFR",                  unit: "CCY", keys: ["workingCapital", "bfr", "wcr", "nwc"] },
  { id: "dso",             label: "DSO",                  unit: "days",keys: ["dso", "DSO"] },
  { id: "dpo",             label: "DPO",                  unit: "days",keys: ["dpo", "DPO"] },
  { id: "net_debt",        label: "Dette nette",          unit: "CCY", keys: ["netDebt", "net_debt"] },
  { id: "net_debt_ebitda", label: "Dette nette / EBITDA", unit: "x",   keys: ["netDebtToEbitda", "leverage", "netDebtEbitda"] },
  { id: "dscr",            label: "DSCR",                 unit: "x",   keys: ["dscr", "DSCR"] },
  { id: "gearing",         label: "Gearing",              unit: "%",   keys: ["gearing", "debtToEquity"] },
  { id: "current_ratio",   label: "Ratio de liquidité",   unit: "x",   keys: ["currentRatio", "current_ratio", "liquidity"] },
  { id: "cash_runway",     label: "Cash runway",          unit: "months", keys: ["runway", "cashRunway", "runwayMonths"] },
];

function pick(src: Record<string, unknown> | null | undefined, keys: string[]): number | undefined {
  if (!src) return undefined;
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "number" && isFinite(v)) return v;
    if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number") return (v as { value: number }).value;
  }
  return undefined;
}

function toAnalysisResult(parsed: ReturnType<typeof parseLedger>, s: StatementsPayload, input: AnalyzeInput): AnalysisResult {
  const src = { ...(s.ratios ?? {}), ...(s.kpi ?? {}) };
  const kpis: Kpi[] = [];
  for (const spec of KPI_SPEC) {
    const v = pick(src, spec.keys);
    if (v === undefined) continue;
    kpis.push({ id: spec.id, label: spec.label, value: v, unit: spec.unit === "CCY" ? parsed.currency : spec.unit });
  }

  // Covenants demandés : statut ok/breach sur les KPI présents
  const alerts: string[] = [];
  for (const c of input.covenants ?? []) {
    const k = kpis.find(x => x.id === c.name.toLowerCase().replace(/[^a-z_]/g, "") || x.label.toLowerCase() === c.name.toLowerCase());
    if (!k) { alerts.push(`Covenant « ${c.name} » : KPI non calculable sur cet export.`); continue; }
    const ok = c.operator === ">=" ? k.value >= c.threshold : c.operator === ">" ? k.value > c.threshold
             : c.operator === "<=" ? k.value <= c.threshold : k.value < c.threshold;
    k.threshold = c.threshold; k.status = ok ? "ok" : "breach";
    if (!ok) alerts.push(`${k.label} à ${k.value} ${k.unit}, hors seuil ${c.operator} ${c.threshold} — risque de breach covenant.`);
  }
  for (const w of [...parsed.warnings, ...(s.warnings ?? [])]) alerts.push(w);

  const summary = buildSummary(kpis, parsed, alerts);

  return {
    detected: {
      format: parsed.format,
      chart_of_accounts: "auto",        // détecté par le moteur ; non exposé par /api/statements à ce stade
      currency: parsed.currency,
      period: `${parsed.period_from}..${parsed.period_to}`,
      entries: parsed.entries.length,
    },
    kpis,
    alerts,
    summary_markdown: summary,
    // Brut pour ajuster KPI_SPEC sur un vrai retour — à retirer une fois le mapping validé.
    ...( { raw: { kpi: s.kpi ?? null, ratios: s.ratios ?? null, pl_lines: (s.pl ?? []).length, bs_lines: (s.bs ?? []).length } } as object ),
  } as AnalysisResult;
}

function buildSummary(kpis: Kpi[], parsed: ReturnType<typeof parseLedger>, alerts: string[]): string {
  const g = (id: string) => kpis.find(k => k.id === id);
  const parts: string[] = [];
  const rev = g("revenue"), ebitda = g("ebitda"), margin = g("ebitda_margin"), cash = g("cash"), dscr = g("dscr");
  if (rev) parts.push(`chiffre d'affaires ${fmt(rev)}`);
  if (ebitda) parts.push(`EBITDA ${fmt(ebitda)}${margin ? ` (${margin.value.toFixed(1)} %)` : ""}`);
  if (cash) parts.push(`trésorerie ${fmt(cash)}`);
  const head = parts.length ? `**Synthèse** — ${parts.join(", ")}.` : `**Synthèse** — ${parsed.entries.length} écritures analysées sur ${parsed.period_from} → ${parsed.period_to}.`;
  const breach = kpis.filter(k => k.status === "breach").map(k => k.label);
  const vig = breach.length ? ` Point de vigilance : ${breach.join(", ")} hors covenant.` : dscr && dscr.value < 1.2 ? ` DSCR à ${dscr.value.toFixed(2)} : sous le seuil bancaire usuel de 1,2.` : "";
  const warn = alerts.length && !breach.length ? ` ${alerts.length} avertissement(s) sur la qualité de l'export.` : "";
  return head + vig + warn;
}

function fmt(k: Kpi): string {
  if (k.unit === "%") return `${k.value.toFixed(1)} %`;
  if (k.unit === "days") return `${Math.round(k.value)} j`;
  if (k.unit === "months") return `${k.value.toFixed(1)} mois`;
  if (k.unit === "x") return `${k.value.toFixed(2)}x`;
  try { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: k.unit, maximumFractionDigits: 0 }).format(k.value); }
  catch { return `${Math.round(k.value)} ${k.unit}`; }
}

export { ParseError };
