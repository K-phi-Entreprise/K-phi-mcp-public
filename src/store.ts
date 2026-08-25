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
