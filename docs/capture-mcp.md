# K-φ Capture: the second MCP server

Beside the ledger analysis server (`src/server.ts`), this repository holds a second, separate server: `src/build/server.ts`. It lets an assistant look at how a finance team works and bring back the context, the scope and the improvement plan, with a sandbox shaped like the group. Several people of one company each run their own session; the captures are merged into one case, reviewed, then scoped.

The server holds no logic of its own. The contract, the merge, the conflicts, the block catalogue and every check are the engine's (K-phi-engine: `routes/capture.js`, `lib/capture-spec.js`, `lib/block-catalogue.js`, `lib/capture-apply.js`, `routes/build-sandbox.js`). Plan and status: `docs/capture-plugin.md` in K-phi-engine.

## Tools

| Tool | What it does |
|---|---|
| `capture_format` | The contract a capture, a scope and a plan must follow, and the K-φ block catalogue |
| `capture_open_case` | Opens a case for a company and returns the code colleagues join with |
| `capture_join_case` | Joins a colleague's case with its code |
| `capture_submit` | Adds one person's capture to the case |
| `capture_case` | The merged picture, its conflicts and its stage |
| `capture_review` | Records what a person settled on each conflict |
| `capture_scope` | Writes the scope and the plan |
| `capture_sandbox` | Builds the sandbox from the scope and returns its link |

## Running it

```
KPHI_ENGINE_URL=https://staging.k-phi.com KPHI_BUILD_SECRET=... node dist/build/server.js
```

It refuses to start without both variables. On the engine side, the same `KPHI_BUILD_SECRET` must be set, and `KPHI_SANDBOX_SECRET` too: without the second one the sandbox is built but its link answers 404.

## Deploying it (not done: a decision for the owner)

It is not in `render.yaml` yet, on purpose: adding it creates a second paid service. The block to add when decided:

```yaml
  - type: web
    name: kphi-mcp-capture
    env: node
    plan: starter
    buildCommand: npm install --include=dev && npm run build
    startCommand: node dist/build/server.js
    healthCheckPath: /healthz
    envVars:
      - key: PORT
        value: 3000
      - key: PUBLIC_BASE_URL
        value: https://k-phi.com
      - key: KPHI_ENGINE_URL
        sync: false
      - key: KPHI_BUILD_SECRET
        sync: false
      - key: NODE_ENV
        value: production
```

## Tests

`tests/capture-tools.test.mjs`: a real MCP server in memory on a scripted engine. Each tool reaches its route, the engine's refusal reasons come back word for word, a sandbox being prepared says so, an engine failure is said as such, the shared secret never appears in an answer.

Checked by hand against the real engine on 18 Nov 2026 (three separate sessions, the example company of K-phi-engine `contract/examples/`): case opened, joined twice with the code, a capture holding a figure refused, four conflicts settled, scope and plan written, sandbox built, link opening on the sandbox, and the sandbox written back as a spec with the companies, currencies and base currency the scope asked for.
