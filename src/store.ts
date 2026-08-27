/**
 * Stockage des analyses anonymes et des uploads en attente.
 * Implémentation mémoire pour le squelette ; en prod : Postgres (schéma dédié,
 * purge 30 j) + S3/R2 pour les fichiers (TTL 24 h).
 */
import { randomBytes } from "node:crypto";
import type { AnalysisResult, AnalyzeInput } from "./engine.js";

export type AnalysisStatus = "pending" | "ready" | "error";

export interface StoredAnalysis {
  id: string;
  status: AnalysisStatus;
  created_at: number;
  session_id: string;
  source: "inline" | "upload";
  /** utm_source logique (ex. "mcp") — remplace l'ancienne query string sur
   *  open_in_kphi_url ; conservé côté serveur pour les stats d'attribution
   *  sans allonger le lien affiché à l'utilisateur. */
  attribution: string;
  opts: Omit<AnalyzeInput, "content">;
  storage_key?: string;
  result?: AnalysisResult;
  error?: string;
}

export interface Store {
  create(a: Omit<StoredAnalysis, "id" | "created_at">): Promise<StoredAnalysis>;
  get(id: string): Promise<StoredAnalysis | undefined>;
  update(id: string, patch: Partial<StoredAnalysis>): Promise<void>;
  /** Jeton d'upload → analysis_id, expire en `ttlMs`. */
  issueUploadToken(analysisId: string, ttlMs: number): Promise<string>;
  consumeUploadToken(token: string): Promise<string | undefined>;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export class MemoryStore implements Store {
  private analyses = new Map<string, StoredAnalysis>();
  private uploads = new Map<string, { analysisId: string; expires: number }>();

  async create(a: Omit<StoredAnalysis, "id" | "created_at">) {
    const rec: StoredAnalysis = { ...a, id: newId("an"), created_at: Date.now() };
    this.analyses.set(rec.id, rec);
    return rec;
  }
  async get(id: string) { return this.analyses.get(id); }
  async update(id: string, patch: Partial<StoredAnalysis>) {
    const cur = this.analyses.get(id);
    if (cur) this.analyses.set(id, { ...cur, ...patch });
  }
  async issueUploadToken(analysisId: string, ttlMs: number) {
    const token = randomBytes(24).toString("base64url");
    this.uploads.set(token, { analysisId, expires: Date.now() + ttlMs });
    return token;
  }
  async consumeUploadToken(token: string) {
    const u = this.uploads.get(token);
    if (!u || u.expires < Date.now()) return undefined;
    this.uploads.delete(token);
    return u.analysisId;
  }
}

/**
 * Store persistant sur disque — un fichier JSON par analyse, un par jeton.
 *
 * Motif (2026-08-27) : le premier upload réel d'un fondateur a été perdu
 * parce que MemoryStore vit en RAM et qu'un redeploy (deux PRs mergées à la
 * même minute) a effacé l'analyse ET son jeton → « analysis not found or
 * expired » alors que la page avait confirmé la réception. Un service qui se
 * redéploie plusieurs fois par jour ne peut pas garder l'état en mémoire.
 *
 * Choix : même disque que les uploads (KPHI_UPLOAD_STORAGE=tmp → /tmp), TTL
 * aligné (24 h), écriture SYNCHRONE avant le retour — un 202 ne doit jamais
 * précéder la persistance. Si le disque est absent, on retombe sur la RAM :
 * dégradé, jamais bloquant.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

export class FsStore implements Store {
  private mem = new MemoryStore();
  constructor(private dir: string, private ttlMs = 24 * 3600_000) {
    mkdirSync(join(dir, "an"), { recursive: true });
    mkdirSync(join(dir, "tok"), { recursive: true });
    this.sweep();
  }
  private p(kind: "an" | "tok", id: string) {
    /* id sanitisé : jamais de séparateur de chemin dans un nom de fichier */
    return join(this.dir, kind, id.replace(/[^A-Za-z0-9_-]/g, "") + ".json");
  }
  private sweep() {
    for (const kind of ["an", "tok"] as const) {
      const d = join(this.dir, kind);
      for (const f of existsSync(d) ? readdirSync(d) : []) {
        try {
          const raw = JSON.parse(readFileSync(join(d, f), "utf8")) as { created_at?: number; expires?: number };
          const dead = kind === "tok" ? (raw.expires ?? 0) < Date.now() : (raw.created_at ?? 0) + this.ttlMs < Date.now();
          if (dead) rmSync(join(d, f), { force: true });
        } catch { rmSync(join(d, f), { force: true }); }
      }
    }
  }
  async create(a: Omit<StoredAnalysis, "id" | "created_at">) {
    const rec: StoredAnalysis = { ...a, id: newId("an"), created_at: Date.now() };
    writeFileSync(this.p("an", rec.id), JSON.stringify(rec));
    return rec;
  }
  async get(id: string) {
    try {
      const rec = JSON.parse(readFileSync(this.p("an", id), "utf8")) as StoredAnalysis;
      if (rec.created_at + this.ttlMs < Date.now()) return undefined;
      return rec;
    } catch { return this.mem.get(id); }
  }
  async update(id: string, patch: Partial<StoredAnalysis>) {
    const cur = await this.get(id);
    if (cur) writeFileSync(this.p("an", id), JSON.stringify({ ...cur, ...patch }));
  }
  async issueUploadToken(analysisId: string, ttlMs: number) {
    const token = randomBytes(24).toString("base64url");
    writeFileSync(this.p("tok", token), JSON.stringify({ analysisId, expires: Date.now() + ttlMs }));
    return token;
  }
  async consumeUploadToken(token: string) {
    try {
      const f = this.p("tok", token);
      const u = JSON.parse(readFileSync(f, "utf8")) as { analysisId: string; expires: number };
      if (u.expires < Date.now()) { rmSync(f, { force: true }); return undefined; }
      rmSync(f, { force: true });
      return u.analysisId;
    } catch { return undefined; }
  }
}
