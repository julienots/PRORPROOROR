import { validateUniverse, newUniverseId, type UniverseSave } from './serialize';

/**
 * Stockage multi-univers avec historique de versions.
 * Clés : `superessence:index` (liste) et `superessence:u:<id>` (versions, la plus récente en dernier).
 * Chaque écriture est relue et validée (vérification d'intégrité).
 */
export interface KeyValueBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryBackend implements KeyValueBackend {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

export function defaultBackend(): KeyValueBackend {
  try {
    const ls = globalThis.localStorage;
    const probe = '__superessence_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return new MemoryBackend();
  }
}

export interface SaveEntry {
  id: string;
  name: string;
  updatedAt: string;
  versions: number;
  sizeKB: number;
}

interface StoredVersion {
  savedAt: string;
  label: string;
  data: UniverseSave;
}

const INDEX = 'superessence:index';
const KEY = (id: string) => `superessence:u:${id}`;
export const MAX_VERSIONS = 8;

export class SaveStore {
  constructor(private backend: KeyValueBackend = defaultBackend()) {}

  private readIndex(): string[] {
    try {
      const raw = this.backend.getItem(INDEX);
      const v = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeIndex(ids: string[]): void {
    this.backend.setItem(INDEX, JSON.stringify([...new Set(ids)]));
  }

  private readVersions(id: string): StoredVersion[] {
    try {
      const raw = this.backend.getItem(KEY(id));
      if (!raw) return [];
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  list(): SaveEntry[] {
    const out: SaveEntry[] = [];
    for (const id of this.readIndex()) {
      const raw = this.backend.getItem(KEY(id));
      const vs = this.readVersions(id);
      if (!vs.length) continue;
      const last = vs[vs.length - 1];
      out.push({ id, name: last.data?.name ?? id, updatedAt: last.savedAt, versions: vs.length, sizeKB: Math.round((raw?.length ?? 0) / 1024) });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Enregistre une nouvelle version. Lève une erreur si l'écriture échoue (quota…). */
  save(u: UniverseSave, label = 'Sauvegarde'): void {
    const data = { ...u, updatedAt: new Date().toISOString() };
    const versions = this.readVersions(u.id);
    versions.push({ savedAt: data.updatedAt, label: label.slice(0, 60), data });
    while (versions.length > MAX_VERSIONS) versions.shift();
    const payload = JSON.stringify(versions);
    try {
      this.backend.setItem(KEY(u.id), payload);
    } catch (e) {
      // quota dépassé : on ne garde que la dernière version
      try {
        this.backend.setItem(KEY(u.id), JSON.stringify(versions.slice(-1)));
      } catch {
        throw new Error(`Échec de la sauvegarde (espace de stockage insuffisant) : ${(e as Error).message}`);
      }
    }
    // vérification d'intégrité : relecture + validation
    const check = this.readVersions(u.id);
    if (!check.length || check[check.length - 1].data.id !== u.id) throw new Error('Vérification de la sauvegarde échouée');
    validateUniverse(check[check.length - 1].data);
    const idx = this.readIndex();
    if (!idx.includes(u.id)) this.writeIndex([...idx, u.id]);
    u.updatedAt = data.updatedAt;
  }

  /** Charge la version demandée (dernière par défaut, -1 = avant-dernière…). */
  load(id: string, versionIndex?: number): UniverseSave {
    const vs = this.readVersions(id);
    if (!vs.length) throw new Error('Univers introuvable');
    const i = versionIndex === undefined ? vs.length - 1 : versionIndex < 0 ? vs.length - 1 + versionIndex : versionIndex;
    const v = vs[Math.max(0, Math.min(vs.length - 1, i))];
    return validateUniverse(v.data);
  }

  versions(id: string): { savedAt: string; label: string; index: number }[] {
    return this.readVersions(id).map((v, index) => ({ savedAt: v.savedAt, label: v.label, index }));
  }

  duplicate(id: string, newName?: string): UniverseSave {
    const u = this.load(id);
    const copy = validateUniverse(JSON.parse(JSON.stringify(u)));
    copy.id = newUniverseId();
    copy.name = (newName ?? `${u.name} (copie)`).slice(0, 60);
    copy.createdAt = new Date().toISOString();
    this.save(copy, 'Duplication');
    return copy;
  }

  rename(id: string, name: string): void {
    const u = this.load(id);
    u.name = name.slice(0, 60) || u.name;
    this.save(u, 'Renommage');
  }

  delete(id: string): void {
    this.backend.removeItem(KEY(id));
    this.writeIndex(this.readIndex().filter((x) => x !== id));
  }

  exportJSON(u: UniverseSave): string {
    return JSON.stringify(u, null, 1);
  }

  importJSON(text: string): UniverseSave {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('JSON invalide');
    }
    const u = validateUniverse(raw);
    // évite d'écraser un univers existant
    if (this.readIndex().includes(u.id)) u.id = newUniverseId();
    this.save(u, 'Import');
    return u;
  }
}
