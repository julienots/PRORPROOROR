# DEMIURGE — Dieu du cosmos (studio SUPERESSENCE) · Plan de développement

## 0. Audit initial

Le dépôt `PRORPROOROR` était **vide** au démarrage (aucun commit, aucun fichier,
aucune ressource). Il n'y avait donc aucun fichier, texture, son ou scène à
préserver. Le projet est créé à partir de zéro.

## 1. Choix technologiques

| Besoin | Choix | Raison |
|---|---|---|
| Plateforme | Navigateur (WebGL2) | Aucune installation, PC + tactile, testable en CI headless |
| Moteur 3D | three.js 0.180 | Mature, shaders GLSL personnalisés, post-traitement |
| Langage | TypeScript strict | Architecture modulaire, sûreté des types |
| Build | Vite 7 | Démarrage instantané, build statique |
| Tests logiques | Vitest | Tests de la simulation sans navigateur |
| Tests en jeu | playwright-core + Chromium | Vérification réelle du rendu et de l'UI |
| Audio | Web Audio API (synthèse procédurale) | Pas de fichiers lourds, musique adaptative |

## 2. Architecture

```
src/
  core/      RNG à graine, bruit, unités & constantes, vecteurs f64, bus d'évènements
  sim/       Simulation pure (aucune dépendance au rendu) :
             world (N-corps), gravity (direct + Barnes-Hut), integrator (leapfrog adaptatif,
             Kepler universel), collisions, stellar (évolution), blackhole (Kerr simplifié,
             fusion + ondes gravitationnelles), planet (dérivés physiques, habitabilité),
             matter (catalogue), micro (laboratoire atomique), galaxy (potentiels
             disque/bulbe/halo NFW, fusion restreinte), cosmology (Friedmann), bigbang
             (Zel'dovich + catalogue de halos), history (annuler/rétablir)
  procgen/   Génération procédurale reproductible : univers par secteurs, galaxies,
             systèmes stellaires, terrains planétaires
  render/    three.js : vues par échelle (cosmique, galactique, stellaire/planétaire,
             microscopique, Big Bang), shaders (étoiles, planètes, atmosphères, nuages,
             anneaux, nébuleuses volumétriques, lentille gravitationnelle par lancer de
             rayons géodésiques), post-traitement (bloom, tonemapping)
  camera/    Modes libre, orbitale, suivi, cinématique, microscope, cosmique, carte
  ui/        Interface HTML/CSS : menu principal, barre des pouvoirs, panneaux, éditeurs
  save/      Sérialisation versionnée, validation, stockage multi-univers, export JSON
  audio/     Ambiance, sons d'interface, musique adaptative
```

### Multi-échelle

Les ordres de grandeur (10⁻¹⁵ m → 10²⁶ m) dépassent la précision d'un double. Le jeu
utilise donc une **hiérarchie de contextes d'échelle**, chacun avec son unité et ses
coordonnées locales, reliés par un zoom logarithmique continu :

`subatomique ↔ atomique ↔ microscopique ↔ planétaire ↔ stellaire ↔ galactique ↔ cosmique`

* Dans chaque contexte : **rendu relatif à la caméra** (origine flottante) en float64
  côté CPU, tampon de profondeur logarithmique côté GPU.
* Dépasser un seuil de zoom fait basculer dans le contexte parent/enfant à la position
  correspondante (l'étoile cliquée dans la galaxie devient le système stellaire, etc.).
* Les systèmes et galaxies sont générés **à la demande** depuis une graine dérivée
  (graine univers → galaxie → étoile) ; seuls les systèmes modifiés par le joueur sont
  stockés.

### Niveaux de modèle physique

| Échelle | Modèle |
|---|---|
| Subatomique / atomique | Particules + règles de liaison simplifiées (stylisé) |
| Système stellaire | N-corps gravitationnel exact (leapfrog adaptatif) + mode Kepler séculaire |
| Galaxie | Particules-traceurs dans un potentiel analytique (bulbe + disque + halo NFW + bras spiraux) |
| Fusion de galaxies | N-corps restreint (Toomre & Toomre 1972) |
| Univers | Équations de Friedmann + approximation de Zel'dovich |

Chaque fonctionnalité est étiquetée dans l'interface :
**[Science établie]**, **[Approximation]** ou **[Pouvoir divin]**.

## 3. Phases

1. **Audit & fondations** — config, core (RNG, bruit, unités), bus d'évènements.
2. **Prototype cosmique** — renderer, caméra, système stellaire, sélection.
3. **Mode Dieu** — création/modification/destruction, catalogue de matière.
4. **Simulation physique** — N-corps, collisions, marée, évolution stellaire.
5. **Trous noirs & matière noire** — lentille par géodésiques, disque, jets, fusion, OG,
   halos et courbes de rotation.
6. **Galaxies & univers procéduraux** — vue galactique, vue cosmique, transitions.
7. **Big Bang** — laboratoire cosmologique, séquence d'époques, adoption de l'univers.
8. **Interface & sauvegardes** — panneaux, historique, comparaison, multi-univers.
9. **Graphismes & optimisation** — qualité/performance, LOD, culling.
10. **Validation** — tests automatisés + tests en jeu headless, corrections.

L'avancement réel est documenté dans `docs/RAPPORT.md`.
