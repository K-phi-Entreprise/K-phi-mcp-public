# K-Phi — serveur MCP public (squelette)

Serveur MCP (Streamable HTTP, stateless) exposant l'analyse K-Phi aux assistants IA
(Claude, ChatGPT, Cursor, Copilot…). Accès anonyme rate-limité, upload signé pour les
gros fichiers, deep link vers K-Phi pour la conversion.

Voir `kphi-mcp-public-spec.md` pour la spec complète.

## Lancer

```bash
npm install
npm run dev            # compile + démarre sur :3000
curl localhost:3000/healthz
```

Variables d'environnement :

| Var | Défaut | Rôle |
|---|---|---|
| `PORT` | 3000 | |
| `PUBLIC_BASE_URL` | https://k-phi.com | base des liens `open_in_kphi_url` / `report_share_url` |
| `INGEST_BASE_URL` | http://localhost:PORT | base des liens d'upload signés |
| `UTM_SOURCE` | mcp | attribution |
| `KPHI_UPLOAD_STORAGE` | *(non défini)* | backend de stockage des uploads volumineux. **Non défini → upload désactivé** (refus honnête, `PUT` → 501). `tmp` → fichiers sous `os.tmpdir()/kphi-uploads`, `tmp:/chemin` → répertoire dédié (TTL 24 h, supprimés dès l'analyse réussie). `mock` → routage seul (moteur mock). Valeur inconnue → désactivé avec avertissement : on n'accepte jamais un fichier qu'on ne saura pas relire. |
| `KPHI_SANDBOX_MAX_ENTRIES` | 200000 | cap d'écritures de l'analyse anonyme — DOIT refléter `SANDBOX_MAX_ENTRIES` côté moteur. Dépassement → refus clair AVANT la création du sandbox (LimitError), au lieu d'un 429 à mi-import. |

## Tester dans Claude Desktop (avant référencement)

Ajouter dans `claude_desktop_config.json` (ou via *Paramètres → Connecteurs → Ajouter un connecteur personnalisé* avec l'URL publique) :

```json
{
  "mcpServers": {
    "k-phi": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp"]
    }
  }
}
```

Puis dans Claude : *« Voici mon export de grand livre, peux-tu m'analyser ça ? »* en collant
un CSV. Vérifier que `kphi_analyze_ledger` est appelé. Tester ensuite ~20 formulations
(ratios, DSCR, trésorerie, covenants, FEC, balance, « diagnostic financier »…) et ajuster
la description de l'outil dans `src/tools.ts` jusqu'à ce que le routage soit fiable.

## Structure

```
src/
  server.ts     endpoint /mcp (stateless), /upload/:token, /healthz
  tools.ts      les 4 outils + descriptions (= le pitch lu par le modèle)
  engine.ts     interface AnalysisEngine + MockEngine
  store.ts      interface Store + MemoryStore
  ratelimit.ts  session anonyme + quotas
```

## Brancher sur K-Phi (les 4 TODO)

1. **`engine.ts`** — implémenter `AnalysisEngine` avec votre moteur existant
   (`analyze` pour le CSV inline, `analyzeFromStorage` pour les fichiers déposés).
2. **`store.ts`** — remplacer `MemoryStore` par Postgres (schéma dédié `mcp_public`,
   purge à 30 j) ; jetons d'upload en base ou Redis.
3. **`server.ts` `/upload/:token`** — remplacer par une URL pré-signée S3/R2 + antivirus,
   et déclencher l'analyse sur événement plutôt qu'en ligne.
4. **`ratelimit.ts`** — quotas dans Redis ; ajouter la vérification OAuth 2.1 (Bearer)
   branchée sur votre auth existante pour lever les quotas des comptes.

Côté application K-Phi : route `/a/:analysis_id` qui crée un compte par magic link et
rattache l'analyse (c'est le point de conversion), et route `/r/:analysis_id` en lecture
seule partageable.

## Référencement

Prérequis habituels des annuaires : URL publique HTTPS, OAuth 2.1 ou accès anonyme
documenté, politique de confidentialité, contact support, description et icône.
Vérifier les critères à jour : https://docs.claude.com et https://support.claude.com
(Claude), documentation OpenAI pour ChatGPT, registry.modelcontextprotocol.io.
