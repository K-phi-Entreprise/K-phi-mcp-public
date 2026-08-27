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
  retryDelayMs?: number;    // défaut 1 500 ms (injectable pour les tests)
  /** Lecture du stockage d'upload (voir upload-storage.ts). Sans lui,
   *  analyzeFromStorage refuse — jamais de fichier accepté puis perdu. */
  storageRead?: (key: string) => Promise<string>;
  /** Cap d'écritures de l'analyse anonyme. DOIT refléter SANDBOX_MAX_ENTRIES
   *  côté moteur (200 000 par défaut) : mieux vaut un refus clair ici qu'un
   *  429 « Entry limit exceeded » à mi-import, présenté comme une erreur
   *  moteur par la taxonomie. */
  maxSandboxEntries?: number;
}

/** Limite PRODUIT (pas un fichier illisible, pas une panne moteur) : la
 *  taxonomie la présente telle quelle, sans le préfixe « Impossible de
 *  lire ce fichier ». */
export class LimitError extends ParseError {
  constructor(msg: string) { super(msg); this.name = "LimitError"; }
}

/** Échec CÔTÉ MOTEUR (5xx, réseau) — à ne jamais présenter comme un problème
 *  de fichier. Historique : un 500 du wrapper générique du moteur ressortait
 *  en « Vérifiez qu'il s'agit d'un export comptable » — double blanchiment
 *  d'erreur (le wrapper efface la cause, le MCP accuse le fichier). */
export class EngineError extends Error {
  constructor(msg: string, public status?: number) { super(msg); this.name = "EngineError"; }
}

export class KphiHttpEngine implements AnalysisEngine {
  private timeout: number;

  constructor(public cfg: KphiHttpEngineConfig) {
    if (!cfg.baseUrl || !cfg.serviceSecret) throw new Error("KphiHttpEngine: baseUrl et serviceSecret requis");
    this.timeout = cfg.timeoutMs ?? 60_000;
  }

  async analyze(input: AnalyzeInput): Promise<AnalysisResult> {
    /* period_end était accepté par l'outil puis jeté ici : le parseur datait
       alors les fichiers sans colonne date au mois courant. Il alimente
       maintenant l'échelle de résolution des dates (voir parse-ledger.ts). */
    const parsed = parseLedger(input.content, undefined, {
      periodEnd: input.period_end,
      analyticAxis: input.analytic_axis,
      columnMap: input.column_map as never,
    });
    const cap = this.cfg.maxSandboxEntries ?? Number(process.env.KPHI_SANDBOX_MAX_ENTRIES ?? 200000);
    if (parsed.entries.length > cap)
      throw new LimitError(
        `L'analyse anonyme est limitée à ${cap.toLocaleString("fr-FR")} écritures ; ce fichier en contient ` +
        `${parsed.entries.length.toLocaleString("fr-FR")}. Agrégez l'export (ex. balance mensuelle par compte, ` +
        `ou un exercice à la fois), ou créez un compte K-Φ pour l'import complet.`);
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

    /* Seed des intitulés de compte AVANT les lectures statements : cfg.coa
       est la première source des libellés d'états ET une entrée de
       classifyAcct — les KPI lus juste après en profitent. Best-effort :
       un moteur sans le endpoint (404) ou un échec réseau n'invalide pas
       l'analyse, header_text par écriture couvre déjà l'affichage. */
    let fcRulesSeeded = 0;
    const coa = parsed.coa_dict ?? {};
    if (Object.keys(coa).length > 0) {
      try {
        const r = await this.fetch("/api/internal/sandbox/coa", {
          method: "POST",
          headers: { "X-Sandbox-Secret": this.cfg.serviceSecret, "Content-Type": "application/json" },
          /* gen_fc_rules : le moteur synthétise ses règles de flux de la
             classification (#162) — sans elles, tout sandbox bloque en
             no_rules. fc_rules>0 → note de provenance sur le résultat. */
          body: JSON.stringify({ tenantId: sb.tenantId, coa, gen_fc_rules: true }),
        });
        if (!r.ok) console.warn(`coa seed: ${r.status} (non bloquant)`);
        else { try { fcRulesSeeded = ((await r.json()) as { fc_rules?: number }).fc_rules ?? 0; } catch { /* réponse sans corps : tolérée */ } }
      } catch (e) {
        console.warn("coa seed failed (non bloquant):", e instanceof Error ? e.message : e);
      }
    }

    // Bilan = position cumulée jusqu'au dernier mois (asOf). Ratios de position
    // (trésorerie, dette, liquidité, DSO/DPO) viennent de cette lecture.
    const position = await this.statements(sb.token, { asOf: last, fc: true, horizon: 6 });
    // P&L = flux : le moteur le rend par mois quoi qu'il arrive en mode cumulé
    // (voir routes/statements.js, scope.pers). Pour un diagnostic d'exercice on
    // somme les flux mensuels ici — arithmétiquement exact, et cohérent avec ce
    // que le prospect verra ensuite mois par mois dans la plateforme.
    const monthly = periods.length > 1
      ? await Promise.all(periods.map(per => this.statements(sb.token, { ver: per })))
      : [position];

    /* ── Forecast PAR PÉRIMÈTRE (SPEC ★, critères 2/3/5) : un appel fc par
       scope — runEngine tourne sur les lignes du scope, l'impliedDSO/DPO des
       lignes est celui DU SCOPE, dérivé du GL. Le connecteur RELAIE, il ne
       calcule rien. Plafond 12 appels (8 entités + 4 BU) pour rester ~1 s. */
    const _posRa = (position.ratios ?? {}) as Record<string, Record<string, unknown>>;
    /* Périmètres = union parseur ∪ moteur : le moteur sait quelles entités
       vivent dans le GL même quand le parseur a rangé la colonne autrement. */
    const entScopes = [...new Set([
      ...parsed.entries.map(e => e.entity).filter((x): x is string => !!x),
      ...Object.keys(_posRa["_dsoByEntity"] ?? {}),
    ])].slice(0, 8);
    /* BU = union parseur ∪ moteur (le parseur voit la colonne, le moteur voit
       ce qu'il a su rattacher) — cap 6, même logique que les entités. */
    const buScopes = [...new Set([...(parsed.bus ?? []), ...Object.keys(_posRa["_dsoByBU"] ?? {})])].slice(0, 6);
    const fcScope = async (p: { entity?: string; bu?: string }) => {
      try { const s = await this.statements(sb.token, { asOf: last, ...p, fc: true, horizon: 6 });
            return { fc: s.fc ?? [], blocked: s.fcBlocked ?? null }; }
      catch { return { fc: [], blocked: { reason: "scope_call_failed" } }; }
    };
    const [entFc, buFc] = await Promise.all([
      Promise.all(entScopes.map(en => fcScope({ entity: en }))),
      Promise.all(buScopes.map(b => fcScope({ bu: b }))),
    ]);

    const result = toAnalysisResult(parsed, position, monthly, input, periods);
    result.forecast = buildForecast(position, entScopes, entFc, buScopes, buFc);
    /* Noms lisibles : le dashboard affiche « 1000 — Meridian France » plutôt
       qu'un code nu, quand l'export porte les deux colonnes. */
    if (Object.keys(parsed.entityNames ?? {}).length) result.entity_names = parsed.entityNames;
    /* Axes analytiques : celui utilisé + tous ceux disponibles, pour que
       l'appelant sache qu'il peut relancer sur « Cost center » ou « Project ». */
    result.analytic_axis = parsed.analytic_axis;
    result.analytic_axes = parsed.analytic_axes;
    if ((parsed.analytic_axes?.length ?? 0) > 1) {
      const others = parsed.analytic_axes.filter(a => a.column !== parsed.analytic_axis?.column).map(a => a.label);
      result.notes.push(`Axe analytique utilisé : ${parsed.analytic_axis?.label} (colonne « ${parsed.analytic_axis?.column} »). Autres axes détectés dans cet export : ${others.join(", ")} — relancez avec analytic_axis="<axe>" pour découper dessus.`);
    }
    result.report_version = "1.1";
    result.locale = input.locale === "fr" ? "fr" : "en";
    if (fcRulesSeeded > 0)
      result.notes.push(`Règles de flux générées automatiquement de la classification du GL (${fcRulesSeeded} règles : créances→DSO, fournisseurs→DPO, intérêts, taxes, paie) — les DSO/DPO appliqués sont dérivés des écritures du périmètre ; ajustables dans K-Φ.`);
    // Lien signé 24 h, lecture seule, ouvre le tenant dans l'app sans login.
    const open_url = await this.openLink(sb.tenantId).catch(e => { console.error("open-link failed", e); return undefined; });
    result.sandbox = { tenant_id: sb.tenantId, tenant_name: sb.name, ver: last, open_url };
    return result;
  }

  async analyzeFromStorage(storageKey: string, opts: Omit<AnalyzeInput, "content">): Promise<AnalysisResult> {
    if (!this.cfg.storageRead)
      throw new EngineError("analyzeFromStorage: stockage objet non configuré sur ce déploiement");
    const content = await this.cfg.storageRead(storageKey);
    return this.analyze({ content, ...opts } as AnalyzeInput);
  }

  /* ----------------------------------------------------------------- */

  private async createSandbox(): Promise<{ tenantId: string; name: string; token: string }> {
    const r = await this.fetch("/api/internal/sandbox/tenant", {
      method: "POST",
      headers: { "X-Sandbox-Secret": this.cfg.serviceSecret },
    });
    const j = await r.json() as { tenantId?: string; name?: string; token?: string; error?: string };
    if (!r.ok || !j.token || !j.tenantId) throw new EngineError(`sandbox tenant: ${r.status} ${j.error ?? ""}`.trim(), r.status);
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
    const r = await this.fetchRetry("/api/gl/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ver, vdate: `${ver}-01`, mode: "replace", version_type: "ACTUALS",
        ...(fy >= 1900 && pn >= 1 ? { fiscal_year: fy, period_num: pn } : {}),
        entries,
      }),
    }, `import ${ver}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { error?: string };
      throw new EngineError(`import ${ver}: ${r.status} ${j.error ?? ""}`, r.status);
    }
  }

  private async statements(token: string, scope: { ver?: string; asOf?: string; entity?: string; bu?: string; fc?: boolean; horizon?: number }): Promise<StatementsPayload> {
    const qs = new URLSearchParams();
    if (scope.asOf) qs.set("asOf", scope.asOf); else if (scope.ver) qs.set("ver", scope.ver);
    if (scope.entity) qs.set("entity", scope.entity);
    if (scope.bu) qs.set("bu", scope.bu);
    if (scope.fc) { qs.set("fc", "1"); qs.set("horizon", String(scope.horizon ?? 6)); }
    const r = await this.fetchRetry(`/api/statements?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } }, "statements");
    const j = await r.json() as StatementsPayload & { error?: string; message?: string };
    if (!r.ok) throw new EngineError(`statements: ${r.status} ${j.error ?? ""} ${j.message ?? ""}`.trim(), r.status);
    return j;
  }

  /** Un POST /api/gl/import sur un tenant sandbox neuf est idempotent
   *  (mode replace, tenant jeté si l'analyse échoue) : un 5xx transitoire —
   *  course d'initialisation de schéma, pool — mérite UNE nouvelle tentative
   *  automatique avant de remonter. C'est le « try again » que l'utilisateur
   *  tapait à la main. */
  private async fetchRetry(path: string, init: RequestInit, label: string): Promise<Response> {
    let last: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, this.cfg.retryDelayMs ?? 1500));
      try {
        const r = await this.fetch(path, init);
        if (r.status < 500) return r;
        const j = await r.clone().json().catch(() => ({})) as { error?: string };
        last = new EngineError(`${label}: ${r.status} ${j.error ?? ""}`.trim(), r.status);
      } catch (e) {
        if (e instanceof EngineError) { last = e; continue; }
        last = new EngineError(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw last;
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
  fc?: Array<Record<string, unknown>>;
  fcBlocked?: { reason?: string; kind?: string | null; period?: string | null } | null;
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
/* ── Résolution des identifiants de covenant (revue terrain n°5) ──
   Le matching brut « nom → id » échouait sur les exemples de notre propre
   description d'outil (« Gearing », « Dette nette/EBITDA »). Normalisation
   (minuscules, accents pliés, non-alphanumériques retirés) + table d'alias
   FR/EN/DE. La variante NETTE porte une sémantique propre (net: true). */
const COVENANT_IDS = "dscr, interest_coverage, net_debt_ebitda, debt_to_equity, current_ratio, quick_ratio, ebitda_margin, net_margin, dso, dpo, dio, ccc, roe";
function _covNorm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
const COVENANT_ALIASES: Record<string, { id: string; net?: boolean }> = {
  dscr: { id: "dscr" }, debtservicecoverage: { id: "dscr" }, debtservicecoverageratio: { id: "dscr" },
  interestcover: { id: "interest_coverage" }, interestcoverage: { id: "interest_coverage" },
  couverturedesinterets: { id: "interest_coverage" }, couvertureinterets: { id: "interest_coverage" }, zinsdeckung: { id: "interest_coverage" },
  gearing: { id: "debt_to_equity" }, debtequity: { id: "debt_to_equity" }, debttoequity: { id: "debt_to_equity" },
  dettefondspropres: { id: "debt_to_equity" }, dettesurfondspropres: { id: "debt_to_equity" }, verschuldungsgrad: { id: "debt_to_equity" },
  debtebitda: { id: "net_debt_ebitda" }, debttoebitda: { id: "net_debt_ebitda" }, detteebitda: { id: "net_debt_ebitda" },
  dettesurebitda: { id: "net_debt_ebitda" }, leverage: { id: "net_debt_ebitda" }, levier: { id: "net_debt_ebitda" },
  netdebtebitda: { id: "net_debt_ebitda", net: true }, netdebttoebitda: { id: "net_debt_ebitda", net: true },
  dettenetteebitda: { id: "net_debt_ebitda", net: true }, dettenettesurebitda: { id: "net_debt_ebitda", net: true },
  currentratio: { id: "current_ratio" }, ratiodeliquidite: { id: "current_ratio" }, ratioliquidite: { id: "current_ratio" }, liquiditegenerale: { id: "current_ratio" },
  quickratio: { id: "quick_ratio" }, liquiditereduite: { id: "quick_ratio" }, acidtest: { id: "quick_ratio" },
  ebitdamargin: { id: "ebitda_margin" }, margeebitda: { id: "ebitda_margin" }, margedebitda: { id: "ebitda_margin" },
  netmargin: { id: "net_margin" }, margenette: { id: "net_margin" },
  dso: { id: "dso" }, dpo: { id: "dpo" }, dio: { id: "dio" }, ccc: { id: "ccc" }, roe: { id: "roe" },
};
export function resolveCovenantMetric(name: string): { id: string; net?: boolean } | null {
  /* L'id canonique VERBATIM désigne le KPI tel qu'affiché — priorité absolue.
     Nécessaire car l'id historique « net_debt_ebitda » porte une valeur BRUTE :
     normalisé, il tomberait dans l'alias net:true. La version nette s'obtient
     par les alias en toutes lettres (« Dette nette/EBITDA », « Net debt/EBITDA »). */
  for (const spec of KPI_SPEC) if (spec.id === name.trim()) return { id: spec.id };
  const n = _covNorm(name);
  if (COVENANT_ALIASES[n]) return COVENANT_ALIASES[n];
  /* id canonique tel quel ("net_debt_ebitda" → normalisé sans underscores) */
  for (const spec of KPI_SPEC) if (_covNorm(spec.id) === n || _covNorm(spec.label) === n) return { id: spec.id };
  return null;
}

/* Relais des lignes FC_PROJ : champs moteur conservés tels quels (critère 5 :
   zéro calcul MCP) ; seuls les champs privés lourds (_flowDetails, _bgt…)
   sont élagués pour garder le résultat persisté léger. */
const FC_KEEP = ["period", "sales", "amtSource", "arOpen", "collections", "arClose", "impliedDSO",
  "purchases", "apOpen", "payments", "apClose", "impliedDPO", "payroll", "opex", "tax", "interest"] as const;
function slimFc(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map(r => { const o: Record<string, unknown> = {}; for (const k of FC_KEEP) if (k in r) o[k] = r[k]; return o; });
}
type WcMap = Record<string, { dso?: number; dpo?: number; _denomSource?: string; [k: string]: unknown }>;
export function buildForecast(position: { fc?: Array<Record<string, unknown>>; fcBlocked?: unknown; ratios?: Record<string, unknown> | null },
                              ents: string[], entFc: Array<{ fc: Array<Record<string, unknown>>; blocked: unknown }>,
                              bus: string[], buFc: Array<{ fc: Array<Record<string, unknown>>; blocked: unknown }>) {
  const ra = (position.ratios ?? {}) as Record<string, WcMap>;
  const meth = (m: WcMap | undefined, key: "dso" | "dpo") => {
    const out: Record<string, { value: number; source: string; basis?: number }> = {};
    for (const [k, v] of Object.entries(m ?? {})) {
      const val = (v as Record<string, unknown>)[key];
      if (typeof val === "number" && isFinite(val)) {
        /* basis = CA (dso) ou achats (dpo) du périmètre, calculés par le
           moteur — relayés pour le drill réel-vs-projeté du dashboard. */
        const basis = (v as Record<string, unknown>)[key === "dso" ? "rev" : "cogs"];
        out[k] = { value: Math.round(val), source: v._denomSource === "gl" ? "gl_observed" : "fallback",
                   ...(typeof basis === "number" && isFinite(basis) ? { basis } : {}) };
      }
    }
    return out;
  };
  return {
    horizon_months: 6,
    global: { series: slimFc(position.fc ?? []), blocked: position.fcBlocked ?? null },
    by_entity: Object.fromEntries(ents.map((e, i) => [e, { series: slimFc(entFc[i].fc), blocked: entFc[i].blocked }])),
    by_bu: Object.fromEntries(bus.map((b, i) => [b, { series: slimFc(buFc[i].fc), blocked: buFc[i].blocked }])),
    methods: {
      dso_by_entity: meth(ra._dsoByEntity, "dso"), dpo_by_entity: meth(ra._dpoByEntity, "dpo"),
      dso_by_bu: meth(ra._dsoByBU, "dso"), dpo_by_bu: meth(ra._dpoByBU, "dpo"),
    },
  };
}

const FLOW_IDS = new Set(["revenue", "gross_profit", "ebitda", "operating_income", "net_income"]);

function toAnalysisResult(parsed: ReturnType<typeof parseLedger>, position: StatementsPayload,
                          monthly: StatementsPayload[], input: AnalyzeInput,
                          periods: string[] = []): AnalysisResult {
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

  /* Couverture des intérêts & DSCR — MÊME base exercice que les autres ratios
     dérivés ci-dessus (retour terrain n°4 : la valeur position était le ratio
     du DERNIER MOIS avec un dénominateur en résultat financier NET — les
     gains de change compensaient les intérêts : 15,9x affiché contre 5,9x
     réel). Numérateur : EBITDA exercice déjà sommé ; dénominateur : intérêts
     PURS sommés sur les mois (_intExpPure, repli _intExp). DSCR sans
     échéancier de principal = approximation documentée (+10 % de la dette
     court terme, convention moteur), signalée en note. */
  const F = (x: number) => Math.round(x).toLocaleString("fr-FR");
  /* Série mensuelle persistée (dashboard /a/:id) : additive au contrat 1.0. */
  const series: Array<{ period: string; revenue?: number; ebitda?: number }> = [];
  monthly.forEach((m, i) => {
    const kk = (m.kpi ?? {}) as Record<string, unknown>;
    series.push({ period: periods[i] ?? `M${i + 1}`,
      revenue: pick(kk, ["Net Revenue"]), ebitda: pick(kk, ["EBITDA"]) });
  });
  let intPureFY = 0, intNetFY = 0, intSeen = false;
  for (const m of monthly) {
    const ra = (m.ratios ?? {}) as Record<string, unknown>;
    const p = pick(ra, ["_intExpPure"]); const n = pick(ra, ["_intExp"]);
    if (p !== undefined || n !== undefined) intSeen = true;
    if (p !== undefined) intPureFY += p;
    if (n !== undefined) intNetFY += n;
  }
  /* moteur antérieur au fix « intérêts purs » : _intExpPure vaut 0 partout
     alors que des intérêts existent — on utilise le NET en le disant, on ne
     retire jamais le ratio à tort */
  const intPure = intPureFY > 0;
  const intFY = intPure ? intPureFY : intNetFY;
  const ltDebt = pick(posSrc, ["_ltDebt"]);
  const stDebt = debt !== undefined && ltDebt !== undefined ? Math.max(0, debt - ltDebt) : 0;
  if (!intSeen) {
    /* payloads sans _intExpPure (moteur antérieur, mock) : on n'invente rien,
       les valeurs position restent telles quelles */
  } else if (intFY > 0 && ebitda !== undefined) {
    set("interest_coverage", ebitda / intFY);
    const cov = g("interest_coverage");
    if (cov) cov.formula = intPure
      ? `EBITDA exercice ${F(ebitda)} ÷ intérêts purs exercice ${F(intFY)} (hors résultat de change)`
      : `EBITDA exercice ${F(ebitda)} ÷ résultat financier net exercice ${F(intFY)} (intérêts non isolés par le moteur)`;
    const svc = intFY + stDebt * 0.1;
    set("dscr", ebitda / svc);
    const d = g("dscr");
    if (d) d.formula = `EBITDA exercice ${F(ebitda)} ÷ (intérêts ${F(intFY)} + 10 % dette CT ${F(stDebt)}) — approximation sans échéancier de principal`;
    if (stDebt > 0) notes.push("DSCR approximé : sans échéancier de remboursement, le service de la dette = intérêts + 10 % de la dette court terme.");
  } else if (intSeen && (g("interest_coverage") || g("dscr"))) {
    /* pas d'intérêts dans l'exercice : un ratio de couverture n'a pas de sens */
    for (const id of ["interest_coverage", "dscr"]) { const i = kpis.findIndex(k => k.id === id); if (i >= 0) kpis.splice(i, 1); }
    notes.push("Couverture des intérêts / DSCR non affichés : aucune charge d'intérêts détectée sur l'exercice.");
  }
  if (ebitda && debt !== undefined) { const k = g("net_debt_ebitda"); if (k) k.formula = `dette financière ${F(debt)} ÷ EBITDA exercice ${F(ebitda)}`; }
  const covr = g("ebitda_margin"); if (covr && rev) covr.formula = `EBITDA exercice ÷ chiffre d'affaires exercice ${F(rev)}`;
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
      if (parsed.entities.length > 1) notes.push("Aperçu multi-entités : les vues par entité (forecast, méthodes DSO/DPO) restent " +
        "chacune en devise locale et sont fiables telles quelles ; la consolidation complète (conversion FX à vos taux, " +
        "élimination intercos) est disponible dans K-Φ sur ce même tenant une fois l'analyse réclamée. " +
        "Les chiffres agrégés ci-dessous sont une somme simple (pas d'élimination des flux " +
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

  /* ── Garde de genre : une balance ne porte pas le détail des écritures ──
     Placée AVANT les covenants : un covenant DSCR sur une balance doit
     répondre « non calculable sur cet export », pas breach. Le retrait de
     dscr supprime aussi, mécaniquement, la ligne de vigilance DSCR de la
     synthèse. Cas fondateur : une balance annuelle équilibrée analysée
     comme un grand livre d'un mois → DSCR −20,4 annoncé sous seuil. */
  if (parsed.genre === "trial_balance") {
    const iDscr = kpis.findIndex(k => k.id === "dscr");
    if (iDscr >= 0) {
      kpis.splice(iDscr, 1);
      alerts.push("DSCR non calculé : l'export est une balance (soldes par compte et période), " +
        "pas un grand livre — ce ratio exige le détail des écritures (service de la dette, flux).");
    }
    if (kpis.some(k => ["dso", "dpo", "dio", "ccc"].includes(k.id)))
      notes.push("DSO/DPO/DIO/CCC calculés sur les soldes de la balance (pas de détail facture) : " +
        "des ordres de grandeur, pas des délais réels de règlement.");
  }

  for (const c of input.covenants ?? []) {
    const res = resolveCovenantMetric(c.name);
    if (!res) {
      alerts.push(`Covenant « ${c.name} » : identifiant non reconnu. Identifiants acceptés : ${COVENANT_IDS} ` +
        `(alias FR/EN tolérés, ex. Gearing, Dette nette/EBITDA, Couverture des intérêts).`);
      continue;
    }
    let k = kpis.find(x => x.id === res.id);
    if (k && res.net) {
      /* Dette NETTE / EBITDA : sémantique distincte du ratio brut affiché —
         (dette − trésorerie) / EBITDA, exposée comme KPI à part entière
         plutôt qu'écrasée sur le brut (revue terrain n°5 : gross vs net). */
      const cash = kpis.find(x => x.id === "cash")?.value;
      const debtV = kpis.find(x => x.id === "total_debt")?.value;
      const eb = kpis.find(x => x.id === "ebitda")?.value;
      if (cash !== undefined && debtV !== undefined && eb) {
        const netK: Kpi = { id: "net_debt_ebitda_net", label: "Dette nette / EBITDA", unit: "x",
          value: (debtV - cash) / eb,
          formula: `(dette ${Math.round(debtV).toLocaleString("fr-FR")} − trésorerie ${Math.round(cash).toLocaleString("fr-FR")}) ÷ EBITDA exercice` };
        kpis.push(netK); k = netK;
      }
    }
    if (!k) { alerts.push(`Covenant « ${c.name} » (${res.id}) : KPI non calculable sur cet export.`); continue; }
    const ok = c.operator === ">=" ? k.value >= c.threshold : c.operator === ">" ? k.value > c.threshold
             : c.operator === "<=" ? k.value <= c.threshold : k.value < c.threshold;
    k.threshold = c.threshold; k.status = ok ? "ok" : "breach";
    if (!ok) alerts.push(`${k.label} à ${k.value.toFixed(2)} ${k.unit}, hors seuil ${c.operator} ${c.threshold} — risque de breach covenant.`);
  }
  for (const w of position.warnings ?? []) alerts.push(w);

  return {
    series,
    detected: { format: parsed.format, chart_of_accounts: "auto", currency: parsed.currency,
                period: `${parsed.period_from}..${parsed.period_to}`, entries: parsed.entries.length,
                genre: parsed.genre, column_map: parsed.column_map,
                unmapped_headers: parsed.unmapped_headers, name_source: parsed.name_source,
                overrides_applied: parsed.overrides_applied },
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
