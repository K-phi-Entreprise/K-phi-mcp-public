/**
 * Parseur d'export comptable brut → écritures normalisées K-Phi
 * ({ acct, dr, cr, date, period, entity, desc, ccy, entry_id, tp }).
 *
 * Existe ici parce que le parsing du moteur vit dans le navigateur
 * (modules/import-wizard.js) : il n'y a pas de parseur serveur réutilisable.
 *
 * Deux formats à ce stade :
 *   - FEC (art. A.47 A-1 LPF) : 18 colonnes fixes, séparateur tab ou |, dates AAAAMMJJ,
 *     décimales virgule. Le plus fréquent en France et 100 % déterministe.
 *   - CSV générique : détection d'en-têtes par synonymes (compte/account, débit/debit…).
 *     Couvre Sage 50/100, Cegid, Pennylane, QuickBooks, Xero, Odoo en export standard.
 *
 * Volontairement conservateur : une colonne non reconnue est ignorée, jamais devinée.
 * Le moteur détecte le plan de comptes lui-même (detectScheme) ; ici on livre des
 * écritures propres, rien de plus.
 */

export interface LedgerEntry {
  acct: string;
  dr: number;
  cr: number;
  date: string;      // YYYY-MM-DD
  period: string;    // YYYY-MM
  entity: string;
  desc: string;
  ccy: string;
  entry_id: string;
  tp?: string;
  ref?: string;
  /** Intitulé STABLE du compte (pas le mémo de la ligne). Colonne
   *  gl_entries.header_text : 2e source des libellés d'états dans
   *  buildPLForVer_T (après CFG.coa[acct].nm, avant le mémo). */
  header_text?: string;
  /** Date générée (colonne période / period_end), pas lue dans le fichier.
   *  Repris tel quel par le moteur (colonne gl_entries.is_synth_date) : le
   *  GL Explorer marque ces écritures, comme pour les ERP sans dates
   *  (Hyperion). Jamais de date inventée sans ce marqueur. */
  _is_synth_date?: boolean;
}

/** Contexte fourni par l'appelant (paramètres de l'outil MCP). */
export interface ParseOpts {
  /** Date de clôture YYYY-MM-DD — dernier échelon de résolution des dates. */
  periodEnd?: string;
  /** Plan de mapping fourni par l'APPELANT : { champ: en-tête }. Le modèle
   *  qui appelle l'outil lit n'importe quel en-tête dans n'importe quelle
   *  langue — c'est la voie agnostique quand l'inférence se trompe. Les
   *  champs fournis PRIMENT sur l'inférence ; les autres restent inférés.
   *  amount_mode force le sens du montant unique (signed_inv : positif =
   *  crédit, convention PCG/Cegid — indétectable sans classification). */
  columnMap?: Partial<Record<keyof typeof SYN, string>> & { amount_mode?: "dual" | "signed" | "signed_inv" | "single" };
}

export interface ParseResult {
  format: "fec" | "csv";
  entries: LedgerEntry[];
  entities: string[];
  currency: string;
  period_from: string;
  period_to: string;
  dropped: number;         // lignes ignorées (vides, en-tête, non parsables)
  warnings: string[];
  /** Plan de mapping FINAL { champ: en-tête }, overrides inclus — renvoyé
   *  pour être inspecté et corrigé (rappel avec column_map). */
  column_map: Record<string, string>;
  /** En-têtes non mappés (hors colonnes-pièges) : matière première d'une
   *  correction par l'appelant. */
  unmapped_headers: string[];
  /** Provenance des intitulés de compte : mapped | adopted | demoted | none. */
  name_source: "mapped" | "adopted" | "demoted" | "none";
  /** Nombre de champs forcés par column_map. */
  overrides_applied: number;
  /** Genre structurel de l'export — détecté sur la FORME, pas sur l'en-tête :
   *  un grand livre a plusieurs lignes par (compte, période) et porte des
   *  références de pièces/tiers ; une balance a ~1 ligne par (compte, période)
   *  et n'en porte pas. Une balance équilibrée passait pour un grand livre
   *  d'un mois : DSO 9,5 j, DSCR −20 présenté en breach. Le genre borne les
   *  KPI calculables (voir engine-http.toAnalysisResult). */
  genre: "ledger" | "trial_balance" | "unknown";
  /** compte → intitulé stable. Sert deux usages : header_text par écriture
   *  (libellés d'états immédiats) et, en Phase 2, l'amorçage de cfg.coa côté
   *  moteur (source n°1 des libellés + meilleure entrée pour classifyAcct).
   *  Construit uniquement si une colonne passe le test de dépendance
   *  fonctionnelle compte→libellé — jamais depuis des mémos de ligne. */
  coa_dict: Record<string, string>;
}

export class ParseError extends Error {
  constructor(msg: string) { super(msg); this.name = "ParseError"; }
}

/** Le fichier est lisible mais il manque une information que l'appelant peut
 *  fournir (ex. period_end quand il n'y a ni date ni période exploitables).
 *  Étend ParseError pour que les appelants existants restent corrects ;
 *  tools.ts la présente comme une question structurée, pas comme un échec. */
export class NeedsInputError extends ParseError {
  needs: string[];
  constructor(msg: string, needs: string[]) { super(msg); this.name = "NeedsInputError"; this.needs = needs; }
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                          */
/* ------------------------------------------------------------------ */

function detectDelimiter(header: string): string {
  const cands = ["\t", "|", ";", ","];
  let best = ",", bestN = -1;
  for (const d of cands) {
    const n = header.split(d).length;
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}

/** Split CSV avec guillemets. Suffisant pour les exports comptables (pas de multi-ligne). */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === delim && !inQ) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/** "1 234,56" / "1,234.56" / "1234.56" / "-12,3" → number ; NaN si vide/invalide. */
function num(s: string | undefined): number {
  if (s == null) return NaN;
  let t = String(s).trim().replace(/\s|\u00a0|\u202f/g, "");
  if (!t) return NaN;
  // Parenthèses comptables = négatif
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  // Si virgule ET point : le dernier des deux est le séparateur décimal
  const lastComma = t.lastIndexOf(","), lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (lastComma >= 0) {
    t = t.replace(",", ".");
  }
  const v = parseFloat(t);
  return isNaN(v) ? NaN : (neg ? -v : v);
}

/** AAAAMMJJ | JJ/MM/AAAA | AAAA-MM-JJ | JJ.MM.AAAA | MM/JJ/AAAA (si jour>12 sinon ambigu→JJ/MM) */
function isoDate(s: string | undefined): string {
  if (!s) return "";
  const t = String(s).trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/))) {
    const a = +m[1], b = +m[2];
    // a/b/yyyy : si a>12 c'est forcément JJ/MM ; si b>12 c'est MM/JJ ; sinon on prend JJ/MM (FR)
    const [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
    return `${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return "";
}

const period = (iso: string) => iso ? iso.slice(0, 7) : "";

/** Cellule de période → "YYYY-MM". Formats : "2025-01", "202501", "01/2025",
 *  "2025/01", et numérique nu "1".."16" (exige fyHint ; 13-16 = périodes
 *  spéciales SAP/Oracle → mois 12). "" si non reconnu. */
function parsePeriodCell(s: string | undefined, fyHint?: number): string {
  if (!s) return "";
  const t = String(s).trim();
  let m: RegExpMatchArray | null;
  const ym = (y: number, mo: number) =>
    (mo >= 1 && mo <= 16 && y >= 1900 && y <= 2200) ? `${y}-${String(Math.min(mo, 12)).padStart(2, "0")}` : "";
  if ((m = t.match(/^(\d{4})[-\/](\d{1,2})$/))) return ym(+m[1], +m[2]);
  if ((m = t.match(/^(\d{1,2})[-\/](\d{4})$/))) return ym(+m[2], +m[1]);
  if ((m = t.match(/^(\d{4})(\d{2})$/)))        return ym(+m[1], +m[2]);
  if ((m = t.match(/^(\d{1,2})$/)))             return fyHint ? ym(fyHint, +m[1]) : "";
  return "";
}

/** Dernier jour du mois de "YYYY-MM" (UTC, sans surprise de fuseau). */
function lastDayOf(ym: string): string {
  const y = +ym.slice(0, 4), mo = +ym.slice(5, 7);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* FEC                                                                  */
/* ------------------------------------------------------------------ */

const FEC_COLS = [
  "JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib",
  "CompAuxNum", "CompAuxLib", "PieceRef", "PieceDate", "EcritureLib", "Debit", "Credit",
  "EcritureLet", "DateLet", "ValidDate", "Montantdevise", "Idevise",
];

function looksLikeFec(headerCells: string[]): boolean {
  const norm = headerCells.map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
  const need = ["ecriturenum", "ecrituredate", "comptenum", "debit", "credit"];
  return need.every(n => norm.includes(n));
}

function parseFec(lines: string[], delim: string, entity: string): ParseResult {
  const header = splitLine(lines[0], delim);
  const idx = (name: string) => header.findIndex(h => h.toLowerCase().replace(/[^a-z]/g, "") === name.toLowerCase().replace(/[^a-z]/g, ""));
  const iNum = idx("EcritureNum"), iDate = idx("EcritureDate"), iAcct = idx("CompteNum"),
        iLib = idx("EcritureLib"), iLibC = idx("CompteLib"), iDr = idx("Debit"), iCr = idx("Credit"),
        iAux = idx("CompAuxNum"), iRef = idx("PieceRef"), iDev = idx("Idevise"),
        iMontDev = idx("Montantdevise");
  const entries: LedgerEntry[] = [];
  const warnings: string[] = [];
  let dropped = 0;
  const ccys = new Map<string, number>();
  /* CompteLib figurait dans FEC_COLS sans jamais être lu : les états
     affichaient les numéros de compte. Stable par construction dans un FEC
     (art. A.47 A-1) : premier libellé non vide par compte. */
  const coaDict: Record<string, string> = {};

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) { dropped++; continue; }
    const c = splitLine(raw, delim);
    const acct = (c[iAcct] ?? "").trim();
    const date = isoDate(c[iDate]);
    let dr = num(c[iDr]), cr = num(c[iCr]);
    if (isNaN(dr)) dr = 0;
    if (isNaN(cr)) cr = 0;
    if (!acct || !date || (dr === 0 && cr === 0)) { dropped++; continue; }
    const ccy = (iDev >= 0 && c[iDev]) ? c[iDev].toUpperCase() : "EUR";
    ccys.set(ccy, (ccys.get(ccy) ?? 0) + 1);
    const libC = iLibC >= 0 ? (c[iLibC] ?? "").trim() : "";
    if (libC && libC !== acct && !(acct in coaDict)) coaDict[acct] = libC;
    entries.push({
      acct, dr, cr, date, period: period(date), entity,
      desc: c[iLib] ?? "", ccy,
      entry_id: `${c[iNum] ?? i}_${i}`,
      tp: iAux >= 0 && c[iAux] ? c[iAux] : undefined,
      ref: iRef >= 0 && c[iRef] ? c[iRef] : undefined,
    });
  }
  if (iMontDev >= 0) warnings.push("Montantdevise ignoré : les montants sont pris en devise de tenue (Debit/Credit).");
  for (const e of entries) { const nm = coaDict[e.acct]; if (nm) e.header_text = nm; }
  return finish("fec", entries, dropped, warnings, ccys, coaDict, 1);
}

/* ------------------------------------------------------------------ */
/* CSV générique                                                        */
/* ------------------------------------------------------------------ */

/* Table de synonymes — portée du savoir ERP du wizard (import-wizard.js,
   table add() + _ERP_AI_KNOWLEDGE). L'ORDRE des synonymes est un ORDRE DE
   PRÉFÉRENCE : quand plusieurs colonnes candidates existent dans le même
   fichier, la première de cette liste gagne. C'est ainsi que s'encodent les
   pièges connus : Oracle ACCOUNTED avant ENTERED, D365 devise comptable
   avant devise de transaction, NetSuite « Account Number » avant le
   « Account » qui porte des NOMS, SAP DMBTR/HSL avant les montants devise
   document. */
const SYN: Record<string, string[]> = {
  /* formes numéro/code AVANT le « account » nu : NetSuite exporte les NOMS
     dans « Account » et le code dans « Account Number ». */
  acct:   ["comptenum", "numerocompte", "nocompte", "accountnumber", "accountno", "accountcode",
           "glaccountno", "glaccount", "mainaccountid", "hkont", "racct", "acctno", "accnum",
           "compte", "account", "acct", "konto", "acc", "code"],
  /* D365 : chaîne à dimensions concaténées ("1200-001-SALES") — repli
     UNIQUEMENT si aucun vrai code n'existe, avec avertissement. */
  acct_display: ["accountdisplayvalue"],
  /* AVANT desc : sinon "accountdescription" serait happé par desc (inclusion
     de "description") et l'intitulé du compte finirait en mémo de ligne. */
  acct_name: ["accountname", "glaccountname", "comptelib", "libellecompte", "intitulecompte",
              "accounttitle", "accttitle", "acctname", "accountdesc", "accountdescription",
              "accountlabel", "kontobezeichnung", "acctdesc"],
  desc:   ["libelle", "libellé", "label", "description", "memo", "intitule", "intitulé", "narration", "ecriturelib", "desc", "descr", "text", "sgtxt", "itemtext"],
  date:   ["date", "ecrituredate", "datecomptable", "dateecriture", "postingdate", "budat", "transactiondate", "transdate", "effectivedate", "gldate", "whenposted", "journaldate", "datum"],
  period: ["period", "periode", "monat", "poper", "fiscalperiod", "postingperiod", "accountingperiod", "periodname"],
  fy:     ["fiscalyear", "gjahr", "exercice", "annee", "fy", "year"],
  /* montants : comptable/local AVANT transaction/devise document */
  dr:     ["accounteddr", "accountingcurrencydebitamount", "functionaldebit", "debit", "debitamount", "debitamt", "soll", "dr", "débit", "entereddr", "transactioncurrencydebitamount"],
  cr:     ["accountedcr", "accountingcurrencycreditamount", "functionalcredit", "credit", "creditamount", "creditamt", "haben", "cr", "crédit", "enteredcr", "transactioncurrencycreditamount"],
  amount: ["hsl", "dmbtr", "amtloc", "amtcur", "amountinlocalcurrency", "amountincompanycodecurrency", "montant", "amount", "netamount", "solde", "net", "value", "betrag"],
  /* indicateur débit/crédit : SAP SHKZG (S/H), Sage X3 SENS (D/C)… */
  dc_ind: ["shkzg", "sens", "dcind", "debitcreditind", "debitcreditindicator", "debitcredit", "dcflag", "sh", "dc"],
  /* Intacct : LOCATIONID = ENTITÉ, pas un lieu (piège documenté). */
  entity: ["entite", "entité", "entity", "societe", "société", "company", "companycode", "bukrs", "rbukrs", "dataareaid", "subsidiary", "locationid", "site", "fcy", "legalentity", "dossier"],
  ccy:    ["devise", "currency", "currencycode", "ccy", "monnaie", "waehrung", "waers", "rhcur", "rtcur", "basecurr"],
  tp:     ["tiers", "thirdparty", "counterparty", "compaux", "compauxnum", "auxiliaire", "customer", "vendor", "supplier", "partner", "lifnr", "kunnr", "contact", "contactname", "sourcename", "payee", "vendorid", "customerid", "vendorname", "customername", "suppliername", "businesspartner"],
  ref:    ["piece", "pièce", "pieceref", "reference", "ref", "document", "docnum", "journal", "xblnr", "zuonr", "refno", "referencenumber"],
  id:     ["id", "entryid", "ecriturenum", "belnr", "voucherno", "vouchernumber", "journalnumber", "transactionnumber", "numero", "num", "line", "ligne", "transactionid"],
};

/* Colonnes à EXCLURE du mapping et de l'adoption : les pièges qui produisent
   des chiffres faux (QuickBooks Balance = solde cumulé, Split = compte de
   contrepartie ; Xero Gross/GST = montants TTC/taxe qui double-comptent). */
const SKIP_RX = /^(balance|runningbalance|split|gross|grossamount|gst|tax|taxamount|taxtype|taxrate|exchangerate|fxrate)$/;

/* Filtres de LIGNES connus (HFM/NetSuite) : quand la colonne existe et que
   ses valeurs sont mixtes, ne garder que les lignes comptables réelles —
   sinon Budget/Forecast et cumuls YTD polluent (double-comptage documenté
   dans les règles HFM du wizard). */
const ROW_FILTERS: Array<{ col: string; keep: RegExp; label: string }> = [
  { col: "scenario",  keep: /^actuals?$/i,        label: "Scenario ≠ Actual (Budget/Forecast)" },
  { col: "view",      keep: /^periodic$/i,        label: "View ≠ Periodic (YTD = cumul, double-comptage)" },
  { col: "isposting", keep: /^(y|yes|true|1)$/i,  label: "Is Posting ≠ Yes (lignes statistiques)" },
];

function normHeader(h: string): string {
  return h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

/* ── Dépendance fonctionnelle compte → libellé ─────────────────────────
   Un intitulé de compte est STABLE (même valeur sur toutes les lignes du
   compte) et DISCRIMINANT (libellés distincts pour des comptes distincts).
   Un mémo varie par ligne ; une colonne de catégorie (Asset/Revenue…) est
   stable mais pas discriminante ; une devise est constante. Le test porte
   sur les VALEURS, pas sur l'en-tête : il fonctionne quelle que soit la
   langue de l'export, y compris pour des colonnes hors table de synonymes. */
class NameCandidate {
  private labels = new Map<string, string>();
  private conflicts = new Set<string>();
  private nonEmpty = 0;
  private numericish = 0;
  constructor(public idx: number, public mapped: boolean) {}
  feed(acct: string, raw: string | undefined) {
    const v = (raw ?? "").trim();
    if (!v) return;
    this.nonEmpty++;
    if (/^[-\d\s.,\/]+$/.test(v) || isoDate(v)) { this.numericish++; return; }
    const prev = this.labels.get(acct);
    if (prev === undefined) this.labels.set(acct, v);
    else if (prev !== v) this.conflicts.add(acct);
  }
  score(totalAccts: number) {
    const named = this.labels.size;
    const stable = named - this.conflicts.size;
    const distinct = new Set(this.labels.values()).size;
    const ok = named > 0 && this.nonEmpty > 0
      && named / totalAccts >= 0.5                 /* couverture des comptes */
      && stable / named >= 0.9                     /* stabilité : ≠ mémo */
      && this.numericish / this.nonEmpty < 0.5     /* ≠ montants / dates */
      && distinct / named > 0.5;                   /* discriminant (strict) : ≠ Type/Devise */
    return { ok, stability: stable / Math.max(named, 1), coverage: named / Math.max(totalAccts, 1) };
  }
  dict(): Record<string, string> {
    const d: Record<string, string> = {};
    for (const [a, l] of this.labels) if (!this.conflicts.has(a) && l !== a) d[a] = l;
    return d;
  }
}

function mapHeaders(header: string[], skip: Set<number> = new Set()): Partial<Record<keyof typeof SYN, number>> {
  const norm = header.map(normHeader);
  const out: Partial<Record<keyof typeof SYN, number>> = {};
  const used = new Set<number>();
  const free = (idx: number) => !used.has(idx) && !skip.has(idx);
  /* Propriétaire exact : un en-tête qui EST un synonyme exact d'une clé ne
     peut pas être happé par l'INCLUSION d'une autre clé. Ex. NetSuite
     « Account » (synonyme exact de acct, mais non retenu car « Account
     Number » a priorité) ne doit pas être avalé par acct_display ou
     acct_name via inclusion — il doit rester libre pour l'élection
     d'intitulé par les valeurs. */
  const exactOwner = new Map<string, string>();
  for (const k of Object.keys(SYN)) for (const s of SYN[k]) if (!exactOwner.has(s)) exactOwner.set(s, k);
  for (const key of Object.keys(SYN) as (keyof typeof SYN)[]) {
    /* 1) exact — itère les SYNONYMES dans l'ordre (= préférence), pas les
       colonnes : un fichier Oracle avec ENTERED_DR et ACCOUNTED_DR mappe
       ACCOUNTED_DR quel que soit l'ordre des colonnes. */
    let i = -1;
    for (const s of SYN[key]) {
      const j = norm.findIndex((h, idx) => free(idx) && h === s);
      if (j >= 0) { i = j; break; }
    }
    // 2) inclusion dans les deux sens, uniquement sur des synonymes assez longs
    //    pour ne pas être ambigus ("ncompte" ⊃ "compte", "accountnumber" ⊃ "account",
    //    mais jamais "dr"/"cr"/"id"/"ref" par sous-chaîne).
    if (i < 0) i = norm.findIndex((h, idx) => free(idx) &&
      (!exactOwner.has(h) || exactOwner.get(h) === key) &&
      SYN[key].some(s => s.length >= 5 && (h.includes(s) || s.includes(h) && h.length >= 5)));
    if (i >= 0) { out[key] = i; used.add(i); }
  }
  return out;
}

function parseCsv(lines: string[], delim: string, entity: string, opts: ParseOpts = {}): ParseResult {
  const header = splitLine(lines[0], delim);
  const normH = header.map(normHeader);
  const warnings: string[] = [];

  /* Colonnes-pièges : hors mapping, hors adoption. */
  const skip = new Set<number>();
  for (let i = 0; i < normH.length; i++) if (SKIP_RX.test(normH[i])) skip.add(i);
  if (skip.size > 0)
    warnings.push(`Colonnes ignorées (pièges connus : soldes cumulés, contreparties, montants TTC/taxe) : ${[...skip].map(i => header[i]).join(", ")}.`);

  const m = mapHeaders(header, skip);
  /* ── Overrides de l'appelant : priment sur l'inférence ── */
  let overridesApplied = 0;
  let forcedMode: "dual" | "signed" | "signed_inv" | "single" | undefined;
  if (opts.columnMap) {
    for (const [field, hdr] of Object.entries(opts.columnMap)) {
      if (field === "amount_mode") { forcedMode = hdr as typeof forcedMode; continue; }
      if (!(field in SYN)) { warnings.push(`column_map : champ inconnu « ${field} » ignoré.`); continue; }
      const idx = normH.indexOf(normHeader(String(hdr)));
      if (idx < 0) { warnings.push(`column_map : en-tête « ${hdr} » introuvable pour « ${field} ».`); continue; }
      /* libère l'ancienne affectation de cette colonne, le cas échéant */
      for (const k of Object.keys(m) as (keyof typeof SYN)[]) if (m[k] === idx && k !== field) delete m[k];
      (m as Record<string, number>)[field] = idx;
      skip.delete(idx);   /* un override explicite lève même un skip */
      overridesApplied++;
    }
    if (overridesApplied > 0) warnings.push(`${overridesApplied} champ(s) forcés par column_map.`);
  }
  /* D365 : ACCOUNTDISPLAYVALUE en dernier recours seulement. */
  if (m.acct == null && m.acct_display != null) {
    m.acct = m.acct_display;
    warnings.push(`Compte lu depuis « ${header[m.acct_display]} » (chaîne à dimensions concaténées) : mappez le code compte pur (MAINACCOUNTID) si disponible.`);
  }
  if (m.acct == null) throw new ParseError("Colonne compte introuvable (attendu : compte / account / CompteNum…).");
  if (m.dr == null && m.cr == null && m.amount == null)
    throw new ParseError("Colonnes montant introuvables (attendu : débit/crédit, ou montant signé avec indicateur D/C éventuel).");

  /* Filtres de lignes (HFM Scenario/View, NetSuite Is Posting) : actifs
     seulement quand la colonne existe ET porte des valeurs mixtes. */
  const activeFilters: Array<{ idx: number; keep: RegExp; label: string; removed: number }> = [];
  for (const f of ROW_FILTERS) {
    const idx = normH.indexOf(f.col);
    if (idx < 0 || skip.has(idx)) continue;
    const vals = new Set<string>();
    for (let i = 1; i < lines.length && vals.size < 8; i++) {
      if (!lines[i].trim()) continue;
      const v = (splitLine(lines[i], delim)[idx] ?? "").trim();
      if (v) vals.add(v.toLowerCase());
    }
    const hasKeep = [...vals].some(v => f.keep.test(v));
    if (vals.size > 1 && hasKeep) activeFilters.push({ idx, keep: f.keep, label: f.label, removed: 0 });
    else if (vals.size === 1 && !hasKeep && f.col === "view")
      warnings.push("Colonne View entièrement en cumul (YTD) : les montants sont cumulés, risque de double-comptage — exportez en Periodic.");
  }

  const entries: LedgerEntry[] = [];
  let dropped = 0;
  const ccys = new Map<string, number>();
  let dualMode = m.dr != null && m.cr != null;
  let indicatorMode = !dualMode && m.amount != null && m.dc_ind != null;
  let signedMode = !dualMode && !indicatorMode && m.dr == null && m.cr == null;
  let signedInv = false;
  if (forcedMode === "dual") { dualMode = true; indicatorMode = signedMode = false; }
  else if (forcedMode === "single") { indicatorMode = m.amount != null && m.dc_ind != null; dualMode = false; signedMode = !indicatorMode; }
  else if (forcedMode === "signed" || forcedMode === "signed_inv") {
    dualMode = indicatorMode = false; signedMode = m.amount != null;
    signedInv = forcedMode === "signed_inv";
    if (signedInv) warnings.push("amount_mode signed_inv : positif → crédit (convention PCG/Cegid).");
  }
  if (indicatorMode)
    warnings.push(`Montant unique + indicateur D/C (« ${header[m.dc_ind!]} ») : S/D/DR/SOLL → débit, H/C/CR/HABEN → crédit, montants pris en valeur absolue (convention SAP/Sage X3).`);
  else if (signedMode) warnings.push("Montant signé détecté : positif → débit, négatif → crédit.");
  let indUnknown = 0, negWithInd = 0, docIdRows = 0;

  /* ── Résolution des dates : échelle explicite, jamais de date inventée ──
     1. colonne date du fichier
     2. colonne période (+ colonne exercice, sinon l'année de period_end)
        → dernier jour du mois, marqué _is_synth_date
     3. period_end seul → toutes les écritures à cette date, marquées
     4. rien → NeedsInputError : on demande, on ne devine pas.
     L'ancien repli « 1er du mois courant » datait tout l'exercice du mois
     de l'analyse : DSO/DPO/DIO faux d'un facteur 12, période affichée
     fausse. Une donnée fabriquée est consentie, marquée, ou refusée. */
  const peIso = opts.periodEnd ? isoDate(opts.periodEnd) : "";
  if (opts.periodEnd && !peIso) warnings.push(`period_end « ${opts.periodEnd} » invalide (attendu YYYY-MM-DD) : ignoré.`);
  const fyDefault = peIso ? +peIso.slice(0, 4) : undefined;
  if (m.date == null && m.period == null && !peIso)
    throw new NeedsInputError(
      "Aucune information de date dans le fichier (ni colonne date, ni colonne période). " +
      "Fournissez period_end (date de clôture YYYY-MM-DD) ou ré-exportez avec les dates.",
      ["period_end"]);
  let synthCount = 0, periodUnreadable = 0;

  /* Candidats intitulé de compte : la colonne acct_name mappée (prioritaire)
     + toutes les colonnes non mappées (plafond : 12) — l'élection se fait
     sur les valeurs, voir NameCandidate. */
  const used = new Set<number>(Object.values(m) as number[]);
  const cands: NameCandidate[] = [];
  if (m.acct_name != null) cands.push(new NameCandidate(m.acct_name, true));
  for (let i = 0; i < header.length && cands.length < 13; i++)
    if (!used.has(i) && !skip.has(i)) cands.push(new NameCandidate(i, false));

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) { dropped++; continue; }
    const c = splitLine(raw, delim);
    let rowFiltered = false;
    for (const f of activeFilters) {
      if (!f.keep.test((c[f.idx] ?? "").trim())) { f.removed++; rowFiltered = true; break; }
    }
    if (rowFiltered) continue;
    /* "68000.0" : artefact de format (pandas/Excel float), pas un compte.
       Non normalisé, il fausse la détection de plan comptable côté moteur
       (longueur ≥ 6 → classifieur 6-digits/SAP → 68000 lu comme dotations,
       EBITDA surévalué — vu en production le 2026-08-25). */
    const acct = (c[m.acct] ?? "").trim().replace(/^(\d+)\.0+$/, "$1");
    if (!acct || /^total/i.test(acct)) { dropped++; continue; }
    let dr = 0, cr = 0;
    if (indicatorMode) {
      let a = num(c[m.amount!]);
      if (isNaN(a) || a === 0) { dropped++; continue; }
      if (a < 0) { negWithInd++; a = -a; }
      const ind = (c[m.dc_ind!] ?? "").trim().toUpperCase();
      if (/^(S|D|DR|DEBIT|SOLL)$/.test(ind)) dr = a;
      else if (/^(H|C|CR|CREDIT|HABEN)$/.test(ind)) cr = a;
      else { indUnknown++; dropped++; continue; }
    } else if (signedMode) {
      let a = num(c[m.amount!]);
      if (isNaN(a) || a === 0) { dropped++; continue; }
      if (signedInv) a = -a;
      if (a > 0) dr = a; else cr = -a;
    } else {
      dr = m.dr != null ? num(c[m.dr]) : NaN;
      cr = m.cr != null ? num(c[m.cr]) : NaN;
      if (isNaN(dr)) dr = 0;
      if (isNaN(cr)) cr = 0;
      if (dr === 0 && cr === 0) { dropped++; continue; }
    }
    /* Échelle de résolution, par ligne */
    let date = m.date != null ? isoDate(c[m.date]) : "";
    let synth = false;
    if (!date && m.period != null) {
      const fyRow = m.fy != null ? parseInt(String(c[m.fy] ?? ""), 10) : NaN;
      const ym = parsePeriodCell(c[m.period], isFinite(fyRow) ? fyRow : fyDefault);
      if (ym) { date = lastDayOf(ym); synth = true; }
      else periodUnreadable++;
    }
    if (!date && peIso) { date = peIso; synth = true; }
    if (!date) { dropped++; continue; }
    if (synth) synthCount++;
    for (const cd of cands) cd.feed(acct, c[cd.idx]);
    const rowEntity = m.entity != null && c[m.entity] ? c[m.entity] : entity;
    const ccy = m.ccy != null && c[m.ccy] ? c[m.ccy].toUpperCase() : "EUR";
    ccys.set(ccy, (ccys.get(ccy) ?? 0) + 1);
    if (m.id != null && c[m.id]) docIdRows++;
    entries.push({
      acct, dr, cr, date, period: period(date), entity: rowEntity,
      desc: m.desc != null ? (c[m.desc] ?? "") : "", ccy,
      entry_id: `${m.id != null && c[m.id] ? c[m.id] : "r"}_${i}`,
      tp: m.tp != null && c[m.tp] ? c[m.tp] : undefined,
      ref: m.ref != null && c[m.ref] ? c[m.ref] : undefined,
      ...(synth ? { _is_synth_date: true } : {}),
    });
  }
  if (!entries.length && (periodUnreadable > 0 || (m.date == null && m.period != null && !peIso)))
    throw new NeedsInputError(
      "Colonne période présente mais année indéterminable (périodes numériques sans exercice). " +
      "Fournissez period_end (YYYY-MM-DD) : son année servira d'exercice.",
      ["period_end"]);
  if (synthCount > 0)
    warnings.push(`${synthCount} écriture(s) sans date : dates synthétiques générées ` +
      (m.period != null ? "depuis la colonne période (dernier jour du mois" : `au period_end fourni (${peIso}`) +
      ", marquées is_synth_date dans K-Φ).");
  if (periodUnreadable > 0 && entries.length)
    warnings.push(`${periodUnreadable} ligne(s) à période illisible ${peIso ? `datées au period_end` : "ignorées"}.`);
  if (peIso) {
    const after = entries.filter(e => !e._is_synth_date && e.date > peIso).length;
    if (after > 0) warnings.push(`${after} écriture(s) postérieures à period_end ${peIso} : clôture incomplète ou period_end erroné ?`);
  }
  for (const f of activeFilters)
    if (f.removed > 0) warnings.push(`${f.removed} ligne(s) exclue(s) — ${f.label}.`);
  if (indUnknown > 0) warnings.push(`${indUnknown} ligne(s) à indicateur D/C illisible ignorées.`);
  if (negWithInd > 0) warnings.push(`${negWithInd} montant(s) négatifs malgré l'indicateur D/C : valeur absolue appliquée.`);

  /* ── Élection de l'intitulé de compte ── */
  const totalAccts = new Set(entries.map(e => e.acct)).size;
  let winner: NameCandidate | undefined;
  const mappedCand = cands.find(cd => cd.mapped);
  if (mappedCand && mappedCand.score(totalAccts).ok) {
    winner = mappedCand;
  } else {
    if (mappedCand)
      warnings.push(`Colonne « ${header[mappedCand.idx]} » : libellé instable par compte — traitée comme un mémo, pas comme l'intitulé du compte.`);
    winner = cands
      .filter(cd => !cd.mapped)
      .map(cd => ({ cd, s: cd.score(totalAccts) }))
      .filter(x => x.s.ok)
      .sort((a, b) => b.s.stability - a.s.stability || b.s.coverage - a.s.coverage)[0]?.cd;
    if (winner)
      warnings.push(`Intitulés de compte détectés dans la colonne « ${header[winner.idx]} » (dépendance compte → libellé).`);
  }
  const coaDict = winner ? winner.dict() : {};
  for (const e of entries) { const nm = coaDict[e.acct]; if (nm) e.header_text = nm; }
  const nameSource: ParseResult["name_source"] =
    winner ? (winner.mapped ? "mapped" : "adopted") : (mappedCand ? "demoted" : "none");

  const columnMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) if (v != null && k !== "acct_display") columnMap[k] = header[v as number];
  if (winner && !winner.mapped) columnMap["acct_name"] = header[winner.idx];
  const mappedIdx = new Set<number>(Object.values(m) as number[]);
  if (winner) mappedIdx.add(winner.idx);
  const unmapped = header.filter((_, i) => !mappedIdx.has(i) && !skip.has(i));

  const res = finish("csv", entries, dropped, warnings, ccys, coaDict,
    entries.length ? docIdRows / entries.length : 0);
  res.column_map = columnMap;
  res.unmapped_headers = unmapped;
  res.name_source = nameSource;
  res.overrides_applied = overridesApplied;
  return res;
}

/* ------------------------------------------------------------------ */

function detectGenre(entries: LedgerEntry[], docIdFrac = 0): "ledger" | "trial_balance" | "unknown" {
  if (!entries.length) return "unknown";
  const pairs = new Set<string>();
  let withRef = 0;
  for (const e of entries) {
    pairs.add(e.acct + "\u00a7" + e.period);
    if (e.ref || e.tp) withRef++;
  }
  const rpp = entries.length / pairs.size;      /* lignes par (compte, période) */
  /* Référencé = pièce/tiers sur la ligne OU numéro de document mappé (BELNR,
     JournalNumber…) : un FBL3N sans colonne tiers reste un grand livre. */
  const refFrac = Math.max(withRef / entries.length, docIdFrac);
  if (rpp <= 1.6 && refFrac < 0.2) return "trial_balance";
  if (rpp >= 2.5 || refFrac >= 0.5) return "ledger";
  return "unknown";
}

function finish(format: "fec" | "csv", entries: LedgerEntry[], dropped: number,
                warnings: string[], ccys: Map<string, number>,
                coaDict: Record<string, string> = {}, docIdFrac = 0): ParseResult {
  if (!entries.length) throw new ParseError("Aucune écriture exploitable trouvée dans le fichier.");
  const periods = entries.map(e => e.period).filter(Boolean).sort();
  const currency = [...ccys.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "EUR";
  if (ccys.size > 1) warnings.push(`Plusieurs devises détectées (${[...ccys.keys()].join(", ")}) ; ${currency} retenue comme devise principale.`);
  const totDr = entries.reduce((a, e) => a + e.dr, 0), totCr = entries.reduce((a, e) => a + e.cr, 0);
  if (Math.abs(totDr - totCr) > Math.max(1, (totDr + totCr) * 0.001))
    warnings.push(`Déséquilibre débit/crédit : ${totDr.toFixed(2)} vs ${totCr.toFixed(2)} (export partiel ou balance plutôt que grand livre ?).`);
  return {
    format, entries,
    entities: [...new Set(entries.map(e => e.entity))].filter(Boolean),
    currency, period_from: periods[0] ?? "", period_to: periods[periods.length - 1] ?? "",
    dropped, warnings, genre: detectGenre(entries, docIdFrac), coa_dict: coaDict,
    column_map: {}, unmapped_headers: [], overrides_applied: 0,
    name_source: Object.keys(coaDict).length ? "mapped" : "none",
  };
}

/**
 * Point d'entrée. `entity` = nom d'entité par défaut si le fichier n'en porte pas
 * (le moteur exige une entité, même unique). `opts.periodEnd` = date de clôture
 * fournie par l'appelant, utilisée par l'échelle de résolution des dates.
 */
export function parseLedger(content: string, entity = "ENTITY", opts: ParseOpts = {}): ParseResult {
  const text = content.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const firstIdx = lines.findIndex(l => l.trim());
  if (firstIdx < 0) throw new ParseError("Fichier vide.");
  const body = lines.slice(firstIdx);
  const delim = detectDelimiter(body[0]);
  const header = splitLine(body[0], delim);
  if (header.length < 3) throw new ParseError("En-tête non reconnue (moins de 3 colonnes).");
  return looksLikeFec(header) ? parseFec(body, delim, entity) : parseCsv(body, delim, entity, opts);
}
