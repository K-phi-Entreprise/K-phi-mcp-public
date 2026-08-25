/**
 * KphiHttpEngine — implémentation réelle de AnalysisEngine (Option B, variante
 * "un tenant par analyse", nommé MCP-<XYZ>-<YYYYMMDDHHmmss> côté moteur).
 *
 * Flux par analyse :
 *   1. parse local (parse-ledger.ts) → entries[] normalisées
 *   2. POST /api/internal/sandbox/tenant     → { tenantId, name, token }         [nouveau côté moteur]
 *   3. POST /api/gl/import  { ver, mode: replace, entries }                      [existe]
 *   4. GET  /api/statements?ver=…            → kpi, ratios, pl, bs               [existe]
 *
 * Pas de purge après lecture : le tenant est conservé (24 h par défaut, cron
 * côté moteur) pour que le prospect puisse le RÉCLAMER depuis /a/:analysis_id.
 * La conversion = ajouter un utilisateur à ce tenant, sans déplacer de données.
 *
 * Isolation : un tenant = une analyse = un schéma Postgres. Rien à partager.
 */
import type { AnalysisEngine, AnalysisResult, AnalyzeInput, Kpi } from "./engine.js";
import { parseLedger, ParseError } from "./parse-ledger.js";

export interface KphiHttpEngineConfig {
  baseUrl: string;          // https://k-phi.com (ou l'URL Render du moteur)
  serviceSecret: string;    // = KPHI_SANDBOX_SECRET côté moteur
  timeoutMs?: number;       // défaut 60 s
}

export class KphiHttpEngine implements AnalysisEngine {
  private timeout: number;

  constructor(private cfg: KphiHttpEngineConfig) {
    if (!cfg.baseUrl || !cfg.serviceSecret) throw new Error("KphiHttpEngine: baseUrl et serviceSecret requis");
    this.timeout = cfg.timeoutMs ?? 60_000;
  }

  async analyze(input: AnalyzeInput): Promise<AnalysisResult> {
    /* period_end était accepté par l'outil puis jeté ici : le parseur datait
       alors les fichiers sans colonne date au mois courant. Il alimente
       maintenant l'échelle de résolution des dates (voir parse-ledger.ts). */
    const parsed = parseLedger(input.content, undefined, { periodEnd: input.period_end });
    const sb = await this.createSandbox();

    // Modèle K-Phi : UNE version = UN mois, nommée YYYY-MM. C'est ce que fait
    // l'import-wizard et ce que le cumul (asOf) exige (compare lexicographique
    // sur les noms de version). Une version multi-mois n'est ni cumulée ni
    // sommée par le moteur.
    const byPeriod = new Map<string, typeof parsed.entries>();
    for (const e of parsed.entries) { const l = byPeriod.get(e.period) ?? []; l.push(e); byPeriod.set(e.period, l); }
    const periods = [...byPeriod.keys()].sort();
    for (const per of periods) await this.importVersion(sb.token, per, byPeriod.get(per)!);
    const last = periods[periods.length - 1];

    // Bilan = position cumulée jusqu'au dernier mois (asOf). Ratios de position
    // (trésorerie, dette, liquidité, DSO/DPO) viennent de cette lecture.
    const position = await this.statements(sb.token, { asOf: last });
    // P&L = flux : le moteur le rend par mois quoi qu'il arrive en mode cumulé
    // (voir routes/statements.js, scope.pers). Pour un diagnostic d'exercice on
    // somme les flux mensuels ici — arithmétiquement exact, et cohérent avec ce
    // que le prospect verra ensuite mois par mois dans la plateforme.
    const monthly = periods.length > 1
      ? await Promise.all(periods.map(per => this.statements(sb.token, { ver: per })))
      : [position];

    const result = toAnalysisResult(parsed, position, monthly, input);
    // Lien signé 24 h, lecture seule, ouvre le tenant dans l'app sans login.
    const open_url = await this.openLink(sb.tenantId).catch(e => { console.error("open-link failed", e); return undefined; });
    result.sandbox = { tenant_id: sb.tenantId, tenant_name: sb.name, ver: last, open_url };
    return result;
  }

  async analyzeFromStorage(_storageKey: string, _opts: Omit<AnalyzeInput, "content">): Promise<AnalysisResult> {
    // TODO : lire le fichier depuis l'object storage puis appeler analyze().
    throw new Error("analyzeFromStorage: object storage non branché");
  }

  /* ----------------------------------------------------------------- */

  private async createSandbox(): Promise<{ tenantId: string; name: string; token: string }> {
    const r = await this.fetch("/api/internal/sandbox/tenant", {
      method: "POST",
      headers: { "X-Sandbox-Secret": this.cfg.serviceSecret },
    });
    const j = await r.json() as { tenantId?: string; name?: string; token?: string; error?: string };
    if (!r.ok || !j.token || !j.tenantId) throw new Error(`sandbox tenant: ${r.status} ${j.error ?? ""}`);
    return { tenantId: j.tenantId, name: j.name ?? "", token: j.token };
  }

  /** Lien signé (24 h) qui ouvre le tenant en lecture seule dans l'app K-Φ. */
  async openLink(tenantId: string): Promise<string> {
    const r = await this.fetch("/api/internal/sandbox/open-link", {
      method: "POST",
      headers: { "X-Sandbox-Secret": this.cfg.serviceSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    const j = await r.json() as { url?: string; error?: string };
    if (!r.ok || !j.url) throw new Error(`open-link: ${r.status} ${j.error ?? ""}`);
    return j.url;
  }

  /** Jeton pour relire un tenant sandbox existant (ex. après upload asynchrone). */
  async tokenFor(tenantId: string): Promise<string> {
    const r = await this.fetch("/api/internal/sandbox/token", {
      method: "POST",
      headers: { "X-Sandbox-Secret": this.cfg.serviceSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    const j = await r.json() as { token?: string; error?: string };
    if (!r.ok || !j.token) throw new Error(`sandbox token: ${r.status} ${j.error ?? ""}`);
    return j.token;
  }

  private async importVersion(token: string, ver: string, entries: unknown[]) {
    /* fiscal_year/period_num : renseignés depuis le nom de version YYYY-MM.
       Sans eux, le moteur enregistre la version sans exercice ni période
       (versions.fiscal_year NULL) et la génération de dates synthétiques
       côté plateforme n'a pas d'ancre. Sûr par construction : analyze()
       découpe les écritures par période AVANT chaque import, donc la
       validation « une version = une période » du moteur ne peut pas
       rejeter le lot. */
    const fy = Number(ver.slice(0, 4)), pn = Number(ver.slice(5, 7));
    const r = await this.fetch("/api/gl/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ver, vdate: `${ver}-01`, mode: "replace", version_type: "ACTUALS",
        ...(fy >= 1900 && pn >= 1 ? { fiscal_year: fy, period_num: pn } : {}),
        entries,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(`import ${ver}: ${r.status} ${j.error ?? ""}`);
    }
  }

  private async statements(token: string, scope: { ver?: string; asOf?: string }): Promise<StatementsPayload> {
    const qs = new URLSearchParams();
    if (scope.asOf) qs.set("asOf", scope.asOf); else if (scope.ver) qs.set("ver", scope.ver);
    const r = await this.fetch(`/api/statements?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json() as StatementsPayload & { error?: string; message?: string };
    if (!r.ok) throw new Error(`statements: ${r.status} ${j.error ?? ""} ${j.message ?? ""}`);
    return j;
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    // Le moteur exige X-Requested-With sur tout POST/DELETE /api/* (garde CSRF
    // globale, server.js). N'importe quelle valeur ; absent → 403 avant auth.
    const headers = { "X-Requested-With": "kphi-mcp-public", ...(init.headers as Record<string, string> ?? {}) };
    try {
      return await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers, signal: ctrl.signal });
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
 * Clés réelles observées sur GET /api/statements (modules/kpi.js exécuté
 * serveur, relevé du 2026-08-25) :
 *   kpi    : libellés lisibles — "Net Revenue", "EBITDA", "Net Income",
 *            "Opening Cash", "Total Assets", "Total Liabilities", "Total Equity",
 *            "Gross Profit", "Operating Income", …  + "_sanity" (diagnostics)
 *   ratios : camelCase — dso, dpo, dio, ccc, dscr, ebitdaMargin, netMargin,
 *            grossMargin, debtToEbitda, debtToEquity, currentRatio, quickRatio,
 *            workingCapital, interestCoverage, roe, roa, …  ; non calculable = null
 *            avec la raison dans _<ratio>NA ; + "_warnings" (avertissements)
 * Les noms secondaires restent en repli au cas où kpi.js évolue.
 */
const KPI_SPEC: Array<{ id: string; label: string; unit: string; keys: string[]; na?: string }> = [
  { id: "revenue",         label: "Chiffre d'affaires",   unit: "CCY",   keys: ["Net Revenue", "revenue", "_rev"] },
  { id: "gross_profit",    label: "Marge brute",          unit: "CCY",   keys: ["Gross Profit", "_gross"] },
  { id: "ebitda",          label: "EBITDA",               unit: "CCY",   keys: ["EBITDA", "_ebitda"] },
  { id: "ebitda_margin",   label: "Marge d'EBITDA",       unit: "%",     keys: ["ebitdaMargin"] },
  { id: "operating_income",label: "Résultat d'exploitation", unit: "CCY", keys: ["Operating Income", "_opInc"] },
  { id: "net_income",      label: "Résultat net",         unit: "CCY",   keys: ["Net Income", "_ni"] },
  { id: "net_margin",      label: "Marge nette",          unit: "%",     keys: ["netMargin"] },
  { id: "cash",            label: "Trésorerie",           unit: "CCY",   keys: ["_cash", "Opening Cash"] },
  { id: "working_capital", label: "BFR",                  unit: "CCY",   keys: ["workingCapital"] },
  { id: "dso",             label: "DSO",                  unit: "days",  keys: ["dso"], na: "_dsoNA" },
  { id: "dpo",             label: "DPO",                  unit: "days",  keys: ["dpo"], na: "_dpoNA" },
  { id: "dio",             label: "DIO",                  unit: "days",  keys: ["dio"], na: "_dioNA" },
  { id: "ccc",             label: "Cycle de conversion",  unit: "days",  keys: ["ccc"] },
  { id: "total_debt",      label: "Dette financière",     unit: "CCY",   keys: ["_totalDebt"] },
  { id: "net_debt_ebitda", label: "Dette / EBITDA",       unit: "x",     keys: ["debtToEbitda"] },
  { id: "debt_to_equity",  label: "Dette / Fonds propres", unit: "x",    keys: ["debtToEquity"] },
  { id: "dscr",            label: "DSCR",                 unit: "x",     keys: ["dscr"] },
  { id: "interest_coverage", label: "Couverture des intérêts", unit: "x", keys: ["interestCoverage"] },
  { id: "current_ratio",   label: "Ratio de liquidité",   unit: "x",     keys: ["currentRatio"] },
  { id: "quick_ratio",     label: "Liquidité réduite",    unit: "x",     keys: ["quickRatio"] },
  { id: "total_assets",    label: "Total actif",          unit: "CCY",   keys: ["Total Assets", "_totalAssets"] },
  { id: "total_equity",    label: "Fonds propres",        unit: "CCY",   keys: ["Total Equity", "_totalEquity"] },
  { id: "roe",             label: "ROE",                  unit: "%",     keys: ["roe"] },
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

/** KPI de FLUX (P&L) : sommés sur les lectures mensuelles. Tout le reste est une POSITION lue sur asOf. */
const FLOW_IDS = new Set(["revenue", "gross_profit", "ebitda", "operating_income", "net_income"]);

function toAnalysisResult(parsed: ReturnType<typeof parseLedger>, position: StatementsPayload,
                          monthly: StatementsPayload[], input: AnalyzeInput): AnalysisResult {
  const posK = (position.kpi ?? {}) as Record<string, unknown>;
  const posR = (position.ratios ?? {}) as Record<string, unknown>;
  const posSrc = { ...posR, ...posK };
  const kpis: Kpi[] = [];
  const alerts: string[] = [];
  const notes: string[] = [];
  const nMonths = monthly.length;

  for (const spec of KPI_SPEC) {
    let v: number | undefined;
    if (FLOW_IDS.has(spec.id)) {
      // somme des flux mensuels ; undefined si aucun mois ne le fournit
      let sum = 0, seen = false;
      for (const m of monthly) { const x = pick({ ...(m.ratios ?? {}), ...(m.kpi ?? {}) } as Record<string, unknown>, spec.keys); if (x !== undefined) { sum += x; seen = true; } }
      v = seen ? sum : undefined;
    } else {
      v = pick(posSrc, spec.keys);
    }
    if (v === undefined) {
      const why = spec.na ? posR[spec.na] : undefined;
      if (typeof why === "string" && why) alerts.push(`${spec.label} non calculable (${why}).`);
      continue;
    }
    kpis.push({ id: spec.id, label: spec.label, value: v, unit: spec.unit === "CCY" ? parsed.currency : spec.unit });
  }

  // Ratios flux/position recalculés sur l'exercice (le moteur les rend par mois).
  const g = (id: string) => kpis.find(k => k.id === id);
  const set = (id: string, value: number) => { const k = g(id); if (k) k.value = value; };
  const rev = g("revenue")?.value, ebitda = g("ebitda")?.value, ni = g("net_income")?.value;
  const debt = g("total_debt")?.value, equity = g("total_equity")?.value;
  if (rev && ebitda !== undefined) set("ebitda_margin", ebitda / rev);
  if (rev && ni !== undefined) set("net_margin", ni / rev);
  if (ebitda && debt !== undefined) set("net_debt_ebitda", debt / ebitda);
  if (equity && ni !== undefined) set("roe", ni / equity);
  // Les ratios en % arrivent en fraction (0.22) : normalisés ici, une seule fois.
  for (const k of kpis) if (k.unit === "%" && Math.abs(k.value) <= 5) k.value = k.value * 100;
  for (const k of kpis) k.value = Math.round(k.value * 100) / 100;

  // kpi._sanity : vraies anomalies détectées par le moteur (CA négatif, DR/CR
  // inversés…) — restent dans `alerts`, ce sont des problèmes à corriger.
  const sanity = Array.isArray(posK._sanity) ? posK._sanity as Array<{ severity?: string; metric?: string; msg?: string }> : [];
  for (const d of sanity) if (d?.msg) alerts.push(`[${d.severity ?? "info"}] ${d.metric ? d.metric + " — " : ""}${d.msg}`);

  // ratios._warnings : états par défaut du moteur (pas de structure de groupe
  // configurée, etc.) — ce sont des choses à AFFINER dans K-Φ, pas des erreurs.
  // Mappées en français plutôt que de repasser le texte anglais brut ; repli
  // sur le texte moteur si un type de warning encore inconnu apparaît.
  const rw = Array.isArray(posR._warnings) ? posR._warnings as Array<{ metric?: string; msg?: string }> : [];
  for (const d of rw) {
    if (d?.metric === "Consolidation") {
      notes.push("Ces chiffres sont une somme simple multi-entités (pas d'élimination des flux " +
        "intercos). Pour une consolidation complète, définissez la structure de groupe dans K-Φ " +
        "(Réglages → Organisation → Structure de groupe).");
    } else if (d?.msg) {
      notes.push(`${d.metric ? d.metric + " — " : ""}${d.msg} (réglable dans K-Φ)`);
    }
  }
  // Devise : le moteur/parseur retiennent une devise unique tant qu'aucun
  // mapping multi-devises n'est configuré. Vrai par défaut, pas une erreur.
  for (const w of parsed.warnings) {
    if (/devise|currency/i.test(w)) notes.push(`${w} Affinable dans K-Φ si vos comptes couvrent plusieurs devises.`);
    else alerts.push(w);   // ex. déséquilibre DR/CR : un vrai problème de fichier
  }
  if (nMonths > 1) notes.push(`Exercice : P&L sommé sur ${nMonths} mois (${parsed.period_from} → ${parsed.period_to}), bilan au ${parsed.period_to}.`);

  for (const c of input.covenants ?? []) {
    const key = c.name.toLowerCase().replace(/[^a-z_]/g, "");
    const k = kpis.find(x => x.id === key || x.label.toLowerCase() === c.name.toLowerCase());
    if (!k) { alerts.push(`Covenant « ${c.name} » : KPI non calculable sur cet export.`); continue; }
    const ok = c.operator === ">=" ? k.value >= c.threshold : c.operator === ">" ? k.value > c.threshold
             : c.operator === "<=" ? k.value <= c.threshold : k.value < c.threshold;
    k.threshold = c.threshold; k.status = ok ? "ok" : "breach";
    if (!ok) alerts.push(`${k.label} à ${k.value} ${k.unit}, hors seuil ${c.operator} ${c.threshold} — risque de breach covenant.`);
  }
  for (const w of position.warnings ?? []) alerts.push(w);

  return {
    detected: { format: parsed.format, chart_of_accounts: "auto", currency: parsed.currency,
                period: `${parsed.period_from}..${parsed.period_to}`, entries: parsed.entries.length },
    kpis, alerts, notes,
    summary_markdown: buildSummary(kpis, parsed, alerts),
  };
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
