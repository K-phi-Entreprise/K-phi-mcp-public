/**
 * The K-φ engine as seen by the capture server: the internal capture and build
 * routes (K-phi-engine, routes/capture.js and routes/build-sandbox.js), gated by
 * one shared secret (X-Build-Secret = KPHI_BUILD_SECRET on both sides).
 *
 * One method, call(): the engine's answer comes back whole, refusals included.
 * A refusal with a reason (4xx) is NOT an exception: its reasons are the next
 * thing the assistant has to act on. Only a failure of the engine itself (5xx,
 * network, timeout) throws.
 */
export interface EngineReply {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}
export interface CaptureEngine {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<EngineReply>;
}

export class EngineDown extends Error {
  constructor(msg: string, public status?: number) { super(msg); this.name = "EngineDown"; }
}

export interface HttpCaptureEngineConfig {
  baseUrl: string;        // https://k-phi.com, or the staging engine
  secret: string;         // KPHI_BUILD_SECRET
  timeoutMs?: number;     // default 60 s
  fetchImpl?: typeof fetch;
}

export class HttpCaptureEngine implements CaptureEngine {
  constructor(private cfg: HttpCaptureEngineConfig) {
    if (!cfg.baseUrl || !cfg.secret) throw new Error("HttpCaptureEngine: baseUrl and secret are required");
  }
  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<EngineReply> {
    const f = this.cfg.fetchImpl ?? fetch;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await f(this.cfg.baseUrl.replace(/\/$/, "") + "/api/internal/" + path, {
        method,
        headers: { "X-Build-Secret": this.cfg.secret, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      throw new EngineDown("The K-φ engine did not answer (" + (e instanceof Error ? e.name : "error") + ")");
    } finally { clearTimeout(timer); }
    let parsed: Record<string, unknown> = {};
    try { parsed = await res.json() as Record<string, unknown>; } catch { parsed = {}; }
    if (res.status >= 500) throw new EngineDown("The K-φ engine failed (" + res.status + ")", res.status);
    /* 401 and "not enabled" are a deployment fault (secret missing or different on one side), never the person's */
    if (res.status === 401 || parsed.error === "not_enabled") throw new EngineDown("This server is not connected to the K-φ engine (configuration)", res.status);
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body: parsed };
  }
}
