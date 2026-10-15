import type { Composition } from './types';

/**
 * Catalogue de la matière créable en mode Dieu.
 * Les propriétés sont celles réellement utilisées par la simulation.
 * `science` : 'etabli' (propriété mesurée), 'approx' (modèle simplifié), 'divin' (fiction).
 */
export type MatterId =
  | 'particles'
  | 'gas'
  | 'dust'
  | 'plasma'
  | 'rock'
  | 'ice'
  | 'water'
  | 'metal'
  | 'organic'
  | 'darkmatter'
  | 'energy';

export interface MatterType {
  id: MatterId;
  name: string;
  description: string;
  density: number; // kg/m³ (densité de référence pour un corps compact)
  defaultTemperature: number; // K
  charge: string;
  /** Contribution à la composition du corps créé. */
  composition: Partial<Composition>;
  /** Interagit-elle électromagnétiquement (collisions, lumière) ? */
  baryonic: boolean;
  color: string;
  science: 'etabli' | 'approx' | 'divin';
  scienceNote: string;
}

export const MATTER: Record<MatterId, MatterType> = {
  particles: {
    id: 'particles', name: 'Particules élémentaires', description: 'Protons, neutrons, électrons — ouvre le laboratoire atomique.',
    density: 0, defaultTemperature: 1e4, charge: 'p⁺ +1 · n⁰ 0 · e⁻ −1', composition: { hydrogen: 1 }, baryonic: true,
    color: '#9fd8ff', science: 'approx', scienceNote: 'Interactions nucléaires et électromagnétiques représentées par des règles simplifiées.',
  },
  gas: {
    id: 'gas', name: 'Gaz cosmique (H/He)', description: 'Nuage moléculaire froid. Au-delà de la masse de Jeans, il s\'effondre en protoétoile.',
    density: 1e-17, defaultTemperature: 20, charge: 'neutre', composition: { hydrogen: 0.98, heavy: 0.02 }, baryonic: true,
    color: '#ff7aa8', science: 'etabli', scienceNote: 'Critère de Jeans et temps de chute libre : physique établie, appliquée globalement au nuage.',
  },
  dust: {
    id: 'dust', name: 'Poussière cosmique', description: 'Grains de silicates et carbone ; s\'agrègent en planétésimaux.',
    density: 2000, defaultTemperature: 50, charge: 'faible', composition: { rock: 0.7, organic: 0.1, ice: 0.2 }, baryonic: true,
    color: '#b89a7a', science: 'approx', scienceNote: 'L\'accrétion de poussière est modélisée par fusion de corps, sans dynamique des grains.',
  },
  plasma: {
    id: 'plasma', name: 'Plasma', description: 'Gaz ionisé très chaud ; se dilate et rayonne.',
    density: 1e-6, defaultTemperature: 1e6, charge: 'ions + électrons libres', composition: { hydrogen: 1 }, baryonic: true,
    color: '#ffd27a', science: 'approx', scienceNote: 'Expansion thermique simplifiée ; pas de magnétohydrodynamique.',
  },
  rock: {
    id: 'rock', name: 'Matière rocheuse', description: 'Silicates : astéroïdes, planètes telluriques.',
    density: 3300, defaultTemperature: 250, charge: 'neutre', composition: { rock: 0.8, metal: 0.2 }, baryonic: true,
    color: '#8d7b6a', science: 'etabli', scienceNote: 'Densités et relations masse–rayon issues des planètes du Système solaire.',
  },
  ice: {
    id: 'ice', name: 'Glace', description: 'Glaces d\'eau, CO₂, méthane : comètes, lunes glacées.',
    density: 930, defaultTemperature: 80, charge: 'neutre', composition: { ice: 0.8, rock: 0.2 }, baryonic: true,
    color: '#cfefff', science: 'etabli', scienceNote: 'Sublimation près des étoiles approchée par la température d\'équilibre.',
  },
  water: {
    id: 'water', name: 'Eau', description: 'H₂O : océans, atmosphères humides, glace selon la température.',
    density: 1000, defaultTemperature: 290, charge: 'neutre', composition: { water: 0.9, rock: 0.1 }, baryonic: true,
    color: '#3c8cff', science: 'etabli', scienceNote: 'État (glace/liquide/vapeur) déterminé par la température et la pression.',
  },
  metal: {
    id: 'metal', name: 'Métaux (Fe/Ni)', description: 'Noyaux planétaires, astéroïdes métalliques.',
    density: 7870, defaultTemperature: 300, charge: 'neutre', composition: { metal: 0.9, rock: 0.1 }, baryonic: true,
    color: '#b8b8c8', science: 'etabli', scienceNote: 'Densité du fer ; champ magnétique planétaire lié au noyau métallique (approx.).',
  },
  organic: {
    id: 'organic', name: 'Matière organique', description: 'Molécules carbonées complexes ; favorise l\'apparition de la vie.',
    density: 1400, defaultTemperature: 280, charge: 'neutre', composition: { organic: 0.6, water: 0.3, rock: 0.1 }, baryonic: true,
    color: '#5fd16b', science: 'approx', scienceNote: 'L\'apparition de la vie est un modèle spéculatif basé sur des conditions d\'habitabilité.',
  },
  darkmatter: {
    id: 'darkmatter', name: 'Matière noire', description: 'N\'interagit que par gravité. Invisible hors du mode analyse.',
    density: 0, defaultTemperature: 0, charge: 'aucune (hypothèse)', composition: {}, baryonic: false,
    color: '#7a5cff', science: 'approx', scienceNote: 'Nature inconnue : seule son influence gravitationnelle est simulée.',
  },
  energy: {
    id: 'energy', name: 'Énergie / rayonnement', description: 'Impulsion de rayonnement : chauffe et repousse la matière environnante.',
    density: 0, defaultTemperature: 1e7, charge: 'photons', composition: {}, baryonic: false,
    color: '#ffffff', science: 'divin', scienceNote: 'Création d\'énergie à partir de rien : pouvoir divin (viole la conservation de l\'énergie).',
  },
};

export const MATTER_LIST = Object.values(MATTER);

/** Densité moyenne (kg/m³) d'une composition, pour un corps compact. */
export function densityOf(c: Composition): number {
  const dens: Record<keyof Composition, number> = {
    hydrogen: 1300, rock: 3300, metal: 7900, ice: 930, water: 1000, organic: 1400, heavy: 8000,
  };
  // mélange en volume : 1/ρ = Σ w_i / ρ_i
  let inv = 0;
  for (const k of Object.keys(dens) as (keyof Composition)[]) inv += (c[k] ?? 0) / dens[k];
  return inv > 0 ? 1 / inv : 3000;
}
