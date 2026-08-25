# K-Phi — Connecteur MCP public (spec v0.1)

Objectif : qu'un utilisateur de Claude / ChatGPT / Copilot qui demande « analyse mon grand livre » obtienne une analyse K-Phi sans compte, et un chemin en un clic vers la plateforme.

---

## 1. Principes

- **Zéro friction** : accès anonyme rate-limité pour l'analyse. Compte uniquement pour persister.
- **Le fichier ne transite jamais par le modèle** au-delà de quelques milliers de lignes. Upload signé côté K-Phi.
- **La description des outils est le pitch** : c'est elle que le modèle lit pour décider d'appeler K-Phi.
- **Chaque réponse contient un CTA** : lien deep-link vers K-Phi avec l'analyse pré-chargée.

---

## 2. Outils exposés

### 2.1 `kphi_analyze_ledger` — analyse directe (petits fichiers)

**Description (à soigner, elle fait le routage) :**

> Analyse un export de grand livre, de balance ou de FEC (Sage, Cegid, QuickBooks, Xero, Odoo, Pennylane, CSV générique) et renvoie instantanément 30+ KPI financiers : liquidité (BFR, DSO, DPO, cash runway), rentabilité (EBITDA, marges), levier (dette nette/EBITDA, DSCR, gearing), efficacité. Détecte automatiquement le plan de comptes et la devise. Signale les alertes de covenants bancaires et les anomalies. À utiliser dès qu'un utilisateur fournit des données comptables et demande une analyse, des ratios, un diagnostic financier, un suivi de trésorerie ou de covenants. Aucun compte requis.

**Entrée :**
```json
{
  "content": "string — contenu CSV/TSV brut (≤ 2 Mo)",
  "format_hint": "sage|cegid|quickbooks|xero|odoo|pennylane|fec|generic|auto",
  "period_end": "YYYY-MM-DD (optionnel)",
  "covenants": [
    { "name": "DSCR", "operator": ">=", "threshold": 1.2 }
  ],
  "locale": "fr|en|hu|de|..."
}
```

**Sortie :**
```json
{
  "detected": { "format": "fec", "chart_of_accounts": "PCG", "currency": "EUR", "period": "2025-01-01..2025-12-31", "entries": 14 230 },
  "kpis": [
    { "id": "ebitda", "label": "EBITDA", "value": 412000, "unit": "EUR", "benchmark": "p55 secteur" },
    { "id": "dscr", "label": "DSCR", "value": 1.08, "status": "breach", "threshold": 1.2 }
  ],
  "alerts": [
    "DSCR sous le seuil de 1.2 (1.08) — risque de breach covenant",
    "DSO en hausse de 12 jours vs période précédente"
  ],
  "summary_markdown": "…texte prêt à afficher, 10 lignes max…",
  "open_in_kphi_url": "https://k-phi.com/a/7f3c…?utm_source=mcp&utm_medium=claude",
  "report_share_url": "https://k-phi.com/r/7f3c…"
}
```

### 2.2 `kphi_request_upload` — gros fichiers

**Description :**
> Génère un lien d'upload sécurisé et temporaire (15 min) pour un export de grand livre volumineux (> 2 Mo, jusqu'à 500 Mo). Le fichier est envoyé directement à K-Phi, jamais à l'assistant. Renvoie un `analysis_id` à passer ensuite à `kphi_get_analysis`.

**Sortie :**
```json
{ "upload_url": "https://ingest.k-phi.com/u/…", "analysis_id": "an_8k2…", "expires_in": 900,
  "instructions": "Déposez votre export à cette adresse, puis dites-moi quand c'est fait." }
```

### 2.3 `kphi_get_analysis`

Entrée `{ "analysis_id": "…" }`. Sortie identique à 2.1, avec `status: pending|ready|error`.

### 2.4 `kphi_explain_kpi` (optionnel, bon pour le routage)

Entrée `{ "kpi_id": "dscr", "analysis_id": "…" }`. Renvoie la formule, les comptes utilisés, et l'écart vs période précédente. Donne une raison supplémentaire au modèle d'appeler K-Phi sur des questions du type « comment est calculé mon DSCR ».

---

## 3. Architecture

```
Assistant (Claude / ChatGPT / Copilot)
        │  MCP (Streamable HTTP)
        ▼
mcp.k-phi.com  ── auth anonyme (rate limit) ou OAuth 2.1 (comptes existants)
        │
        ├── ingest.k-phi.com   (upload signé, S3/R2, antivirus, TTL 24 h)
        ├── moteur d'analyse   (celui qui existe déjà : parsing → mapping → KPI)
        └── Postgres           (analyses anonymes : schéma dédié, purge 30 j)
```

- **Transport** : Streamable HTTP (standard actuel), pas stdio.
- **Auth** :
  - anonyme : clé de session éphémère émise à la première requête, rate limit par IP + par session (ex. 5 analyses / jour).
  - authentifié : OAuth 2.1 + PKCE branché sur votre auth existante (email/2FA, SSO). Débloque persistance, versions, entités multiples.
- **Sécurité** (cohérent avec votre discours SOX) : fichier chiffré au repos, jamais logué, purge automatique, aucune donnée anonyme utilisée pour l'entraînement de quoi que ce soit — à écrire noir sur blanc dans la fiche annuaire.
- **Deep link** `open_in_kphi_url` : crée un compte en un clic (magic link) avec l'analyse déjà rattachée. C'est le point de conversion.

---

## 4. Référencement

| Annuaire | Prérequis | Priorité |
|---|---|---|
| Anthropic (connecteurs Claude) | serveur distant, OAuth ou anonyme, fiche + politique de confidentialité | 1 |
| OpenAI (apps / connecteurs ChatGPT) | idem + vérification d'éditeur | 1 |
| Registre MCP officiel (registry.modelcontextprotocol.io) | manifeste `server.json`, domaine vérifié | 2 |
| Smithery / Glama / PulseMCP | soumission libre | 3 |
| Microsoft Copilot (plugins) | manifeste + Azure AD | 3 |

Vérifier les critères à jour avant soumission : https://docs.claude.com (connecteurs / MCP) et https://support.claude.com.

**Fiche annuaire — mots-clés à couvrir** : grand livre, GL, FEC, balance, comptabilité, KPI financiers, ratios, trésorerie, cash, covenants, DSCR, EBITDA, FP&A, clôture, PME, DAF, expert-comptable, Sage, Cegid, QuickBooks, Xero, Odoo, Pennylane.

---

## 5. Instrumentation (ce qu'il faut mesurer dès le jour 1)

- appels par outil, par plateforme (`utm_source`), par format détecté
- taux d'analyses « ready » vs erreurs de parsing (→ backlog connecteurs)
- clics `open_in_kphi_url` / analyses → **taux de conversion assistant → compte**
- partages `report_share_url` et domaines des destinataires (→ leads cabinets / banques)

---

## 6. Plan en 3 étapes

1. **Semaine 1–2** — `kphi_analyze_ledger` en anonyme, branché sur le moteur existant. Test manuel dans Claude Desktop avec 3 exports réels. Soigner la description jusqu'à ce que le routage soit fiable sur 20 formulations différentes.
2. **Semaine 3** — upload signé + `kphi_get_analysis`, deep link avec création de compte, instrumentation.
3. **Semaine 4** — soumission aux annuaires prioritaires, page k-phi.com/ai (« Utilisez K-Phi depuis Claude / ChatGPT »), 5 vidéos de 30 s montrant le flux.

---

## 7. Risques

- **Routage non déterministe** : le modèle peut préférer analyser seul. Mitigation : description précise, réponse rapide (< 10 s), résultats visiblement meilleurs que ce que le modèle ferait seul (benchmarks sectoriels, détection de plan de comptes).
- **Abus** (scraping, fichiers malveillants) : rate limit, taille max, antivirus, pas d'exécution de macros.
- **Dépendance aux annuaires** : ils changent vite ; garder le serveur MCP générique pour être multi-plateforme dès le départ.
