/**
 * Adaptateur vers le moteur d'analyse K-Phi existant (parsing → mapping → KPI).
 *
 * Remplacez `MockEngine` par une implémentation qui appelle votre moteur
 * (import direct si même codebase, ou HTTP interne sinon). Le reste du serveur
 * ne dépend que de l'interface `AnalysisEngine`.
 */

export type FormatHint =
  | "sage" | "cegid" | "quickbooks" | "xero" | "odoo" | "pennylane"
  | "fec" | "generic" | "auto";

export interface Covenant {
  name: string;
  operator: ">=" | "<=" | ">" | "<";
  threshold: number;
}

export interface AnalyzeInput {
  content: string;
  /** Plan de mapping fourni par l'appelant { champ: en-tête } + amount_mode.
   *  Prime sur l'inférence, champ par champ. */
  column_map?: Record<string, string>;            // CSV/TSV brut
  format_hint: FormatHint;
  period_end?: string;
  covenants?: Covenant[];
  locale: string;
}

export interface Kpi {
  id: string;
  label: string;
  value: number;
  unit: string;               // "EUR", "days", "x", "%"
  status?: "ok" | "warning" | "breach";
  threshold?: number;
  benchmark?: string;         // ex. "p55 secteur"
  formula?: string;
  accounts_used?: string[];
  delta_vs_previous?: number;
}

export interface AnalysisResult {
  detected: {
    format: string;
    chart_of_accounts: string;
    currency: string;
    period: string;
    entries: number;
    /** "ledger" | "trial_balance" | "unknown" — borne les KPI calculables. */
    genre?: string;
    /** Plan de mapping final { champ: en-tête } — à inspecter, et à corriger
     *  via column_map lors d'un rappel. */
    column_map?: Record<string, string>;
    unmapped_headers?: string[];
    name_source?: string;
    overrides_applied?: number;
  };
  kpis: Kpi[];
  /** Série mensuelle (revenue/EBITDA) pour le dashboard — additive, absente sur les moteurs mock/antérieurs. */
  series?: Array<{ period: string; revenue?: number; ebitda?: number }>;
  alerts: string[];
  /** États par défaut attendus, configurables dans K-Φ pour plus de précision
   *  (ex. consolidation non paramétrée, devise unique supposée) — pas des
   *  problèmes. Séparé de `alerts` pour que Claude ne les commente pas comme
   *  des défauts moteur : voir buildNotes() dans engine-http.ts. */
  notes: string[];
  summary_markdown: string;
  /** Rempli par le moteur réel : le tenant K-Phi qui héberge cette analyse,
   *  à réclamer par le prospect (conversion). Absent avec le mock. */
  sandbox?: { tenant_id: string; tenant_name: string; ver: string; open_url?: string };
}

export interface AnalysisEngine {
  analyze(input: AnalyzeInput): Promise<AnalysisResult>;
  /** Pour les gros fichiers déposés via l'upload signé. */
  analyzeFromStorage(storageKey: string, opts: Omit<AnalyzeInput, "content">): Promise<AnalysisResult>;
}

/* ------------------------------------------------------------------ */
/* Mock : permet de faire tourner le serveur et de tester le routage   */
/* dans Claude avant de brancher le vrai moteur.                       */
/* ------------------------------------------------------------------ */

export class MockEngine implements AnalysisEngine {
  async analyze(input: AnalyzeInput): Promise<AnalysisResult> {
    const lines = input.content.split(/\r?\n/).filter(Boolean).length;
    return this.fake(lines, input);
  }

  async analyzeFromStorage(_key: string, opts: Omit<AnalyzeInput, "content">): Promise<AnalysisResult> {
    return this.fake(14230, { ...opts, content: "" });
  }

  private fake(entries: number, input: AnalyzeInput): AnalysisResult {
    const dscrCov = input.covenants?.find(c => c.name.toUpperCase() === "DSCR");
    const dscr = 1.08;
    const kpis: Kpi[] = [
      { id: "revenue", label: "Chiffre d'affaires", value: 3_420_000, unit: "EUR", delta_vs_previous: 0.11 },
      { id: "ebitda", label: "EBITDA", value: 412_000, unit: "EUR", benchmark: "p55 secteur",
        formula: "Résultat d'exploitation + dotations aux amortissements et provisions",
        accounts_used: ["70x", "60x-65x", "681x"] },
      { id: "ebitda_margin", label: "Marge d'EBITDA", value: 12.0, unit: "%" },
      { id: "dso", label: "DSO", value: 58, unit: "days", delta_vs_previous: 12,
        formula: "Créances clients / CA TTC × 365", accounts_used: ["411x", "70x"] },
      { id: "dpo", label: "DPO", value: 41, unit: "days" },
      { id: "working_capital", label: "BFR", value: 486_000, unit: "EUR" },
      { id: "net_debt_ebitda", label: "Dette nette / EBITDA", value: 2.6, unit: "x" },
      { id: "dscr", label: "DSCR", value: dscr, unit: "x",
        formula: "(EBITDA − impôts − capex de maintenance) / service de la dette",
        accounts_used: ["16x", "661x", "695x"],
        ...(dscrCov ? { threshold: dscrCov.threshold, status: dscr >= dscrCov.threshold ? "ok" : "breach" } : {}) },
      { id: "cash_runway", label: "Cash runway", value: 7.4, unit: "months" },
    ];
    const alerts: string[] = [];
    if (dscrCov && dscr < dscrCov.threshold)
      alerts.push(`DSCR sous le seuil de ${dscrCov.threshold} (${dscr}) — risque de breach covenant`);
    alerts.push("DSO en hausse de 12 jours vs période précédente");

    return {
      detected: { format: input.format_hint === "auto" ? "fec" : input.format_hint,
        chart_of_accounts: "PCG", currency: "EUR", period: "2025-01-01..2025-12-31", entries },
      kpis,
      alerts,
      notes: ["Ces chiffres sont une somme simple multi-entités (pas d'élimination des flux intercos). " +
        "Pour une consolidation complète, définissez la structure de groupe dans K-Φ."],
      summary_markdown:
        "**Synthèse** — Activité en croissance (+11 %) avec une marge d'EBITDA de 12 %, " +
        "dans la médiane du secteur. Point de vigilance : le DSCR (1,08) est sous le seuil " +
        "bancaire habituel et le DSO se dégrade (+12 j). Runway de trésorerie ≈ 7 mois.",
    };
  }
}
