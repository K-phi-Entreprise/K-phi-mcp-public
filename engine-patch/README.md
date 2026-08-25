# Patch moteur — tenants sandbox pour le MCP public

Un seul fichier à ajouter dans `K-phi-engine` : `routes/sandbox.js` (ci-joint).
**Aucune modification** de `auth()`, de l'import, des statements : tout existe et
est réutilisé tel quel. Le fichier ajoute :

1. `POST /api/internal/sandbox/tenant` — crée un tenant **par analyse anonyme**,
   nommé `MCP-<XYZ>-<YYYYMMDDHHmmss>` (UTC), et renvoie un JWT de service
   `owner` sur ce tenant (5 min).
2. `POST /api/internal/sandbox/token` — ré-émet un JWT pour un tenant sandbox
   existant (jamais pour un tenant réel : vérifié par le préfixe `MCP-`).
3. Un cron qui supprime les tenants `MCP-*` de plus de 24 h **non réclamés**
   (aucun utilisateur humain vérifié).

`main` étant protégé (PR + 9 checks + `tools/ship.sh`), à passer par votre
process. Diff minimal, un fichier.

## Pourquoi un tenant par analyse

La conversion. Quand un prospect clique « conserver mon analyse » depuis Claude,
le tenant qui contient ses données existe déjà, avec son plan de comptes détecté
et ses KPI. Réclamer = créer un utilisateur dans ce tenant. Zéro migration.

## Convention de nommage

`tenants.name` = `MCP-K7Q-20260825141530`. L'`id` reste 32 hex comme partout :
`getTenantDb()` dérive le schéma Postgres en retirant tout ce qui n'est pas hex
de l'id, donc un id lisible entrerait en collision. Le nom lisible est dans la
colonne d'affichage, celle que montre l'ops-panel.

## 1. Ajouter le fichier et le monter

```
cp routes/sandbox.js  <K-phi-engine>/routes/sandbox.js
```

Dans `server.js`, avec le même `ctx` que `routes/auth` (il contient déjà
`JWT_SECRET`, `masterDb`, `q`, `q1`, `run`, `saveMaster`, `SLog`, `auditLog`) :

```js
require('./routes/sandbox')(app, /* même objet ctx que routes/auth */);
```

Puis gate 1 : `node tools/route-table.js --write`

## 2. Variables d'environnement (Render, service k-phi)

| Var | Valeur |
|---|---|
| `KPHI_SANDBOX_SECRET` | `openssl rand -hex 32` |
| `SANDBOX_TTL_HOURS` | 24 (défaut) — durée de vie d'un tenant non réclamé |
| `SANDBOX_MAX_ENTRIES` | 200000 (défaut) — plafond par analyse |

Sans `KPHI_SANDBOX_SECRET`, rien ne se monte : déployer le fichier avant la
variable est sans effet.

## 3. Côté serveur MCP (Render, service kphi-mcp-public)

| Var | Valeur |
|---|---|
| `KPHI_ENGINE_URL` | `https://k-phi.com` (ou l'URL Render du moteur) |
| `KPHI_SANDBOX_SECRET` | **la même valeur** qu'en 2 |

Tant que ces deux variables sont absentes, le MCP reste sur le mock (log au
démarrage : `engine: MOCK`).

## 4. Réclamation (côté plateforme, à construire)

Le lien « ouvrir dans K-Phi » arrive sur `https://k-phi.com/a/<analysis_id>?tenant=<32hex>&ver=<ver>&utm_source=mcp`.
La page doit : afficher l'analyse (lecture du tenant via un token de service ou
une session temporaire), demander un email, envoyer un magic link, et au clic
créer l'utilisateur **dans ce tenant** avec `email_verified=1` et `role=owner`.
C'est ce `email_verified=1` qui marque le tenant comme réclamé et le sort de la
purge. Renommer le tenant au passage (`MCP-…` → nom de la société) est
optionnel mais propre : le préfixe `MCP-` est ce que le cron et
`/sandbox/token` utilisent pour reconnaître un sandbox.

## 5. Vérifier

```
S=…  # KPHI_SANDBOX_SECRET
curl -s -X POST https://k-phi.com/api/internal/sandbox/tenant -H "X-Sandbox-Secret: $S"
# → {"tenantId":"…32hex…","name":"MCP-XYZ-20260825141530","token":"…","expires_in":300}
```
Puis une analyse via le MCP (`kphi_analyze_ledger`) : `structuredContent.sandbox`
doit contenir `tenant_id`, `tenant_name`, `ver`, et le tenant doit apparaître
dans l'ops-panel avec ses écritures. 24 h plus tard, sans réclamation, il a disparu.

Le champ `raw` de la réponse contient `kpi` et `ratios` bruts du moteur : il
sert à caler `KPI_SPEC` dans `src/engine-http.ts` sur les vrais noms de clés de
`modules/kpi.js`, puis à retirer.

## Sécurité

- Secret comparé en temps constant, jamais loggé.
- JWT de service `role: owner`, 5 min, pas de claim `csrf` (chemin client API
  existant), émis uniquement pour des tenants `MCP-*`.
- Un tenant sandbox n'a aucun utilisateur tant qu'il n'est pas réclamé.

## Dette (existante, pas introduite ici)

La purge fait `DELETE FROM tenants` mais **laisse le schéma Postgres**
`tenant_<id>` en place, exactement comme `_purgeUnverified` dans
`routes/auth.js` : le repo ne contient aucun `DROP SCHEMA`. À volume public,
ça finira par compter. Recommandation : un `DROP SCHEMA IF EXISTS tenant_<id>
CASCADE` derrière un flag (`SANDBOX_DROP_SCHEMA=1`), après une période
d'observation, et appliqué aussi au reaper existant.
