import type * as THREE from 'three';
import type { ScaleLevel } from '../../save/serialize';

export interface PickResult {
  kind: 'body' | 'star' | 'galaxy' | 'entity' | 'halo';
  id: string;
  label: string;
}

/** Une vue = une échelle du jeu (scène, unités, caméra, interactions). */
export interface View {
  readonly scene: THREE.Scene;
  readonly level: ScaleLevel;
  /** Unités de rendu par unité de caméra. */
  readonly renderScale: number;
  enter(): void;
  exit(): void;
  /** Mise à jour visuelle après la simulation (dtReal en secondes). */
  update(dtReal: number): void;
  pick(px: number, py: number): PickResult | null;
  /** Position (unités de la caméra) d'un objet sélectionnable, pour le vol et le suivi. */
  positionOf(id: string): { x: number; y: number; z: number } | null;
  /** Distance de cadrage conseillée pour un objet. */
  framingDistance(id: string): number;
}
