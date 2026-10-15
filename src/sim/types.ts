import type { Vec3 } from '../core/vec';

/** Catégories d'objets du simulateur de système stellaire. */
export type BodyKind =
  | 'nebula' // nuage de gaz moléculaire
  | 'protostar'
  | 'star'
  | 'browndwarf'
  | 'whitedwarf'
  | 'neutronstar'
  | 'blackhole'
  | 'planet'
  | 'moon'
  | 'asteroid'
  | 'comet'
  | 'darkmatter'; // amas de matière noire (n'interagit que gravitationnellement)

/** Fractions massiques (somme = 1). */
export interface Composition {
  hydrogen: number; // H/He (gaz)
  rock: number; // silicates
  metal: number; // fer/nickel
  ice: number; // glaces volatiles
  water: number; // eau liquide/vapeur
  organic: number; // composés organiques
  heavy: number; // éléments lourds produits par les étoiles (métallicité « enrichie »)
}

export type StarPhase =
  | 'collapse' // nuage en contraction
  | 'protostar'
  | 'main'
  | 'subgiant'
  | 'redgiant'
  | 'supergiant'
  | 'planetarynebula'
  | 'whitedwarf'
  | 'neutronstar'
  | 'pulsar'
  | 'blackhole';

export interface StarState {
  phase: StarPhase;
  /** Masse initiale de séquence principale (M☉). */
  zamsMass: number;
  /** Métallicité Z (fraction d'éléments lourds). */
  metallicity: number;
  /** Âge depuis l'allumage (années). */
  age: number;
  luminosity: number; // L☉
  /** Durée de vie sur la séquence principale (années). */
  msLifetime: number;
  /** Période de rotation (jours). */
  rotationDays: number;
}

export interface BlackHoleState {
  /** Paramètre de spin de Kerr a* ∈ [0, 0.998]. */
  spin: number;
  /** Masse de matière dans le disque d'accrétion (M☉). */
  diskMass: number;
  /** Taux d'accrétion (M☉/an). */
  accretionRate: number;
  jets: boolean;
  /** Masse totale avalée (statistique). */
  swallowed: number;
  /** Axe de rotation (unitaire) — orientation du disque et des jets. */
  axis: Vec3;
  /** Luminosité d'accrétion courante (L☉). */
  luminosity: number;
  /** Phase finale d'une fusion en cours (visualisation de la coalescence). */
  merger?: BHMergerState;
}

export interface BHMergerState {
  m1: number;
  m2: number;
  startTime: number; // temps réel (s) d'animation écoulé
  duration: number; // s
  sep0Km: number;
  radiatedMass: number;
  peakFrequencyHz: number;
  phase: number;
}

export interface PlanetState {
  waterFraction: number; // 0..1 de surface couverte par l'eau (si liquide)
  continents: number; // 0..1 « fragmentation » des continents
  pressure: number; // atm
  rotationHours: number;
  axialTilt: number; // degrés
  volcanism: number; // 0..1
  magneticField: number; // relatif à la Terre
  albedo: number;
  greenhouse: number; // K de réchauffement à 1 atm
  life: number; // 0 aucune, 1 microbienne, 2 végétale, 3 complexe
  lifeTimer: number; // années de conditions habitables cumulées
  hasRings: boolean;
  ringInner: number; // rayons planétaires
  ringOuter: number;
  terrainSeed: number;
  /** Cratères ajoutés par des impacts (lat, lon en radians, rayon angulaire). */
  impacts: { lat: number; lon: number; size: number }[];
  gasGiant: boolean;
}

export interface NebulaState {
  /** Température du gaz (K). */
  gasTemperature: number;
  /** Densité numérique (particules/cm³). */
  density: number;
  /** Temps d'effondrement écoulé (années). */
  collapseProgress: number;
  /** Si le nuage est un rémanent de supernova en expansion. */
  remnant: boolean;
  expansionSpeed: number; // UA/an
  colorSeed: number;
}

export interface Body {
  id: number;
  name: string;
  kind: BodyKind;
  mass: number; // M☉
  radius: number; // km
  pos: Vec3; // UA
  vel: Vec3; // UA/an
  temperature: number; // K (surface / effective)
  composition: Composition;
  seed: number;
  createdBy: 'gen' | 'player';
  age: number;
  pinned?: boolean;
  /** Chaleur d'impact résiduelle (K) qui se dissipe avec le temps. */
  heat?: number;
  star?: StarState;
  bh?: BlackHoleState;
  planet?: PlanetState;
  nebula?: NebulaState;
  /** Corps dominant (calculé), pour l'affichage des orbites et le mode Kepler. */
  parentId?: number;
}

/** Particules-tests (débris, éjectas, anneaux de débris) — sans masse propre. */
export type ParticleKind = 0 | 1 | 2 | 3; // 0 débris rocheux, 1 éjecta stellaire, 2 gaz/plasma, 3 glace

export interface SimEvent {
  t: number; // temps de simulation (années)
  type:
    | 'create'
    | 'destroy'
    | 'collision'
    | 'merge'
    | 'supernova'
    | 'phase'
    | 'tidal'
    | 'swallow'
    | 'bhmerger'
    | 'life'
    | 'ignite'
    | 'info';
  message: string;
  bodyId?: number;
  pos?: Vec3;
  /** Grandeur caractéristique (énergie, masse…) pour les effets. */
  magnitude?: number;
}

export const emptyComposition = (): Composition => ({
  hydrogen: 0, rock: 0, metal: 0, ice: 0, water: 0, organic: 0, heavy: 0,
});

export function normalizeComposition(c: Composition): Composition {
  const keys = Object.keys(c) as (keyof Composition)[];
  let s = 0;
  for (const k of keys) {
    const v = Number.isFinite(c[k]) && c[k] > 0 ? c[k] : 0;
    c[k] = v;
    s += v;
  }
  if (s <= 0) {
    c.rock = 1;
    return c;
  }
  for (const k of keys) c[k] /= s;
  return c;
}

/** Mélange de compositions pondéré par les masses. */
export function mixComposition(a: Composition, ma: number, b: Composition, mb: number): Composition {
  const out = emptyComposition();
  const t = ma + mb || 1;
  for (const k of Object.keys(out) as (keyof Composition)[]) out[k] = (a[k] * ma + b[k] * mb) / t;
  return normalizeComposition(out);
}
