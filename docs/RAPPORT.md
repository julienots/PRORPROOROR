# Compte rendu de développement

## Point de départ

Le dépôt était **vide** (aucun commit, aucun fichier) : aucune ressource existante n'avait
à être préservée ; rien n'a été supprimé. Tout le projet a été créé dans cette session.

## Phases

| Phase | État | Contenu réalisé |
|---|---|---|
| 1. Audit & fondations | ✅ | Vite + TypeScript strict + three.js, RNG à graine, bruit simplex, unités, bus d'évènements |
| 2. Prototype cosmique | ✅ | Moteur de rendu, caméra double précision (rendu relatif à l'œil, profondeur logarithmique), sélection |
| 3. Mode Dieu | ✅ | Création (matière, étoiles, planètes, trous noirs, nébuleuses, matière noire), déplacement, poussée, collisions, destruction |
| 4. Simulation physique | ✅ | N-corps, Kepler séculaire, collisions/accrétion/fragmentation, limite de Roche, évolution stellaire, climat planétaire |
| 5. Trous noirs & matière noire | ✅ | ISCO de Kerr, accrétion/Eddington, ruptures de marée, fusions + ondes gravitationnelles, lentille géodésique ; halos (analyse, comparaison avec/sans) |
| 6. Galaxies & univers procéduraux | ✅ | Galaxies à traceurs (bulbe + disque + NFW + onde spirale), fusions, univers par secteurs, transitions d'échelle |
| 7. Big Bang | ✅ | Friedmann (Freeze/Crunch/Rip), époques, champ gaussien FFT 3D, Zel'dovich, halos → galaxies, adoption de l'univers |
| 8. Interface & sauvegardes | ✅ | Menu, barre d'outils, propriétés/éditeurs, catalogue, carte, chronologie, analyse, historique, comparaison, options, multi-univers versionnés |
| 9. Graphismes & optimisation | ✅ (base) | 3 préréglages qualité, LOD des terrains construits par tranches, budgets de particules et de calcul |
| 10. Validation | ✅ | 46 tests unitaires + 26 vérifications en navigateur, corrections et relances |

## Tests exécutés (résultats réels)

- `npm test` : **46/46** — reproductibilité (RNG, bruit, systèmes, univers), orbite terrestre
  (énergie conservée < 10⁻⁴), Kepler ≡ N-corps, Barnes–Hut (< 3 % d'erreur), évolution du
  Soleil, supernova 25 M☉ → trou noir, effondrement de nuage → protoétoile + planètes,
  formules de trous noirs, fusion type GW150914, binaire en mode N-corps et en mode Kepler,
  rupture de marée, climat (Terre déplacée → inhabitable), conservation de la quantité de
  mouvement, courbes de rotation avec/sans matière noire, fusion de galaxies, âge de
  l'univers Planck (13,8 Ga), Big Crunch, Big Rip, FFT 3D, Zel'dovich, laboratoire atomique
  (deutérium, recombinaison, ionisation, H₂O, O=O, désintégration β), annuler/rétablir,
  sauvegardes (aller-retour, versions, duplication, rejet des données invalides),
  performance (250 corps + 20 000 particules).
- `npm run test:e2e` : **26/26** dans Chromium headless (rendu logiciel SwiftShader) — menu,
  rendu non vide, temps/pause, vol de caméra, édition de planète avec conséquences, création
  via l'UI, supernova, lentille active, fusion de trous noirs, annuler, analyse, sauvegarde et
  rechargement, comparaison, galaxie, suppression de la matière noire, fusion de galaxies,
  génération reproductible, cosmos, Big Rip, laboratoire, subatomique, Big Bang complet,
  valeurs invalides, 300 corps, aucune erreur JavaScript.

### Bugs trouvés par les tests et corrigés

- Lentille gravitationnelle produisant un écran noir (direction des rayons calculée sur un
  plan lointain dégénéré → NaN propagé par le bloom).
- Rayonnement gravitationnel ignoré au-delà de 2 UA et en mode Kepler : les binaires de
  trous noirs ne fusionnaient jamais à forte accélération du temps.
- Géantes gazeuses à 2 200 K (effet de serre de surface appliqué à 1 000 atm).
- Création acceptée à une position NaN ; caméra ralentie quand le rendu est lent.
- Quantité de mouvement non conservée par les éjectas d'impact ; température initiale des
  planètes ; rayon terrestre (compression gravitationnelle).

## Itération 2 — Monde ouvert

| Élément | Réalisé |
|---|---|
| Passages d'échelle sans coupure | système ⇄ galaxie ⇄ cosmos : conversion exacte de la position et de l'orientation de la caméra (UA ↔ kal ↔ Mpc, repère du disque galactique), déclenchés par la position de l'œil avec hystérésis (sortie d'un système à 5 al, entrée à 3,5 al) |
| Ciels cohérents | ciel d'un système = étoiles de la galaxie simulée vues depuis l'étoile (direction, éclat ∝ L/d²) + bande alignée sur le vrai plan galactique + galaxies voisines réelles ; fond de la galaxie = galaxies voisines réelles |
| Vol libre | vitesse adaptative selon l'objet le plus proche, inertie, molette = vitesse de croisière, caméra co-mobile avec la rotation galactique |
| Voyage | pilote automatique vers une étoile voisine (clic dans le ciel) ou une galaxie ; génération du système à l'arrivée |
| Atterrissage | carré de terrain local (128–160², construit par tranches) avec relief fin, ciel atmosphérique jour/crépuscule/nuit, nuages vus par-dessous, rotation physique de la planète, marche/vol au sol, recherche d'un continent |
| Corrections | relief rendu réaliste (≈ 10 km au lieu de ×10), ordre des triangles du terrain local, étoiles du ciel masquées par le sol, systèmes sans objet central (nébuleuses) |

Tests ajoutés (en jeu) : atterrissage + déplacement au sol, sortie du système en vol libre
sans fondu, pilote automatique jusqu'à un nouveau système, galaxie → cosmos → galaxie.
Résultat : **30/30** vérifications en navigateur, **46/46** tests unitaires.

Limites spécifiques : le repère d'un système est supposé aligné sur le plan galactique ; les
étoiles de la galaxie sont des traceurs (chacun représente une population), d'où des
voisines distantes de quelques centaines d'années-lumière en qualité « performance » ; le
terrain local et le maillage global ne se raccordent pas parfaitement à moyenne altitude ;
le laboratoire microscopique reste relié par un fondu (représentation stylisée).

## Limitations connues (honnêtes)

- **Approximations physiques** (étiquetées dans le jeu) : évolution stellaire par relations
  d'échelle, géodésiques de Schwarzschild (le spin n'agit que sur l'ISCO et le disque), étoiles
  galactiques sans auto-gravité, chimie et nucléaire stylisés, effet de serre paramétrique,
  vie = modèle spéculatif, inflation et ère de Planck symboliques.
- L'amplification des ondes gravitationnelles est un **pouvoir divin** (sinon les fusions
  prendraient des milliards d'années) ; elle est réglable (1 = relativité réelle).
- Le passage du système stellaire à la surface est continu, mais la surface est un maillage
  global (jusqu'à 192 segments/face) : pas de pavage adaptatif kilométrique.
- Le son est entièrement synthétisé (pas de musique enregistrée).
- Sauvegardes dans `localStorage` (≈ 5 Mo) : particules sous-échantillonnées (12 000 max),
  40 systèmes visités conservés au plus.
- Testé en rendu logiciel uniquement (pas de GPU dans l'environnement) : les performances
  réelles sur GPU n'ont pas été mesurées ; en SwiftShader une image coûte ~100–400 ms.
- Interface tactile : gestes caméra (glisser, pincer) et mise en page étroite ; non testé sur
  un vrai appareil mobile.
- Le build produit un fichier JS d'environ 850 Ko (non découpé).

## Prochaines étapes suggérées

1. Pavage adaptatif (quadtree) des terrains pour l'exploration au sol.
2. Géodésiques de Kerr (spin) et disques épais.
3. Auto-gravité des galaxies sur GPU (particle-mesh) et fusions plus fidèles.
4. Stockage IndexedDB, compression des sauvegardes, partage d'univers par graine.
5. Mesures de performances sur GPU réels, découpage du bundle, Web Workers pour la physique.
6. Musique composée et spatialisation audio.
