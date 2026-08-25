/* routes/sandbox.js — service access for the PUBLIC MCP server (anonymous
 * analyses). One tenant PER analysis, so a prospect who wants to keep the
 * result claims the tenant that already holds it — no data migration at
 * conversion. Two things, both gated by a shared secret, never by a session:
 *
 *   POST /api/internal/sandbox/tenant   → creates a sandbox tenant, returns
 *                                          { tenantId, name, token }
 *   POST /api/internal/sandbox/token    → token for an existing sandbox tenant
 *   (cron)  purge sandbox tenants older than SANDBOX_TTL_HOURS that were
 *           never claimed (no verified human user)
 *
 * Naming: tenants.name = 'MCP-<XYZ>-<YYYYMMDDHHmmss>' (UTC). XYZ is a 3-char
 * random tag so two analyses in the same second stay distinct. tenants.id
 * stays 32 hex like every other tenant: getTenantDb() derives the Postgres
 * schema by stripping non-hex from the id, so a readable id would collide.
 * The convention lives in `name` — the display column, what ops-panel shows.
 *
 * Why a JWT and not an API key: /api/statements and /api/versions/:ver are
 * session-auth (auth), not apiKeyAuth. auth() accepts a Bearer token and only
 * enforces CSRF when the token carries a `csrf` claim — a service token simply
 * omits it. No change to auth() is needed.
 *
 * Claiming: a user with email_verified=1 on the tenant marks it claimed; the
 * purge skips it. Wiring that (magic link on /a/:analysis_id → INSERT INTO
 * users) is the platform side, not this file.
 *
 * Purge mirrors the unverified-signup reaper in routes/auth.js: DELETE FROM
 * users / api_keys / tenants, Postgres schema LEFT IN PLACE (the repo has no
 * DROP SCHEMA anywhere; see README "Dette").
 *
 * Env:
 *   KPHI_SANDBOX_SECRET     shared with the MCP server (required to enable)
 *   SANDBOX_TOKEN_TTL_SEC   default 300
 *   SANDBOX_TTL_HOURS       default 24 (unclaimed tenant lifetime)
 *   SANDBOX_PURGE_EVERY_MIN default 60
 *   SANDBOX_MAX_ENTRIES     default 200000 (per-tenant cap, below the 2M default)
 *
 * Mount in server.js with the same ctx as routes/auth:
 *   require('./routes/sandbox')(app, ctx);
 * Then: node tools/route-table.js --write   (gate 1)
 */
'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

module.exports = function mountSandbox(app, ctx) {
  const { q, q1, run, saveMaster, SLog, auditLog } = ctx;
  const SECRET = process.env.KPHI_SANDBOX_SECRET;
  const TOKEN_TTL = parseInt(process.env.SANDBOX_TOKEN_TTL_SEC || '300', 10);
  const TTL_HOURS = parseInt(process.env.SANDBOX_TTL_HOURS || '24', 10);
  const EVERY_MIN = parseInt(process.env.SANDBOX_PURGE_EVERY_MIN || '60', 10);
  const MAX_ENTRIES = parseInt(process.env.SANDBOX_MAX_ENTRIES || '200000', 10);
  const NAME_PREFIX = 'MCP-';

  const JWT_SECRET = ctx.JWT_SECRET || process.env.JWT_SECRET;
  /* Routes are ALWAYS registered so tools/route-table.js sees the same table
     in every environment (gate 1 invariant). Enablement is decided per
     request: without KPHI_SANDBOX_SECRET every call is a 404 and the purge
     cron never starts. */
  const ENABLED = !!(SECRET && JWT_SECRET);
  if (!ENABLED) SLog.info('SANDBOX', 'disabled (KPHI_SANDBOX_SECRET or JWT_SECRET unset) — routes registered, all 404');

  function secretOk(req) {
    if (!ENABLED) return false;
    const given = req.headers['x-sandbox-secret'];
    if (!given || given.length !== SECRET.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(SECRET));
  }
  /* Disabled → 404 (not 401): the feature does not exist on this deployment,
     and a 404 leaks nothing about whether a secret is configured. */
  function gate(req, res) {
    if (!ENABLED) { res.status(404).json({ error: 'not found' }); return false; }
    if (!secretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return false; }
    return true;
  }

  /* tenants.created_at is TEXT written as datetime('now') elsewhere, i.e.
     'YYYY-MM-DD HH:MM:SS' (UTC, no T/Z). Write and compare in that exact
     shape so lexical comparison is correct on both Postgres and SQLite. */
  function sqlNow(msOffset) {
    return new Date(Date.now() + (msOffset || 0)).toISOString().slice(0, 19).replace('T', ' ');
  }

  function sandboxName() {
    const ts = sqlNow().replace(/[-: ]/g, '');   /* YYYYMMDDHHmmss */
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   /* no 0/O/1/I */
    let tag = '';
    for (const b of crypto.randomBytes(3)) tag += alphabet[b % alphabet.length];
    return `${NAME_PREFIX}${tag}-${ts}`;
  }

  function serviceToken(tid) {
    /* owner: /api/gl/import and DELETE /api/versions need writeAuth.
       No csrf claim → auth() skips the CSRF check (API-client path). */
    return jwt.sign({ userId: 'svc:mcp-public', tenantId: tid, role: 'owner', svc: 'mcp-public' },
                    JWT_SECRET, { expiresIn: TOKEN_TTL });
  }

  /* ── create sandbox tenant + service token ────────────────────── */
  app.post('/api/internal/sandbox/tenant', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const tid = crypto.randomBytes(16).toString('hex');   /* same shape as /api/auth/register */
      const name = sandboxName();
      /* Same INSERT as register minus the trial (a sandbox is not a trial),
         with a tighter entry cap. plan='free' so a claimed sandbox is
         indistinguishable from a real free tenant. */
      await run(ctx.masterDb,
        "INSERT INTO tenants (id,name,plan,max_users,max_entries,created_at,status) VALUES (?,?,'free',5,?,?,'active')",
        [tid, name, MAX_ENTRIES, sqlNow()]);
      saveMaster();
      auditLog(tid, 'svc:mcp-public', 'SANDBOX_TENANT_CREATE', { name });
      res.json({ tenantId: tid, name, token: serviceToken(tid), expires_in: TOKEN_TTL });
    } catch (e) {
      SLog.error('SANDBOX', 'tenant create failed', { error: e.message });
      res.status(500).json({ error: 'sandbox create failed' });
    }
  });

  /* ── token for an EXISTING sandbox tenant ─────────────────────── */
  app.post('/api/internal/sandbox/token', async (req, res) => {
    if (!gate(req, res)) return;
    const tid = String((req.body && req.body.tenantId) || '');
    if (!/^[a-f0-9]{32}$/.test(tid)) return res.status(400).json({ error: 'tenantId required' });
    const t = await q1(ctx.masterDb, 'SELECT id, name FROM tenants WHERE id=?', [tid]);
    /* Never mint a service token for a real tenant. */
    if (!t || !String(t.name || '').startsWith(NAME_PREFIX)) return res.status(404).json({ error: 'not a sandbox tenant' });
    res.json({ token: serviceToken(tid), expires_in: TOKEN_TTL });
  });

  /* ── purge unclaimed sandboxes ─────────────────────────────────── */
  async function purgeStale() {
    try {
      const cutoff = sqlNow(-TTL_HOURS * 3600 * 1000);
      /* Unclaimed = no verified human user (hotline seed excluded, exactly as
         the auth.js reaper does). */
      const rows = await q(ctx.masterDb,
        "SELECT t.id, t.name FROM tenants t WHERE t.name LIKE ? AND t.created_at < ? " +
        "AND NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id=t.id AND u.email_verified=1 AND u.email NOT LIKE 'hotline+%')",
        [NAME_PREFIX + '%', cutoff]);
      let n = 0;
      for (const t of rows) {
        await run(ctx.masterDb, 'DELETE FROM users WHERE tenant_id=?', [t.id]);
        await run(ctx.masterDb, 'DELETE FROM api_keys WHERE tenant_id=?', [t.id]);
        await run(ctx.masterDb, 'DELETE FROM tenants WHERE id=?', [t.id]);
        /* Postgres schema tenant_<id> intentionally left — same stance as
           routes/auth.js _purgeUnverified. See README "Dette". */
        n++;
      }
      if (n) { saveMaster(); auditLog('system', 'svc:mcp-public', 'SANDBOX_PURGE', { tenants: n }); }
      SLog.info('SANDBOX', 'purge', { stale: rows.length, deleted: n });
    } catch (e) {
      SLog.error('SANDBOX', 'purge failed', { error: e.message });
    }
  }
  if (ENABLED) {
    setInterval(purgeStale, EVERY_MIN * 60 * 1000).unref();
    setTimeout(purgeStale, 30 * 1000).unref();
    SLog.info('SANDBOX', 'enabled', { tokenTtl: TOKEN_TTL, purgeHours: TTL_HOURS, maxEntries: MAX_ENTRIES });
  }
};
