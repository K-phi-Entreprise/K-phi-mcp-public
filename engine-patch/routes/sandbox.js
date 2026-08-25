/* routes/sandbox.js — service access for the PUBLIC MCP server (anonymous
 * analyses). Two things, both gated by a shared secret, never by a session:
 *
 *   POST /api/internal/sandbox/token  → short-lived owner JWT on the sandbox tenant
 *   (cron)  purge every version named anon_* older than SANDBOX_TTL_HOURS
 *
 * Why a JWT and not an API key: /api/statements and /api/versions/:ver are
 * session-auth (auth), not apiKeyAuth. auth() accepts a Bearer token and only
 * enforces CSRF when the token carries a `csrf` claim — a service token simply
 * omits it. No change to auth() is needed.
 *
 * Isolation contract: the MCP server only ever reads/writes ONE version at a
 * time (ver=anon_<id>). Nothing on this tenant may aggregate across versions.
 * Keep the sandbox tenant empty of anything else.
 *
 * Env:
 *   KPHI_SANDBOX_SECRET     shared with the MCP server (required to enable)
 *   KPHI_SANDBOX_TENANT_ID  id of the dedicated sandbox tenant (required)
 *   SANDBOX_TOKEN_TTL_SEC   default 300
 *   SANDBOX_TTL_HOURS       default 24 (purge threshold)
 *   SANDBOX_PURGE_EVERY_MIN default 60
 *
 * Mount like the others in server.js:  require('./routes/sandbox')(app, ctx);
 * Then: node tools/route-table.js --write   (gate 1)
 */
'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

module.exports = function mountSandbox(app, ctx) {
  const { q, q1, run, getTenantDb, saveTenant, SLog, auditLog } = ctx;
  const SECRET = process.env.KPHI_SANDBOX_SECRET;
  const TENANT = process.env.KPHI_SANDBOX_TENANT_ID;
  const TOKEN_TTL = parseInt(process.env.SANDBOX_TOKEN_TTL_SEC || '300', 10);
  const TTL_HOURS = parseInt(process.env.SANDBOX_TTL_HOURS || '24', 10);
  const EVERY_MIN = parseInt(process.env.SANDBOX_PURGE_EVERY_MIN || '60', 10);

  if (!SECRET || !TENANT) {
    SLog.info('SANDBOX', 'disabled (KPHI_SANDBOX_SECRET / KPHI_SANDBOX_TENANT_ID unset)');
    return;
  }
  /* JWT_SECRET is what auth() verifies against; it lives in server.js scope.
     ctx exposes it for the OAuth/SSO routes already — reuse, don't duplicate. */
  const JWT_SECRET = ctx.JWT_SECRET || process.env.JWT_SECRET;
  if (!JWT_SECRET) { SLog.error('SANDBOX', 'JWT_SECRET unavailable — disabled'); return; }

  function secretOk(req) {
    const given = req.headers['x-sandbox-secret'];
    if (!given || given.length !== SECRET.length) return false;
    /* constant-time, same discipline as the login path */
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(SECRET));
  }

  /* ── service token ─────────────────────────────────────────────── */
  app.post('/api/internal/sandbox/token', async (req, res) => {
    if (!secretOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const t = await q1(ctx.masterDb, 'SELECT id, status FROM tenants WHERE id=?', [TENANT]);
    if (!t) return res.status(500).json({ error: 'sandbox tenant missing' });
    /* owner role: /api/gl/import needs writeAuth, DELETE /api/versions needs
       writeAuth; owner clears both. No csrf claim → auth() skips the CSRF check. */
    const token = jwt.sign(
      { userId: 'svc:mcp-public', tenantId: TENANT, role: 'owner', svc: 'mcp-public' },
      JWT_SECRET, { expiresIn: TOKEN_TTL }
    );
    res.json({ token, expires_in: TOKEN_TTL });
  });

  /* ── purge ─────────────────────────────────────────────────────── */
  async function purgeStale() {
    try {
      const db = await getTenantDb(TENANT);
      /* versions.updated_at is set on every import (see routes/gl.js).
         Threshold computed here, not in SQL: datetime('now', '-N hours') is
         SQLite-only and production is Postgres (TIMESTAMPTZ). An ISO string
         compares correctly against both TIMESTAMPTZ and SQLite's TEXT default. */
      const cutoff = new Date(Date.now() - TTL_HOURS * 3600 * 1000).toISOString();
      const rows = await q(db,
        "SELECT ver FROM versions WHERE ver LIKE 'anon\\_%' ESCAPE '\\' " +
        "AND status NOT IN ('locked','approved') " +
        "AND updated_at < ?", [cutoff]);
      let n = 0;
      for (const r of rows) {
        await run(db, 'DELETE FROM gl_entries WHERE ver=?', [r.ver]);
        await run(db, 'DELETE FROM versions WHERE ver=?', [r.ver]);
        n++;
      }
      if (n) { saveTenant(TENANT); auditLog(TENANT, 'svc:mcp-public', 'SANDBOX_PURGE', { versions: n }); }
      SLog.info('SANDBOX', 'purge', { stale: rows.length, deleted: n });
    } catch (e) {
      SLog.error('SANDBOX', 'purge failed', { error: e.message });
    }
  }
  setInterval(purgeStale, EVERY_MIN * 60 * 1000).unref();
  setTimeout(purgeStale, 30 * 1000).unref();   /* one pass shortly after boot */

  SLog.info('SANDBOX', 'enabled', { tenant: TENANT.slice(0, 8), tokenTtl: TOKEN_TTL, purgeHours: TTL_HOURS });
};
