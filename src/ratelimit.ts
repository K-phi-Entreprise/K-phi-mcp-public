/**
 * Accès anonyme rate-limité : quota par IP et par session éphémère.
 * En prod, remplacer le Map par Redis (ou la table Postgres) pour survivre
 * aux redémarrages et au scale horizontal.
 */
import type { Request, Response, NextFunction } from "express";

const DAY = 24 * 60 * 60 * 1000;

export interface RateLimitConfig {
  analysesPerIpPerDay: number;      // ex. 10
  analysesPerSessionPerDay: number; // ex. 5
}

interface Bucket { count: number; reset: number }

export class RateLimiter {
  private ip = new Map<string, Bucket>();
  private session = new Map<string, Bucket>();
  constructor(private cfg: RateLimitConfig) {}

  private hit(map: Map<string, Bucket>, key: string, max: number): boolean {
    const now = Date.now();
    let b = map.get(key);
    if (!b || b.reset < now) { b = { count: 0, reset: now + DAY }; map.set(key, b); }
    if (b.count >= max) return false;
    b.count++;
    return true;
  }

  /** À appeler uniquement sur les opérations coûteuses (analyse), pas sur chaque requête MCP. */
  consumeAnalysis(ipAddr: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
    if (!this.hit(this.ip, ipAddr, this.cfg.analysesPerIpPerDay))
      return { ok: false, reason: "Quota journalier atteint pour cette adresse. Créez un compte K-Phi pour un accès illimité." };
    if (!this.hit(this.session, sessionId, this.cfg.analysesPerSessionPerDay))
      return { ok: false, reason: "Quota journalier atteint pour cette session. Créez un compte K-Phi pour un accès illimité." };
    return { ok: true };
  }
}

/** Contexte par requête, transmis aux outils via `extra.requestInfo` / res.locals. */
export interface RequestContext {
  ip: string;
  /** Session anonyme (header `Mcp-Session-Id` côté MCP, ou fallback IP). */
  sessionId: string;
  /** Rempli si OAuth : id utilisateur K-Phi. */
  userId?: string;
}

export function contextMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim()
    || req.socket.remoteAddress || "unknown";
  const sessionId = (req.headers["mcp-session-id"] as string | undefined) || `ip:${ip}`;
  const ctx: RequestContext = { ip, sessionId };
  // TODO OAuth 2.1 : vérifier le Bearer token via votre auth existante et remplir ctx.userId
  res.locals.ctx = ctx;
  next();
}
