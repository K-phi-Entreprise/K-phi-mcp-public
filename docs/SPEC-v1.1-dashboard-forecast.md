# SPEC v1.1 — Dashboard = maquette, moteur = seule source (ENGAGEMENT)

Ratifié avec le fondateur le 2026-08-26. Définition de FINI : la page /a/:id
et la maquette `kphi_explorer_forecast_fusionne` (+ table par périmètre)
sont INDISTINGUABLES. Aucune logique de projection côté MCP — jamais.

## Principe (verbatim fondateur)
« Ne pas réinventer la roue : réutiliser la méthodologie et le moteur K-Φ.
Forecast par entité (défaut), global, par BU, par tiers — et pour chacun,
DSO/DPO appliqués depuis l'input (GL). C'est le cœur du moteur. »
Le wizard découpe déjà en périodes comptables → les versions mensuelles
existent ; _dsoByEntity/_dpoByEntity/_dsoByBU existent ; FC_PROJ/fcBlocked
existent. v1.1 = EXPOSER, pas inventer.

## PR moteur (K-phi-engine)
`GET /api/statements?...&fc=1&scope=entity|global|bu|tp[&scope_id=X]`
Ajoute au payload, calculé par runEngine (rien de neuf) :
- `fc`: FC_PROJ du périmètre ; `fcBlocked`: raisons telles quelles
- `series_by_scope`: { period → {revenue, ebitda, personnel, other_opex} }
  par valeur de scope (les composantes → le mode Stacked de la maquette)
- `wc_methods`: { scope_id → { dso, dpo, dio, source:"gl_observed" } }
Gates inchangés (genre, COGS absent → stocks bloqués). route-table --write.

## PR MCP
- analyze/get_analysis : `forecast_scope` optionnel (défaut "entity")
- result additif (report_version 1.1) : `forecast{horizon,methods[
  {category,method,scope,input_value,input_source}],series,blocked_reason}`,
  `series_by_scope`, `wc_by_scope`
- /a/:id : dropdowns Entité/BU (valeurs du résultat), curseur de période,
  modes Waterfall|Stacked|Mensuel, bouton Projeter → projection grise +
  cartes méthodes « DSO 141 j (observé GL, MER-DE) », table KPI par
  périmètre avec colonne Proj. — chaque contrôle relit le résultat
  persisté ; zéro appel moteur depuis le navigateur ; zéro calcul MCP.
- Réserves conso/FX : héritées telles quelles dans forecast.caveats[].

## Ordre d'exécution (session suivante, avant toute autre demande)
① store persistant (les liens survivent aux deploys) → ② cumulation bilan
des balances multi-périodes → ③ devise détectée propagée → PR moteur fc=1
→ PR MCP v1.1 → dashboard fidèle. Toute déviation de cette spec doit être
argumentée par écrit dans la PR.

## Constats du 2026-08-26 (test fondateur, à intégrer)
1. Le bouton-redirection vers l'app était un pis-aller CONTRAIRE au principe :
   le forecast se REND dans la page /a/:id (HTML Claude), calculé par le
   moteur. Le bouton devient le déclencheur du panneau inline dès ?fc=1.
2. Bug d'entitlement découvert : le tenant sandbox n'a PAS le module
   forecast dans l'UI (« You don't have access to this module »). ?fc=1 via
   /api/statements passe par runEngine et CONTOURNE les droits de modules
   UI — vérifier ce contournement en test, et décider côté produit si le
   module s'ouvre aussi aux sandbox dans l'app.

## PRIORITÉ 0 (2026-08-26, exigence fondateur : « je le veux SYSTÉMATIQUEMENT »)
Le systématique = ce que le CLIENT rend, jamais ce que le relais veut bien
écrire. Deux étages :
a) FAIT : resource_link en PREMIER bloc de contenu — carte rendue par
   l'hôte à chaque appel, avant le texte du relais.
b) À IMPLÉMENTER EN PREMIER (avant même les fondations) : le dashboard
   /a/:id embarqué comme ressource HTML interactive (MCP Apps / UI
   embarquée) — la page ELLE-MÊME rendue DANS la conversation à chaque
   analyse, tuiles + graphique + covenants inline, zéro clic, zéro relais.
   Vérifier le support du SDK épinglé ; sinon bump SDK dans la même PR.
