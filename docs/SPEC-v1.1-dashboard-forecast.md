# ★★★ PROCHAIN CHANTIER — HISTORIQUE MENSUEL PAR PÉRIMÈTRE, À LA DEMANDE (option A, validée 2026-08-27)

Dernier écart : changer de périmètre rescope tuiles, KPI, Sankey, projection,
méthodes et décomposition — mais PAS le graphique historique mensuel, qui
reste groupe.

Correction retenue : **A — chargement à la demande**. Aucune PR moteur
nécessaire : la boucle mensuelle du connecteur accepte déjà `?entity=` /
`?bu=` (c'est ce que fait le forecast). Il suffit de la rejouer scopée,
quand l'utilisateur le demande.

## Pourquoi A plutôt que B ou C
- B (tout d'avance) : 6 mois × 8 entités = 48 appels ajoutés à CHAQUE analyse,
  plusieurs secondes pour des courbes souvent jamais regardées.
- C (`series_by_scope` moteur) : le plus élégant à terme, mais touche le
  dépôt moteur ; à faire quand un chantier moteur s'ouvre.
- A : zéro coût sur l'analyse initiale, ~1 s au premier clic sur un périmètre,
  mis en cache ensuite.

## Implémentation
1. Route `GET /a/:id/series?scope=e:1000` (ou `b:CC-100`) :
   - relit le record persisté (token sandbox + versions déjà stockés) ;
   - rejoue la boucle mensuelle avec `entity=`/`bu=` ;
   - renvoie `[{period, revenue, ebitda}]` ;
   - MET EN CACHE dans le record (`series_by_scope[scope]`) : un périmètre
     n'est calculé qu'une fois, y compris entre deux visites du lien.
   - Si le tenant sandbox a expiré (24 h) : 410 + message explicite.
2. Dashboard : au changement de périmètre, si la série du périmètre n'est pas
   déjà en mémoire, afficher un état de chargement SUR le graphique (pas de
   page bloquée), appeler la route, redessiner. Échec → garder l'historique
   groupe avec une mention, jamais une courbe fausse.
3. Retirer de la barre la mention « the historical chart stays group-level ».
4. Le mode Waterfall suit alors le périmètre lui aussi (il dérive des mêmes
   séries) — l'asymétrie Sankey scopé / Waterfall groupe disparaît.

## Critères d'acceptation
1. Sélectionner une entité redessine l'historique mensuel sur SES chiffres,
   en moins de ~2 s, sans recharger la page.
2. Revenir sur « All entities » restaure l'historique groupe sans appel.
3. Deuxième sélection du même périmètre : instantanée (cache).
4. Aucun coût ajouté à l'analyse initiale (mesuré : durée inchangée).
5. Lien expiré ou appel en échec → l'historique groupe reste affiché avec une
   mention, jamais de valeurs inventées ni de graphique vide.

---

# ★★ v1.2 — NON NÉGOCIABLE : LE PÉRIMÈTRE PILOTE TOUTE LA PAGE (2026-08-27)

Exigence fondateur, verbatim : « scope should be on very top and drive all
figures & charts on that page » — puis : « actually same goes for analytics
discovered in the file ».

Le sélecteur en tête est livré (#55). Ce qu'il ne pilote PAS encore : les
agrégats RÉELS (tuiles, KPI, graphique historique), pour les entités comme
pour les valeurs d'axe analytique. Deux chantiers, dans cet ordre.

## ① PR moteur — `series_by_scope` (débloque tout le reste)
`GET /api/statements?...&fc=1&entity=X` (ou `&bu=X`) renvoie EN PLUS :
- `series_by_scope`: { period → { revenue, ebitda, personnel, other_opex } }
  pour le périmètre appelé ;
- `kpi_by_scope`: les mêmes id de KPI que le groupe, calculés sur le scope
  (au minimum : revenue, gross_profit, ebitda, ebitda_margin, net_income,
  dso, dpo, working_capital) ;
- `scope_coverage`: part des lignes du scope portant des comptes de bilan —
  pour dire honnêtement quand un ratio de position n'est pas calculable
  sur ce périmètre (cas mesuré : centre de profit = 81 % du P&L, 26 % du
  bilan sur l'export SAP réel).
Aucun calcul MCP : le connecteur relaie, le dashboard rend.

CRITÈRES D'ACCEPTATION v1.2 :
1. Changer le périmètre en tête met à jour : tuiles, KPI, graphique
   historique, covenants, projection, méthodes, décomposition.
2. Un KPI non calculable sur le périmètre s'affiche « — » avec la raison au
   survol, JAMAIS une valeur groupe présentée comme celle du périmètre.
3. La barre cesse d'afficher la réserve « les tuiles restent groupe » : elle
   n'a plus lieu d'être.
4. Le PDF exporte le périmètre sélectionné, titre inclus.

## ② Multi-axes dans UNE analyse (sans relancer)
Aujourd'hui le moteur n'a qu'un slot analytique (`bu`) + le tiers (`tp`) :
une analyse découpe sur UN axe, changer d'axe = relancer avec
`analytic_axis`. Cible : l'import porte TOUTES les dimensions détectées, et
le scoping devient générique — `?dim=<colonne>&val=<valeur>` — pour que le
sélecteur de tête bascule Profit center → Cost center → Segment sans
relancer. C'est ce que l'app K-Φ sait déjà faire ; le funnel doit s'aligner.

CRITÈRES D'ACCEPTATION :
1. Le sélecteur de tête liste : Global, chaque entité, puis chaque AXE
   détecté avec ses valeurs (groupées par axe).
2. Basculer d'axe ne relance rien : les données sont déjà là.
3. La couverture de chaque axe reste affichée (déjà livré, #54) et un axe
   sans comptes de bilan explique sa projection nulle (déjà livré).

## Ordre
① d'abord (extension du payload existant, débloque entités ET axes d'un
coup), ② ensuite (touche import + scoping moteur), ③ en continu : garder
nette la ligne de partage aperçu / plateforme — l'aperçu montre ce que le
fichier permet honnêtement, la plateforme fait FX, intercos et analytique
complet.

---

# ★ NON NÉGOCIABLE — FORECAST = CŒUR DE LA VALUE PROP (2026-08-26)

Exigence fondateur, verbatim : « we need a button — no matter what is asked.
Forecast by entity / global / by BU, exactly like in K-Φ. Auto-apply DSO/DPO
as we store it sliced & diced in K-Φ. Expand/drill down from the total
chart. It is non negotiable. »

ORDRE D'EXÉCUTION RÉVISÉ : le forecast passe DEVANT TOUT — y compris les
fondations, sauf dépendance technique stricte.

CRITÈRES D'ACCEPTATION (la PR qui ne les remplit pas tous ne merge pas) :
1. BOUTON « Projeter » toujours présent sur /a/:id — actif dès ?fc=1 ;
   clic → panneau INLINE dans la page (jamais une redirection).
2. Sélecteur de périmètre : Entité (défaut) | Global | BU — mêmes
   dimensions que K-Φ, mêmes agrégats. Changer le périmètre recalcule
   projection ET méthodes affichées.
3. DSO/DPO(/DIO) AUTO-APPLIQUÉS depuis les valeurs stockées par périmètre
   dans le moteur (_dsoByEntity/_dpoByEntity/_dsoByBU) — affichés sur les
   cartes de méthodes avec provenance : « DSO 141 j (observé GL, MER-DE) ».
   Jamais une valeur groupe appliquée à une entité.
4. DRILL-DOWN : le graphique total est dépliable — clic sur le total →
   décomposition par entité (puis BU) du réel ET de la projection, mêmes
   couleurs réel/gris-projeté.
5. Zéro calcul MCP : tout vient de runEngine (FC_PROJ, fcBlocked, règles) ;
   fcBlocked rendu tel quel (ex. stocks bloqués sans COGS).
6. Le bouton existe MÊME quand fc est bloqué : il ouvre le panneau avec
   les raisons — jamais absent, jamais un cul-de-sac.

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
