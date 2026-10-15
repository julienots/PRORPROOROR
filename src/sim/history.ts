import type { World } from './world';
import { snapshotWorld, restoreWorld, type WorldSnapshot } from '../save/serialize';

/**
 * Historique des actions divines (annuler / rétablir) par instantanés du monde.
 * Les instantanés sont pris AVANT chaque action ; les particules sont sous-échantillonnées.
 */
export interface HistoryEntry {
  label: string;
  at: number; // temps de simulation
  snap: WorldSnapshot;
}

export class History {
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  /** Journal lisible de toutes les actions (y compris annulées). */
  log: { label: string; at: number; undone?: boolean }[] = [];
  constructor(private world: World, private max = 40) {}

  /** Enregistre l'état courant avant une action. */
  record(label: string): void {
    this.undoStack.push({ label, at: this.world.time, snap: snapshotWorld(this.world, 4000) });
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack = [];
    this.log.push({ label, at: this.world.time });
    if (this.log.length > 300) this.log.shift();
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, at: this.world.time, snap: snapshotWorld(this.world, 4000) });
    restoreWorld(this.world, e.snap);
    for (let i = this.log.length - 1; i >= 0; i--) if (this.log[i].label === e.label && !this.log[i].undone) { this.log[i].undone = true; break; }
    return e.label;
  }

  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, at: this.world.time, snap: snapshotWorld(this.world, 4000) });
    restoreWorld(this.world, e.snap);
    for (let i = this.log.length - 1; i >= 0; i--) if (this.log[i].label === e.label && this.log[i].undone) { this.log[i].undone = false; break; }
    return e.label;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
