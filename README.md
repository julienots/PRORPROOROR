# DEMIURGE — Dieu du cosmos

*Un jeu du studio **SUPERESSENCE**.*

Simulateur cosmique 3D jouable dans le navigateur : vous incarnez une divinité capable de
créer, modifier, détruire et faire évoluer un univers, des quarks aux galaxies.

## Lancer le jeu

Prérequis : Node.js ≥ 20 et un navigateur compatible WebGL 2 (Chrome, Edge, Firefox récents).

```bash
npm install          # dépendances
npm run dev          # serveur de développement → http://localhost:5173
npm run build        # vérification des types + build de production dans dist/
npm run preview      # sert le build de production → http://localhost:4173
```

Options d'URL : `?quality=performance|equilibre|qualite` (préréglage graphique),
`?autostart` (saute le menu principal), `?nosplash` (saute l'écran du studio).

## Tests

```bash
npm test             # 46 tests unitaires de la simulation (Vitest)
npm run build && npm run test:e2e   # 30 vérifications en jeu dans Chromium headless
```

Les tests en jeu (`scripts/e2e.mjs`) pilotent l'interface et l'API de diagnostic
`window.__SUPERESSENCE__`, et enregistrent des captures dans `test-results/`.
Variable `CHROMIUM_PATH` pour indiquer un autre exécutable Chromium.

## Commandes

| Action | Commande |
|---|---|
| Tourner / déplacer la vue | glisser (clic gauche) / clic droit ou Maj + glisser |
| Zoom multi-échelle | molette ou pincement — au-delà des limites, changement d'échelle |
| Sélectionner / rejoindre | clic / double-clic (ou **F**) |
| Temps | **Espace** pause, **[** ralentir, **]** accélérer |
| Outils divins | **S** sélection, **M** déplacer, **C** créer, **P** pousser, **K** collision, **X** détruire |
| Divers | **A** analyse, **V** mode caméra, **Tab** carte, **H** masquer l'interface, **Ctrl+Z/Y/S** |
| Vol libre (**G**) | ZQSD / WASD, E / C, Maj pour accélérer, molette = vitesse de croisière |
| Atterrir / décoller (**L**) | au sol : ZQSD / WASD, glisser pour regarder, molette ou E / C pour l'altitude |

## Monde ouvert

L'univers est **continu**, sans écran de chargement ni fondu entre les échelles :

- **Vol libre** partout, avec une vitesse qui s'adapte à l'objet le plus proche (mètres par
  seconde au sol, multiples de la vitesse de la lumière entre les étoiles — pouvoir divin).
- En sortant d'un système stellaire (≈ 5 années-lumière), on se retrouve **parmi les étoiles de
  la galaxie simulée** ; en s'approchant d'une étoile (≈ 3,5 al), on entre dans **son système,
  généré à la demande** à partir d'une graine (reproductible) ; les systèmes modifiés sont conservés.
- En sortant de la galaxie, on rejoint la **toile cosmique**, générée par secteurs autour de
  la caméra ; en plongeant vers une galaxie, on y entre, dans la bonne orientation.
- Le **ciel** de chaque système est fait des vraies étoiles de la galaxie (direction et éclat
  réels) et des vraies galaxies voisines : ce que l'on voit de loin est ce que l'on rejoint.
- **Pilote automatique** : cliquer sur une étoile voisine (★) dans le ciel, ou « Voyager » sur
  une étoile/galaxie.
- **Atterrissage** sur toute planète ou lune solide : terrain local détaillé (relief, mers,
  biomes, neige), ciel atmosphérique jour/crépuscule/nuit, rotation réelle de la planète.

## Contenu

- **7 échelles reliées par le zoom** : subatomique → atomique → microscopique → planétaire →
  stellaire → galactique → cosmique, plus le laboratoire **Création d'un univers (Big Bang)**.
- **Mode Dieu** : catalogue de 11 types de matière, étoiles, planètes, trous noirs, nébuleuses,
  matière noire ; déplacer, pousser, collisions, impacts, supernovas, fusions, pulvérisation,
  fins d'univers ; annuler/rétablir, points de restauration, comparaison d'états.
- **Physique** : N-corps (leapfrog adaptatif, Barnes–Hut), mode Kepler séculaire, évolution
  stellaire, marées, trous noirs (ISCO de Kerr, accrétion, fusions, ondes gravitationnelles),
  planètes (climat, eau, atmosphère, habitabilité), galaxies (potentiel + halo NFW, fusions),
  cosmologie de Friedmann, structures par l'approximation de Zel'dovich, chimie stylisée.
- **Rendu** : lentille gravitationnelle par intégration de géodésiques, disque d'accrétion
  Doppler, nébuleuses volumétriques, terrains procéduraux, atmosphères, nuages, anneaux,
  éclipses, bloom HDR.
- **Sauvegardes** : plusieurs univers nommés, historique de versions, duplication,
  export/import JSON validé.

Voir `docs/PLAN.md` (architecture) et `docs/RAPPORT.md` (compte rendu, tests, limites).
