# Patch moteur — accès sandbox pour le MCP public

Un seul fichier à ajouter dans `K-phi-engine` : `routes/sandbox.js` (ci-joint).
Il n'y a **aucune modification** de `auth()`, de l'import, des statements ni de la
purge par version : tout existe déjà et est réutilisé tel quel. Le fichier ajoute
seulement (1) l'émission d'un JWT de service sur un tenant sandbox dédié, et
(2) un cron qui purge les versions `anon_*` de plus de 24 h.

`main` étant protégé (PR + 9 checks + `tools/ship.sh`), à passer par votre
process habituel. Le diff est volontairement minimal.

## 1. Créer le tenant sandbox (une fois)

Via l'ops-panel ou l'inscription normale : un tenant dédié, nommé par ex.
`mcp-public-sandbox`, **vide et qui doit le rester**. Récupérer son `id`
(colonne `tenants.id`). Ne pas y mettre de covenants, de budgets, de mappings :
rien ne doit jamais agréger « toutes les versions » sur ce tenant.

Vérifier `tenants.max_entries` pour ce tenant : c'est le plafond par analyse
anonyme (2 000 000 par défaut, largement suffisant).

## 2. Ajouter le fichier et le monter

```
cp routes/sandbox.js  <K-phi-engine>/routes/sandbox.js
```

Dans `server.js`, à côté des autres `require('./routes/...')(app, {...})`,
en passant le même `ctx` que `routes/auth` (il contient déjà `JWT_SECRET`,
`getTenantDb`, `saveTenant`, `SLog`, `auditLog`, `q`, `q1`, `run`, `masterDb`) :

```js
require('./routes/sandbox')(app, /* même objet ctx que routes/auth */);
```

Puis, gate 1 :

```
node tools/route-table.js --write
```

## 3. Variables d'environnement (Render, service k-phi)

| Var | Valeur |
|---|---|
| `KPHI_SANDBOX_SECRET` | secret long aléatoire (`openssl rand -hex 32`) |
| `KPHI_SANDBOX_TENANT_ID` | id du tenant créé en 1 |
| `SANDBOX_TOKEN_TTL_SEC` | 300 (défaut) |
| `SANDBOX_TTL_HOURS` | 24 (défaut) |

Sans `KPHI_SANDBOX_SECRET` + `KPHI_SANDBOX_TENANT_ID`, la route ne se monte pas
et le cron ne démarre pas : déployer le fichier avant les variables est sans effet.

## 4. Côté serveur MCP (Render, service kphi-mcp-public)

| Var | Valeur |
|---|---|
| `KPHI_ENGINE_URL` | `https://k-phi.com` (ou l'URL Render du moteur) |
| `KPHI_SANDBOX_SECRET` | **la même valeur** qu'en 3 |

Tant que ces deux variables sont absentes, le MCP reste sur le mock (log au
démarrage : `engine: MOCK`). Dès qu'elles sont là : `engine: K-Phi @ …`.

## 5. Vérifier

```
# 1. le moteur émet un token
curl -s -X POST https://k-phi.com/api/internal/sandbox/token -H "X-Sandbox-Secret: $S"
# → {"token":"…","expires_in":300}

# 2. une analyse de bout en bout via le MCP (voir README principal, tools/call kphi_analyze_ledger)
#    → detected.format = fec|csv, kpis non vides, raw.kpi rempli

# 3. plus aucune version anon_* sur le tenant sandbox après l'analyse
#    (GET /api/versions avec le token) — la purge immédiate a fonctionné
```

Le champ `raw` dans la réponse d'analyse contient `kpi` et `ratios` bruts du
moteur : il sert à ajuster `KPI_SPEC` dans `src/engine-http.ts` aux vrais noms
de clés de `modules/kpi.js`, puis à retirer.

## Sécurité

- Secret comparé en temps constant, jamais loggé.
- JWT de service : `role: owner` sur le **seul** tenant sandbox, 5 min, pas de
  claim `csrf` (donc pas de check CSRF, comme pour les clients API existants).
- Le tenant sandbox n'a aucun utilisateur humain, aucune donnée persistante.
- Les données d'un inconnu ne vivent que le temps de l'analyse (purge immédiate)
  ou 24 h max (cron) si la purge immédiate a échoué.
