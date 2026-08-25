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
}

export class ParseError extends Error {
  constructor(msg: string) { super(msg); this.name = "ParseError"; }
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
        iLib = idx("EcritureLib"), iDr = idx("Debit"), iCr = idx("Credit"),
        iAux = idx("CompAuxNum"), iRef = idx("PieceRef"), iDev = idx("Idevise"),
        iMontDev = idx("Montantdevise");
  const entries: LedgerEntry[] = [];
  const warnings: string[] = [];
  let dropped = 0;
  const ccys = new Map<string, number>();

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
    entries.push({
      acct, dr, cr, date, period: period(date), entity,
      desc: c[iLib] ?? "", ccy,
      entry_id: `${c[iNum] ?? i}_${i}`,
      tp: iAux >= 0 && c[iAux] ? c[iAux] : undefined,
      ref: iRef >= 0 && c[iRef] ? c[iRef] : undefined,
    });
  }
  if (iMontDev >= 0) warnings.push("Montantdevise ignoré : les montants sont pris en devise de tenue (Debit/Credit).");
  return finish("fec", entries, dropped, warnings, ccys);
}

/* ------------------------------------------------------------------ */
/* CSV générique                                                        */
/* ------------------------------------------------------------------ */

const SYN: Record<string, string[]> = {
  acct:   ["compte", "comptenum", "numerocompte", "nocompte", "account", "accountnumber", "accountcode", "glaccount", "code", "acct", "konto"],
  desc:   ["libelle", "libellé", "label", "description", "memo", "intitule", "intitulé", "narration", "ecriturelib", "desc", "descr", "text"],
  date:   ["date", "ecrituredate", "datecomptable", "dateecriture", "postingdate", "transactiondate", "datum"],
  dr:     ["debit", "débit", "dr", "soll"],
  cr:     ["credit", "crédit", "cr", "haben"],
  amount: ["montant", "amount", "solde", "net", "value", "betrag"],
  entity: ["entite", "entité", "entity", "societe", "société", "company", "dossier", "legalentity"],
  ccy:    ["devise", "currency", "ccy", "monnaie", "waehrung"],
  tp:     ["tiers", "thirdparty", "counterparty", "compaux", "compauxnum", "auxiliaire", "customer", "vendor", "supplier", "partner"],
  ref:    ["piece", "pièce", "pieceref", "reference", "ref", "document", "docnum", "journal"],
  id:     ["id", "entryid", "ecriturenum", "numero", "num", "line", "ligne", "transactionid"],
};

function normHeader(h: string): string {
  return h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function mapHeaders(header: string[]): Partial<Record<keyof typeof SYN, number>> {
  const norm = header.map(normHeader);
  const out: Partial<Record<keyof typeof SYN, number>> = {};
  const used = new Set<number>();
  for (const key of Object.keys(SYN) as (keyof typeof SYN)[]) {
    // 1) exact
    let i = norm.findIndex((h, idx) => !used.has(idx) && SYN[key].includes(h));
    // 2) inclusion dans les deux sens, uniquement sur des synonymes assez longs
    //    pour ne pas être ambigus ("ncompte" ⊃ "compte", "accountnumber" ⊃ "account",
    //    mais jamais "dr"/"cr"/"id"/"ref" par sous-chaîne).
    if (i < 0) i = norm.findIndex((h, idx) => !used.has(idx) &&
      SYN[key].some(s => s.length >= 5 && (h.includes(s) || s.includes(h) && h.length >= 5)));
    if (i >= 0) { out[key] = i; used.add(i); }
  }
  return out;
}

function parseCsv(lines: string[], delim: string, entity: string): ParseResult {
  const header = splitLine(lines[0], delim);
  const m = mapHeaders(header);
  if (m.acct == null) throw new ParseError("Colonne compte introuvable (attendu : compte / account / CompteNum…).");
  if (m.dr == null && m.cr == null && m.amount == null)
    throw new ParseError("Colonnes montant introuvables (attendu : débit/crédit, ou montant signé).");

  const entries: LedgerEntry[] = [];
  const warnings: string[] = [];
  let dropped = 0;
  const ccys = new Map<string, number>();
  const signedMode = m.dr == null && m.cr == null;
  if (signedMode) warnings.push("Montant signé détecté : positif → débit, négatif → crédit.");
  if (m.date == null) warnings.push("Pas de colonne date : période dérivée impossible, les écritures sont datées du 1er du mois courant.");

  const fallbackDate = new Date().toISOString().slice(0, 8) + "01";

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) { dropped++; continue; }
    const c = splitLine(raw, delim);
    const acct = (c[m.acct] ?? "").trim();
    if (!acct || /^total/i.test(acct)) { dropped++; continue; }
    let dr = 0, cr = 0;
    if (signedMode) {
      const a = num(c[m.amount!]);
      if (isNaN(a) || a === 0) { dropped++; continue; }
      if (a > 0) dr = a; else cr = -a;
    } else {
      dr = m.dr != null ? num(c[m.dr]) : NaN;
      cr = m.cr != null ? num(c[m.cr]) : NaN;
      if (isNaN(dr)) dr = 0;
      if (isNaN(cr)) cr = 0;
      if (dr === 0 && cr === 0) { dropped++; continue; }
    }
    const date = m.date != null ? isoDate(c[m.date]) : fallbackDate;
    if (!date) { dropped++; continue; }
    const rowEntity = m.entity != null && c[m.entity] ? c[m.entity] : entity;
    const ccy = m.ccy != null && c[m.ccy] ? c[m.ccy].toUpperCase() : "EUR";
    ccys.set(ccy, (ccys.get(ccy) ?? 0) + 1);
    entries.push({
      acct, dr, cr, date, period: period(date), entity: rowEntity,
      desc: m.desc != null ? (c[m.desc] ?? "") : "", ccy,
      entry_id: `${m.id != null && c[m.id] ? c[m.id] : "r"}_${i}`,
      tp: m.tp != null && c[m.tp] ? c[m.tp] : undefined,
      ref: m.ref != null && c[m.ref] ? c[m.ref] : undefined,
    });
  }
  return finish("csv", entries, dropped, warnings, ccys);
}

/* ------------------------------------------------------------------ */

function finish(format: "fec" | "csv", entries: LedgerEntry[], dropped: number,
                warnings: string[], ccys: Map<string, number>): ParseResult {
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
    dropped, warnings,
  };
}

/**
 * Point d'entrée. `entity` = nom d'entité par défaut si le fichier n'en porte pas
 * (le moteur exige une entité, même unique).
 */
export function parseLedger(content: string, entity = "ENTITY"): ParseResult {
  const text = content.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const firstIdx = lines.findIndex(l => l.trim());
  if (firstIdx < 0) throw new ParseError("Fichier vide.");
  const body = lines.slice(firstIdx);
  const delim = detectDelimiter(body[0]);
  const header = splitLine(body[0], delim);
  if (header.length < 3) throw new ParseError("En-tête non reconnue (moins de 3 colonnes).");
  return looksLikeFec(header) ? parseFec(body, delim, entity) : parseCsv(body, delim, entity);
}
