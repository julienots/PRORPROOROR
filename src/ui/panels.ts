import { h, clear, slider, toggle, select, button, badge, readout, lineChart, download } from './dom';
import type { Game, CreationSpec } from '../game';
import type { UI } from './ui';
import { MATTER_LIST, type MatterId } from '../sim/matter';
import { fmt, fmtYears, fmtMassSun, M_EARTH_SUN, km2au, G_SIM } from '../core/units';
import { habitability, LIFE_LABELS, planetTypeLabel } from '../sim/planet';
import { rotationCurve, nfwDensity } from '../sim/galaxy';
import { PLANCK18, FATE_LABEL, integrateHistory, type CosmoParams } from '../sim/cosmology';
import { validateSnapshot, type WorldSnapshot } from '../save/serialize';
import type { Body } from '../sim/types';
import type { QualityPreset } from '../render/engine';
import type { SystemView } from '../render/views/systemView';

type PanelName = 'create' | 'cosmo' | 'analysis' | 'saves' | 'history' | 'compare' | 'settings' | 'help' | 'map';

const TITLES: Record<PanelName, string> = {
  create: 'Catalogue cosmique — Création', cosmo: 'Laboratoire cosmologique', analysis: 'Analyse scientifique', saves: 'Univers sauvegardés',
  history: 'Historique des actions', compare: 'Mode comparaison', settings: 'Options', help: 'Aide & notes scientifiques', map: 'Carte de l\'univers',
};

/** Panneaux flottants et fenêtres modales. */
export class Panels {
  private open_ = new Map<PanelName, { el: HTMLElement; live: (() => void)[]; draw?: () => void }>();
  private lastTick = 0;

  constructor(private game: Game, private root: HTMLElement, private ui: UI) {
    game.bus.on('level', () => { if (this.open_.has('analysis')) this.reopen('analysis'); if (this.open_.has('create')) this.reopen('create'); });
    game.bus.on('history', () => { if (this.open_.has('history')) this.reopen('history'); });
    game.bus.on('saved', () => { if (this.open_.has('saves')) this.reopen('saves'); });
  }

  toggle(n: PanelName): void {
    if (this.open_.has(n)) this.close(n);
    else this.open(n);
  }

  reopen(n: PanelName): void {
    this.close(n);
    this.open(n);
  }

  closeAll(): void {
    for (const n of [...this.open_.keys()]) this.close(n);
  }

  close(n: PanelName): void {
    const p = this.open_.get(n);
    if (!p) return;
    p.el.remove();
    this.open_.delete(n);
  }

  isOpen(n: PanelName): boolean {
    return this.open_.has(n);
  }

  open(n: PanelName): void {
    if (this.open_.has(n)) return;
    const modal = ['saves', 'compare', 'help', 'map', 'settings', 'history'].includes(n);
    const live: (() => void)[] = [];
    const content = h('div', { class: 'pcontent' });
    const el = h('div', { class: `panel p-${n}${modal ? ' modal' : ' float'}`, 'data-testid': `panel-${n}` },
      h('header', null, h('b', null, TITLES[n]), h('button', { class: 'x', onclick: () => this.close(n), 'data-testid': `close-${n}` }, '×')),
      content,
    );
    const entry: { el: HTMLElement; live: (() => void)[]; draw?: () => void } = { el, live };
    this.open_.set(n, entry);
    switch (n) {
      case 'create': this.buildCreate(content, live); break;
      case 'cosmo': entry.draw = this.buildCosmo(content, live); break;
      case 'analysis': entry.draw = this.buildAnalysis(content, live); break;
      case 'saves': this.buildSaves(content); break;
      case 'history': this.buildHistory(content); break;
      case 'compare': this.buildCompare(content); break;
      case 'settings': this.buildSettings(content); break;
      case 'help': this.buildHelp(content); break;
      case 'map': entry.draw = this.buildMap(content); break;
    }
    this.root.appendChild(el);
    this.game.audio.play('click');
  }

  tick(): void {
    const now = performance.now();
    if (now - this.lastTick < 300) return;
    this.lastTick = now;
    for (const p of this.open_.values()) {
      for (const f of p.live) { try { f(); } catch { /* ignore */ } }
      p.draw?.();
    }
  }

  // =========================================================================
  // Catalogue / création
  // =========================================================================

  private buildCreate(c: HTMLElement, live: (() => void)[]): void {
    const g = this.game;
    if (g.level !== 'system' && g.level !== 'planet') {
      c.appendChild(h('p', { class: 'muted' }, g.level === 'galaxy' || g.level === 'cosmic'
        ? 'À cette échelle, la création se fait depuis le panneau de droite (créateur de galaxies, fusions, fins d\'univers).'
        : g.level === 'bigbang' ? 'Réglez les conditions initiales dans le panneau de droite puis déclenchez le Big Bang.'
          : 'Dans le laboratoire, créez des particules et des atomes depuis le panneau de droite.'));
      return;
    }
    const spec = g.creation;
    const tabs: [CreationSpec['type'], string][] = [['matter', 'Matière'], ['star', 'Étoile'], ['planet', 'Planète'], ['blackhole', 'Trou noir'], ['nebula', 'Nébuleuse'], ['darkmatter', 'Matière noire']];
    const tabbar = h('div', { class: 'tabs' });
    const body = h('div', { class: 'tabbody' });
    const render = () => {
      clear(tabbar);
      for (const [t, l] of tabs) tabbar.appendChild(h('button', { class: `tab${spec.type === t ? ' on' : ''}`, onclick: () => { spec.type = t; render(); }, 'data-testid': `create-tab-${t}` }, l));
      clear(body);
      switch (spec.type) {
        case 'matter': {
          spec.matter ??= { matter: 'rock', amount: M_EARTH_SUN };
          const m = spec.matter;
          const grid = h('div', { class: 'matter-grid' });
          for (const mt of MATTER_LIST) {
            grid.appendChild(h('button', { class: `matter${m.matter === mt.id ? ' on' : ''}`, style: { borderColor: mt.color }, title: mt.description, onclick: () => { m.matter = mt.id as MatterId; m.temperature = mt.defaultTemperature; render(); }, 'data-testid': `matter-${mt.id}` },
              h('i', { style: { background: mt.color } }), mt.name));
          }
          const mt = MATTER_LIST.find((x) => x.id === m.matter)!;
          body.append(grid,
            h('div', { class: 'matter-info' },
              h('p', null, mt.description),
              h('p', { class: 'muted' }, `Densité de référence : ${mt.density ? fmt(mt.density, 3) + ' kg/m³' : '—'} · Charge : ${mt.charge}`),
              h('p', { class: 'note' }, badge(mt.science), ' ', mt.scienceNote)),
            m.matter === 'particles' ? h('p', null, 'Cliquer dans l\'espace ouvre le laboratoire atomique de la planète sélectionnée.') :
              m.matter === 'energy'
                ? slider({ label: 'Énergie libérée (échelle log)', min: 1, max: 1e5, value: m.amount > 1e-3 ? m.amount : 100, log: true, format: (v) => `≈1e${(30 + v ** 0.1 * 8).toFixed(1)} J`, onInput: (v) => (m.amount = v) })
                : slider({ label: 'Quantité', min: 1e-12, max: 200, value: m.amount, log: true, unit: 'M☉', format: (v) => fmtMassSun(v), testid: 'matter-amount', onInput: (v) => (m.amount = v) }),
            slider({ label: 'Température', min: 3, max: 1e9, value: m.temperature ?? mt.defaultTemperature, log: true, unit: 'K', onInput: (v) => (m.temperature = v) }),
            slider({ label: 'Densité (× référence)', min: 0.1, max: 10, value: m.density ?? 1, log: true, onInput: (v) => (m.density = v) }),
            h('p', { class: 'muted' }, 'Le type d\'objet formé dépend de la masse : beaucoup de gaz → nuage pouvant s\'effondrer en étoile ; roche → astéroïde puis planète ; plasma chaud et massif → étoile allumée.'),
          );
          break;
        }
        case 'star': {
          spec.star ??= { mass: 1, metallicity: 0.014, rotationDays: 25, protostar: false };
          const s = spec.star;
          body.append(
            slider({ label: 'Masse', min: 0.08, max: 150, value: s.mass, log: true, unit: 'M☉', testid: 'create-star-mass', onInput: (v) => (s.mass = v) }),
            slider({ label: 'Métallicité Z', min: 1e-4, max: 0.08, value: s.metallicity, log: true, onInput: (v) => (s.metallicity = v) }),
            slider({ label: 'Rotation', min: 0.1, max: 200, value: s.rotationDays, log: true, unit: 'j', onInput: (v) => (s.rotationDays = v) }),
            toggle('Naître comme protoétoile (contraction de Kelvin–Helmholtz)', s.protostar, (v) => (s.protostar = v)),
            h('p', { class: 'note' }, badge('approx'), ' Composition : H/He + métaux (Z). La masse détermine luminosité, durée de vie et destin.'),
          );
          break;
        }
        case 'planet': {
          spec.planet ??= { massEarth: 1 };
          const p = spec.planet;
          body.append(
            slider({ label: 'Masse', min: 1e-4, max: 4000, value: p.massEarth ?? 1, log: true, unit: 'M⊕', testid: 'create-planet-mass', onInput: (v) => (p.massEarth = v) }),
            select('Type', [['rock', 'Tellurique'], ['ocean', 'Océanique'], ['ice', 'Glacée'], ['gas', 'Géante gazeuse'], ['icegiant', 'Géante de glace'], ['lava', 'Monde de lave']], 'rock', (v) => {
              const preset: Record<string, Partial<typeof p>> = {
                rock: { gasGiant: false, composition: undefined, waterFraction: 0.5, pressure: 1 },
                ocean: { gasGiant: false, composition: { water: 0.4, rock: 0.45, metal: 0.15 }, waterFraction: 0.97, pressure: 2 },
                ice: { gasGiant: false, composition: { ice: 0.6, rock: 0.3, metal: 0.1 }, waterFraction: 0.8, pressure: 0.05 },
                gas: { gasGiant: true, composition: undefined, massEarth: Math.max(p.massEarth ?? 1, 100) },
                icegiant: { gasGiant: true, composition: { hydrogen: 0.3, ice: 0.6, rock: 0.1 }, massEarth: Math.max(p.massEarth ?? 1, 15) },
                lava: { gasGiant: false, volcanism: 1, pressure: 5, waterFraction: 0, greenhouse: 120 },
              };
              Object.assign(p, preset[v]);
            }),
            slider({ label: 'Eau de surface', min: 0, max: 1, value: p.waterFraction ?? 0.5, step: 0.01, onInput: (v) => (p.waterFraction = v) }),
            slider({ label: 'Pression', min: 1e-3, max: 1000, value: p.pressure ?? 1, log: true, unit: 'atm', onInput: (v) => (p.pressure = v) }),
            slider({ label: 'Continents', min: 0, max: 1, value: p.continents ?? 0.5, step: 0.01, onInput: (v) => (p.continents = v) }),
            slider({ label: 'Rotation', min: 2, max: 5000, value: p.rotationHours ?? 24, log: true, unit: 'h', onInput: (v) => (p.rotationHours = v) }),
            slider({ label: 'Inclinaison', min: 0, max: 180, value: p.axialTilt ?? 23, step: 1, unit: '°', onInput: (v) => (p.axialTilt = v) }),
            slider({ label: 'Volcanisme', min: 0, max: 1, value: p.volcanism ?? 0.2, step: 0.01, onInput: (v) => (p.volcanism = v) }),
            slider({ label: 'Champ magnétique', min: 0, max: 10, value: p.magneticField ?? 1, step: 0.05, unit: '× Terre', onInput: (v) => (p.magneticField = v) }),
            toggle('Anneaux', p.rings ?? false, (v) => (p.rings = v)),
          );
          break;
        }
        case 'blackhole': {
          spec.blackhole ??= { mass: 10, spin: 0.9, diskMass: 0.001, jets: true, environment: 0.01 };
          const b = spec.blackhole;
          body.append(
            slider({ label: 'Masse', min: 3, max: 1e10, value: b.mass, log: true, unit: 'M☉', testid: 'create-bh-mass', onInput: (v) => (b.mass = v) }),
            slider({ label: 'Spin a*', min: 0, max: 0.998, value: b.spin, step: 0.001, onInput: (v) => (b.spin = v) }),
            slider({ label: 'Matière environnante (disque)', min: 0, max: 10, value: b.environment, step: 0.001, unit: 'M☉', onInput: (v) => (b.environment = v) }),
            toggle('Jets relativistes', b.jets, (v) => (b.jets = v)),
            h('p', { class: 'note' }, badge('etabli'), ' Rs = 2GM/c² ≈ 2,95 km × M/M☉. ', badge('approx'), ' Rendu : géodésiques de Schwarzschild.'),
          );
          break;
        }
        case 'nebula': {
          spec.nebula ??= { mass: 30, density: 1e5, temperature: 15 };
          const n = spec.nebula;
          body.append(
            slider({ label: 'Masse', min: 0.1, max: 1e4, value: n.mass, log: true, unit: 'M☉', onInput: (v) => (n.mass = v) }),
            slider({ label: 'Densité', min: 10, max: 1e7, value: n.density, log: true, unit: 'cm⁻³', onInput: (v) => (n.density = v) }),
            slider({ label: 'Température', min: 5, max: 1e4, value: n.temperature, log: true, unit: 'K', onInput: (v) => (n.temperature = v) }),
            h('p', { class: 'muted' }, 'Au-delà de la masse de Jeans, le nuage s\'effondre en protoétoile entourée d\'un disque protoplanétaire.'),
          );
          break;
        }
        case 'darkmatter': {
          spec.darkmatter ??= { mass: 10, radiusAU: 20 };
          const d = spec.darkmatter;
          body.append(
            slider({ label: 'Masse', min: 1e-4, max: 1e5, value: d.mass, log: true, unit: 'M☉', onInput: (v) => (d.mass = v) }),
            slider({ label: 'Rayon du halo', min: 0.1, max: 1e5, value: d.radiusAU, log: true, unit: 'UA', onInput: (v) => (d.radiusAU = v) }),
            h('p', { class: 'note' }, badge('approx'), ' Seul l\'effet gravitationnel est simulé. Visible en mode analyse.'),
          );
          break;
        }
      }
      body.append(
        select('Vitesse initiale', [['circular', 'Orbite circulaire autour du corps dominant'], ['rest', 'Au repos (tombe)']], spec.orbit, (v) => (spec.orbit = v)),
        h('div', { class: 'btnrow' },
          button(g.tool === 'create' ? 'Mode placement actif : cliquez dans l\'espace' : 'Placer en cliquant dans l\'espace', () => { g.setTool('create'); render(); }, 'primary', undefined, 'create-place'),
          button('Créer au centre de la vue', () => {
            const t = g.engine.rig.target;
            const pr = g.world.primary();
            const pos = pr && Math.hypot(t.x - pr.pos.x, t.y - pr.pos.y, t.z - pr.pos.z) < km2au(pr.radius) * 2
              ? { x: pr.pos.x + g.engine.rig.distance * 0.3, y: pr.pos.y, z: pr.pos.z }
              : { ...t };
            g.createAt(pos);
          }, '', undefined, 'create-center'),
        ),
      );
    };
    render();
    c.append(tabbar, body);
    void live;
  }

  // =========================================================================
  // Laboratoire cosmologique (modèle de l'univers courant)
  // =========================================================================

  private buildCosmo(c: HTMLElement, live: (() => void)[]): () => void {
    const g = this.game;
    const p = { ...g.universe.cosmology };
    const apply = () => g.setCosmology(p);
    const canvas = h('canvas', { width: 360, height: 170, class: 'chart' }) as HTMLCanvasElement;
    const preview = { hist: integrateHistory(p, 120) };
    const upd = () => { preview.hist = integrateHistory(p, 120); };
    c.append(
      h('p', { class: 'note' }, badge('etabli'), ' Équations de Friedmann. ', badge('approx'), ' Énergie noire de w constant ; matière noire décrite uniquement par Ωm.'),
      slider({ label: 'H₀', min: 30, max: 120, value: p.H0, step: 0.1, unit: 'km/s/Mpc', onInput: (v) => { p.H0 = v; upd(); } }),
      slider({ label: 'Ωm (matière ordinaire + noire)', min: 0.02, max: 3, value: p.omegaM, step: 0.01, onInput: (v) => { p.omegaM = v; upd(); } }),
      slider({ label: 'Ωb (matière ordinaire)', min: 0.005, max: 0.3, value: p.omegaB, step: 0.001, onInput: (v) => { p.omegaB = v; upd(); } }),
      slider({ label: 'ΩΛ (énergie noire)', min: -1, max: 2, value: p.omegaL, step: 0.01, testid: 'cosmo-ol', onInput: (v) => { p.omegaL = v; upd(); } }),
      slider({ label: 'w', min: -2, max: -0.3, value: p.w, step: 0.01, onInput: (v) => { p.w = v; upd(); } }),
      readout('Matière noire Ωc = Ωm − Ωb', () => (p.omegaM - p.omegaB).toFixed(3), live),
      readout('Âge à a = 1', () => (Number.isFinite(preview.hist.age) ? `${preview.hist.age.toFixed(2)} Ga` : '—'), live),
      readout('Destin', () => FATE_LABEL[preview.hist.fate], live),
      canvas,
      h('div', { class: 'btnrow wrap' },
        button('Appliquer à l\'univers', () => { apply(); g.toast('Modèle cosmologique mis à jour (expansion de la vue cosmique).', 'science'); }, 'primary', undefined, 'cosmo-apply'),
        button('Planck 2018', () => { Object.assign(p, PLANCK18); upd(); apply(); this.reopen('cosmo'); }),
        button('Sans énergie noire', () => { Object.assign(p, { ...PLANCK18, omegaL: 0, omegaM: 1 }); upd(); this.reopen('cosmo'); }),
        button('Ouvrir le Big Bang', () => { void g.goBigBang(); this.close('cosmo'); }),
      ),
    );
    return () => {
      const H = preview.hist;
      const d1: [number, number][] = [];
      for (let i = 0; i < H.n; i += Math.max(1, Math.floor(H.n / 300))) d1.push([H.t[i], H.a[i]]);
      const ref = integrateHistory(PLANCK18, 60);
      const d2: [number, number][] = [];
      for (let i = 0; i < ref.n; i += Math.max(1, Math.floor(ref.n / 200))) d2.push([ref.t[i], ref.a[i]]);
      lineChart(canvas, [{ data: d1, color: '#7cc8ff', label: 'a(t) modèle' }, { data: d2, color: '#999', label: 'Planck 2018', dash: true }], { xLabel: 't (Ga)', marker: g.universe.cosmicTime });
    };
  }

  // =========================================================================
  // Analyse
  // =========================================================================

  private buildAnalysis(c: HTMLElement, live: (() => void)[]): () => void {
    const g = this.game;
    const w = g.world;
    if (g.level === 'system' || g.level === 'planet') {
      const e0 = { v: w.energy(), t: w.time };
      const energy: [number, number][] = [];
      const gw: HTMLCanvasElement = h('canvas', { width: 360, height: 130, class: 'chart' }) as HTMLCanvasElement;
      const ec: HTMLCanvasElement = h('canvas', { width: 360, height: 110, class: 'chart' }) as HTMLCanvasElement;
      const plist = h('table', { class: 'tbl' });
      c.append(
        h('p', { class: 'note' }, 'Affiché en 3D : zone habitable (vert), puits de potentiel gravitationnel (grille), trajectoires prédites (N-corps indépendant), halos de matière noire.'),
        readout('Intégrateur', () => (w.lastReport.mode === 'kepler' ? 'Kepler séculaire (interactions négligées)' : `Leapfrog N-corps, ${w.lastReport.substeps} sous-pas`), live),
        readout('Coût de simulation', () => `${w.lastReport.ms.toFixed(1)} ms / image`, live),
        readout('Masse totale (corps + particules)', () => fmtMassSun(w.totalMass()), live),
        readout('Quantité de mouvement', () => { const p = w.momentum(); return fmt(Math.hypot(p.x, p.y, p.z), 3); }, live),
        readout('Dérive relative de l\'énergie', () => { const e = w.energy(); return e0.v !== 0 ? `${(((e - e0.v) / Math.abs(e0.v)) * 100).toExponential(2)} %` : '—'; }, live),
        toggle('Gravité de la matière noire', w.settings.darkMatterGravity, (v) => (w.settings.darkMatterGravity = v)),
        toggle('Traînées orbitales', (g.views.system as SystemView).showTrails, (v) => ((g.views.system as SystemView).showTrails = v)),
        h('h4', null, 'Énergie mécanique'), ec,
        h('h4', null, 'Ondes gravitationnelles (puissance émise)'), gw,
        h('h4', null, 'Planètes'), plist,
      );
      return () => {
        energy.push([w.time, w.energy()]);
        if (energy.length > 300) energy.shift();
        lineChart(ec, [{ data: energy, color: '#7cffb0', label: 'E (M☉ UA²/an²)' }], { xLabel: 't (ans)' });
        const sig: [number, number][] = w.gwSignals.map((s) => [s.t, Math.max(s.strain, 1)]);
        if (sig.length) lineChart(gw, [{ data: sig, color: '#c890ff', label: 'P_OG (W)' }], { xLabel: 't (ans)', logY: true });
        const rows = w.bodies.filter((b) => b.planet && b.kind === 'planet').slice(0, 14).map((b) => `<tr><td>${b.name}</td><td>${planetTypeLabel(b)}</td><td>${Math.round(b.temperature)} K</td><td>${(habitability(b) * 100).toFixed(0)} %</td><td>${LIFE_LABELS[b.planet!.life]}</td></tr>`).join('');
        const html = `<tr><th>Planète</th><th>Type</th><th>T</th><th>Hab.</th><th>Vie</th></tr>${rows}`;
        if (plist.innerHTML !== html) plist.innerHTML = html;
      };
    }
    if (g.level === 'galaxy' && g.galaxy) {
      const comp = g.galaxy.components[0];
      const rc = h('canvas', { width: 360, height: 170, class: 'chart' }) as HTMLCanvasElement;
      const dm = h('canvas', { width: 360, height: 120, class: 'chart' }) as HTMLCanvasElement;
      c.append(
        h('p', { class: 'note' }, badge('etabli'), ' Les courbes de rotation plates observées sont l\'indice principal de la matière noire. ', badge('approx'), ' Profil NFW.'),
        h('h4', null, 'Courbe de rotation : avec / sans matière noire'), rc,
        h('h4', null, 'Densité de matière noire (NFW)'), dm,
        readout('Masse du halo', () => `${fmt(comp.mHalo, 3)} M☉`, live),
        readout('Rapport matière noire / visible', () => (comp.mHalo / (comp.mBulge + comp.mDisk)).toFixed(1), live),
        slider({ label: 'Masse du halo (en direct)', min: 0, max: 5e13, value: comp.mHalo, step: 1e10, format: (v) => v.toExponential(2), unit: 'M☉', onInput: (v) => { for (const k of g.galaxy!.components) k.mHalo = v; } }),
      );
      return () => {
        const r = rotationCurve(comp, 40);
        lineChart(rc, [
          { data: r.r.map((x, i) => [x * 1000, r.withDM[i]]), color: '#7cc8ff', label: 'avec matière noire' },
          { data: r.r.map((x, i) => [x * 1000, r.withoutDM[i]]), color: '#ff9a60', label: 'matière visible seule', dash: true },
        ], { xLabel: 'R (al)' });
        const d: [number, number][] = [];
        for (let i = 1; i <= 50; i++) { const rr = (comp.rsHalo * 6 * i) / 50; d.push([rr * 1000, nfwDensity(comp, rr)]); }
        lineChart(dm, [{ data: d, color: '#b090ff', label: 'ρ_MN (M☉/kal³)' }], { xLabel: 'r (al)', logY: true });
      };
    }
    if (g.level === 'cosmic') {
      const ac = h('canvas', { width: 360, height: 160, class: 'chart' }) as HTMLCanvasElement;
      c.append(
        readout('H(t)', () => `${fmt(g.universe.cosmology.H0 * Math.sqrt(Math.max(0, g.scaleFactorNow() ** -3 * g.universe.cosmology.omegaM + g.universe.cosmology.omegaL)), 4)} km/s/Mpc (approx.)`, live),
        readout('Distribution', () => 'Toile cosmique (filaments, nœuds, vides) — densité visualisée en bleu', live),
        h('h4', null, 'Facteur d\'échelle'), ac,
      );
      return () => {
        const H = g.cosmoHistory;
        const d: [number, number][] = [];
        for (let i = 0; i < H.n; i += Math.max(1, Math.floor(H.n / 300))) d.push([H.t[i], H.a[i]]);
        lineChart(ac, [{ data: d, color: '#7cc8ff', label: 'a(t)' }], { xLabel: 't (Ga)', marker: g.universe.cosmicTime });
      };
    }
    c.append(h('p', { class: 'muted' }, 'Analyse disponible aux échelles stellaire, galactique et cosmique. Au laboratoire, consultez le recensement à droite.'));
    return () => {};
  }

  // =========================================================================
  // Sauvegardes
  // =========================================================================

  private buildSaves(c: HTMLElement): void {
    const g = this.game;
    const nameInput = h('input', { type: 'text', value: g.universe.name, 'data-testid': 'save-name' }) as HTMLInputElement;
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, 'data-testid': 'import-file' }) as HTMLInputElement;
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const u = g.store.importJSON(await f.text());
        g.applySave(u);
        this.reopen('saves');
      } catch (e) {
        g.toast(`Import impossible : ${(e as Error).message}`, 'error');
      }
    });
    c.append(
      h('div', { class: 'saverow' },
        h('label', null, 'Nom de l\'univers ', nameInput),
        button('Sauvegarder', () => { g.universe.name = nameInput.value.slice(0, 60) || g.universe.name; g.save(); }, 'primary', undefined, 'save-now'),
        button('Exporter (JSON)', () => { const u = g.buildSave(); download(`${u.name.replace(/[^\w-]+/g, '_')}.superessence.json`, g.store.exportJSON(u)); }),
        button('Importer…', () => fileInput.click()),
        fileInput,
      ),
    );
    const list = g.store.list();
    if (!list.length) c.appendChild(h('p', { class: 'muted' }, 'Aucun univers sauvegardé pour l\'instant.'));
    const tbl = h('div', { class: 'saves', 'data-testid': 'save-list' });
    for (const e of list) {
      const versions = g.store.versions(e.id);
      const vsel = h('select', null, ...versions.map((v) => h('option', { value: v.index, selected: v.index === versions.length - 1 }, `${new Date(v.savedAt).toLocaleString('fr-FR')} — ${v.label}`))) as HTMLSelectElement;
      tbl.appendChild(h('div', { class: `save${e.id === g.universe.id ? ' current' : ''}` },
        h('div', { class: 'sname' }, h('b', null, e.name), h('small', null, `${new Date(e.updatedAt).toLocaleString('fr-FR')} · ${e.versions} version(s) · ${e.sizeKB} Ko`)),
        h('div', { class: 'btnrow wrap' },
          button('Charger', () => { if (g.load(e.id, Number(vsel.value))) this.close('saves'); }, 'primary', undefined, `load-${e.id}`),
          vsel,
          button('Dupliquer', () => { const d = g.store.duplicate(e.id); g.toast(`Copie créée : ${d.name}`, 'info'); this.reopen('saves'); }, '', undefined, 'duplicate'),
          button('Renommer', () => { const n = prompt('Nouveau nom', e.name); if (n) { g.store.rename(e.id, n); this.reopen('saves'); } }),
          button('Supprimer', () => { if (confirm(`Supprimer définitivement « ${e.name} » ?`)) { g.store.delete(e.id); this.reopen('saves'); } }, 'danger'),
        ),
      ));
    }
    c.appendChild(tbl);
    // points de restauration rapides
    const cp = h('div', { class: 'checkpoints' }, h('h4', null, 'Points de restauration (session)'));
    if (!g.quickSnapshots.length) cp.appendChild(h('p', { class: 'muted' }, 'Bouton ⚑ en haut pour créer un point de restauration instantané.'));
    g.quickSnapshots.forEach((s, i) => cp.appendChild(h('div', { class: 'cpt' }, `${s.label} — ${s.date} (T + ${fmtYears(s.at)})`, button('Restaurer', () => g.restoreCheckpoint(i)))));
    c.appendChild(cp);
  }

  // =========================================================================
  // Historique
  // =========================================================================

  private buildHistory(c: HTMLElement): void {
    const g = this.game;
    c.append(h('div', { class: 'btnrow' },
      button('↶ Annuler', () => g.undo(), '', undefined, 'hist-undo'),
      button('↷ Rétablir', () => g.redo()),
    ));
    const ol = h('ol', { class: 'histlist' });
    for (const e of [...g.history.log].reverse()) ol.appendChild(h('li', { class: e.undone ? 'undone' : '' }, h('time', null, fmtYears(e.at)), e.label));
    if (!g.history.log.length) ol.appendChild(h('li', { class: 'muted' }, 'Aucune action divine pour l\'instant.'));
    c.appendChild(ol);
    c.appendChild(h('p', { class: 'muted' }, `${g.history.undoStack.length} action(s) annulable(s) — instantanés pris avant chaque action.`));
  }

  // =========================================================================
  // Comparaison
  // =========================================================================

  private buildCompare(c: HTMLElement): void {
    const g = this.game;
    const sources: { label: string; get: () => WorldSnapshot | null }[] = [{ label: 'État actuel', get: () => null }];
    g.quickSnapshots.forEach((s) => sources.push({ label: `Point : ${s.label}`, get: () => s.snap }));
    for (const v of g.store.versions(g.universe.id)) sources.push({ label: `Sauvegarde : ${new Date(v.savedAt).toLocaleString('fr-FR')} (${v.label})`, get: () => g.store.load(g.universe.id, v.index).systems[g.systemKey] ?? g.store.load(g.universe.id, v.index).current });
    for (const [k, s] of Object.entries(g.universe.systems)) if (k !== g.systemKey) sources.push({ label: `Autre système : ${k}`, get: () => s });
    let a = 0, b = Math.min(1, sources.length - 1);
    const out = h('div', { class: 'cmp-out' });
    const render = () => {
      clear(out);
      const snap = (i: number): WorldSnapshot => sources[i].get() ?? { time: g.world.time, nextId: g.world.nextId, bodies: g.world.bodies, particles: [], settings: g.world.settings, events: [] };
      const A = validateSnapshot(JSON.parse(JSON.stringify(snap(a)))), B = validateSnapshot(JSON.parse(JSON.stringify(snap(b))));
      const stats = (s: WorldSnapshot) => {
        const kinds: Record<string, number> = {};
        let mass = 0;
        for (const x of s.bodies) { kinds[x.kind] = (kinds[x.kind] ?? 0) + 1; mass += x.mass; }
        const planets = s.bodies.filter((x) => x.planet && x.kind === 'planet');
        return {
          'Temps local': fmtYears(s.time), 'Corps massifs': String(s.bodies.length), 'Masse totale': fmtMassSun(mass),
          'Étoiles': String((kinds.star ?? 0) + (kinds.protostar ?? 0)), 'Rémanents compacts': String((kinds.whitedwarf ?? 0) + (kinds.neutronstar ?? 0) + (kinds.blackhole ?? 0)),
          'Planètes': String(kinds.planet ?? 0), 'Lunes': String(kinds.moon ?? 0), 'Nébuleuses': String(kinds.nebula ?? 0),
          'Planètes habitables': String(planets.filter((p) => habitability(p as Body) > 0.35).length),
          'Planètes avec vie': String(planets.filter((p) => (p.planet?.life ?? 0) > 0).length),
          'Débris (sauvegardés)': String(s.particles.length),
        } as Record<string, string>;
      };
      const sa = stats(A), sb = stats(B);
      const tbl = h('table', { class: 'tbl cmp' }, h('tr', null, h('th', null, ''), h('th', null, 'A'), h('th', null, 'B')));
      for (const k of Object.keys(sa)) tbl.appendChild(h('tr', { class: sa[k] !== sb[k] ? 'diff' : '' }, h('td', null, k), h('td', null, sa[k]), h('td', null, sb[k])));
      // différences par corps
      const byName = new Map(B.bodies.map((x) => [x.id, x]));
      const changes: string[] = [];
      for (const x of A.bodies) {
        const y = byName.get(x.id);
        if (!y) { changes.push(`− ${x.name} n'existe plus dans B`); continue; }
        if (x.kind !== y.kind) changes.push(`${x.name} : ${x.kind} → ${y.kind}`);
        else if (Math.abs(x.mass - y.mass) / x.mass > 0.01) changes.push(`${x.name} : masse ${fmtMassSun(x.mass)} → ${fmtMassSun(y.mass)}`);
        if (x.planet && y.planet && Math.abs(x.temperature - y.temperature) > 20) changes.push(`${x.name} : ${Math.round(x.temperature)} K → ${Math.round(y.temperature)} K`);
      }
      const idsA = new Set(A.bodies.map((x) => x.id));
      for (const y of B.bodies) if (!idsA.has(y.id)) changes.push(`+ ${y.name} apparaît dans B`);
      const cva = h('canvas', { width: 260, height: 260, class: 'map2d' }) as HTMLCanvasElement;
      const cvb = h('canvas', { width: 260, height: 260, class: 'map2d' }) as HTMLCanvasElement;
      drawTopDown(cva, A.bodies);
      drawTopDown(cvb, B.bodies);
      out.append(tbl, h('div', { class: 'cmp-maps' }, h('div', null, h('b', null, 'A'), cva), h('div', null, h('b', null, 'B'), cvb)), h('h4', null, 'Changements'), h('ul', { class: 'changes' }, ...(changes.length ? changes.slice(0, 40).map((t) => h('li', null, t)) : [h('li', { class: 'muted' }, 'Aucune différence notable.')])));
    };
    const opts = sources.map((s, i) => [String(i), s.label] as [string, string]);
    c.append(
      h('p', { class: 'muted' }, 'Comparez l\'état actuel avec un point de restauration, une version sauvegardée ou un autre système visité.'),
      h('div', { class: 'cmp-sel' },
        select('État A', opts, String(a), (v) => { a = Number(v); render(); }, 'cmp-a'),
        select('État B', opts, String(b), (v) => { b = Number(v); render(); }, 'cmp-b'),
      ),
      out,
    );
    render();
  }

  // =========================================================================
  // Options
  // =========================================================================

  private buildSettings(c: HTMLElement): void {
    const g = this.game;
    const s = g.engine.settings;
    const w = g.world.settings;
    const a = g.audio.settings;
    const apply = () => g.engine.applySettings({ ...s });
    c.append(
      h('h4', null, 'Graphismes'),
      select<QualityPreset>('Préréglage', [['performance', 'Mode performance'], ['equilibre', 'Équilibré'], ['qualite', 'Mode qualité']], s.preset, (v) => { g.setQuality(v); this.reopen('settings'); }, 'quality'),
      slider({ label: 'Résolution de rendu', min: 0.5, max: 2, value: s.pixelRatio, step: 0.05, unit: '×', onChange: (v) => { s.pixelRatio = v; apply(); } }),
      toggle('Halo lumineux (bloom)', s.bloom, (v) => { s.bloom = v; apply(); }),
      slider({ label: 'Intensité du bloom', min: 0, max: 2.5, value: s.bloomStrength, step: 0.05, onInput: (v) => { s.bloomStrength = v; apply(); } }),
      toggle('Lentille gravitationnelle (lancer de rayons)', s.lensing, (v) => { s.lensing = v; apply(); }),
      slider({ label: 'Précision de la lentille (pas)', min: 40, max: 400, value: s.lensSteps, step: 10, onChange: (v) => { s.lensSteps = Math.round(v); apply(); } }),
      toggle('Ombres d\'éclipses', s.eclipseShadows, (v) => { s.eclipseShadows = v; apply(); }),
      toggle('Étiquettes', s.labels, (v) => { s.labels = v; apply(); }),
      slider({ label: 'Particules affichées (max)', min: 2000, max: 40000, value: s.particleBudget, step: 1000, onChange: (v) => { s.particleBudget = Math.round(v); apply(); } }),
      slider({ label: 'Détail des terrains (segments)', min: 48, max: 256, value: s.terrainDetail, step: 16, onChange: (v) => { s.terrainDetail = Math.round(v); apply(); } }),
      slider({ label: 'Pas des nébuleuses volumétriques', min: 12, max: 120, value: s.volumetricSteps, step: 4, onChange: (v) => { s.volumetricSteps = Math.round(v); apply(); g.toast('Appliqué aux nouvelles nébuleuses.', 'info'); } }),
      h('h4', null, 'Simulation'),
      select('Intégrateur', [['auto', 'Automatique (N-corps ↔ Kepler)'], ['nbody', 'N-corps (exact, lent à haute vitesse)'], ['kepler', 'Kepler séculaire (rapide, approx.)']], w.integration, (v) => (w.integration = v as typeof w.integration)),
      toggle('Collisions et marées', w.collisions, (v) => (w.collisions = v)),
      toggle('Évolution stellaire', w.stellarEvolution, (v) => (w.stellarEvolution = v)),
      toggle('Gravité de la matière noire', w.darkMatterGravity, (v) => (w.darkMatterGravity = v)),
      slider({ label: 'Amplification divine des ondes gravitationnelles', min: 1, max: 1e15, value: w.gwBoost, log: true, unit: '×', hint: '1 = relativité générale réelle (les fusions prennent alors des milliards d\'années)', onChange: (v) => (w.gwBoost = v) }),
      slider({ label: 'Budget de calcul par image', min: 2, max: 30, value: w.budgetMs, step: 1, unit: 'ms', onChange: (v) => (w.budgetMs = v) }),
      h('h4', null, 'Audio'),
      h('p', { class: 'muted' }, 'Le son est une mise en scène : il ne se propage pas dans le vide spatial.'),
      toggle('Muet', a.muted, (v) => { a.muted = v; g.audio.applySettings(); }),
      slider({ label: 'Volume général', min: 0, max: 1, value: a.master, step: 0.01, onInput: (v) => { a.master = v; g.audio.applySettings(); } }),
      slider({ label: 'Musique adaptative', min: 0, max: 1, value: a.music, step: 0.01, onInput: (v) => { a.music = v; g.audio.applySettings(); } }),
      slider({ label: 'Effets', min: 0, max: 1, value: a.sfx, step: 0.01, onInput: (v) => { a.sfx = v; g.audio.applySettings(); } }),
      slider({ label: 'Ambiance cosmique', min: 0, max: 1, value: a.ambience, step: 0.01, onInput: (v) => { a.ambience = v; g.audio.applySettings(); } }),
      h('h4', null, 'Diagnostic'),
      readout('Rendu', () => `${Math.round(g.engine.fps)} i/s · ${g.engine.stats.calls} appels · ${fmt(g.engine.stats.triangles, 3)} triangles`, []),
      readout('WebGL', () => (g.engine.renderer.capabilities.isWebGL2 ? 'WebGL 2' : 'WebGL 1'), []),
    );
  }

  // =========================================================================
  // Aide
  // =========================================================================

  private buildHelp(c: HTMLElement): void {
    c.innerHTML = `
      <h4>Commandes</h4>
      <table class="tbl keys">
        <tr><td>Glisser (clic gauche)</td><td>Tourner autour de la cible</td></tr>
        <tr><td>Clic droit / Maj + glisser</td><td>Déplacer la cible</td></tr>
        <tr><td>Molette / pincement</td><td>Zoom multi-échelle (au-delà des limites : changement d'échelle)</td></tr>
        <tr><td>Clic / double-clic</td><td>Sélectionner / rejoindre un objet</td></tr>
        <tr><td>Espace, [ et ]</td><td>Pause, ralentir, accélérer le temps</td></tr>
        <tr><td>S M C P K X</td><td>Outils : sélection, déplacer, créer, pousser, collision, détruire</td></tr>
        <tr><td>A · V · F · Tab · H</td><td>Analyse · mode caméra · rejoindre · carte · masquer l'interface</td></tr>
        <tr><td>Ctrl+Z / Ctrl+Y / Ctrl+S</td><td>Annuler / rétablir / sauvegarder</td></tr>
        <tr><td>Caméra libre</td><td>ZQSD ou WASD, E/C (monter/descendre), Maj (vite)</td></tr>
      </table>
      <h4>Légende scientifique</h4>
      <p><span class="badge b-sci">Science établie</span> physique mesurée et bien comprise ·
      <span class="badge b-approx">Approximation</span> modèle simplifié pour le temps réel ·
      <span class="badge b-hyp">Hypothèse</span> théorie non confirmée ·
      <span class="badge b-div">Pouvoir divin</span> action impossible dans la réalité.</p>
      <h4>Ce qui est simulé</h4>
      <ul>
        <li><b>Systèmes stellaires</b> : gravitation newtonienne N-corps exacte (leapfrog adaptatif, Barnes–Hut au-delà de 300 corps), mode Kepler séculaire pour les très fortes accélérations du temps.</li>
        <li><b>Étoiles</b> : relations masse–luminosité–rayon, durées de vie, géantes, naines blanches (relation masse initiale–finale), supernovas, étoiles à neutrons, trous noirs.</li>
        <li><b>Trous noirs</b> : rayon de Schwarzschild, ISCO de Kerr, efficacité d'accrétion, limite d'Eddington, ruptures de marée ; lentille par intégration de géodésiques de Schwarzschild (le spin n'affecte pas la géodésique dans ce rendu) ; fusions avec ajustements de relativité numérique et ondes gravitationnelles (formule de Peters). L'amplification des ondes est un pouvoir divin réglable.</li>
        <li><b>Planètes</b> : gravité, température d'équilibre, effet de serre paramétrique, états de l'eau, échappement atmosphérique, habitabilité et vie (modèle spéculatif).</li>
        <li><b>Galaxies</b> : étoiles-traceurs dans un potentiel analytique avec halo de matière noire NFW ; les étoiles ne s'attirent pas entre elles (approximation) ; fusions par N-corps restreint.</li>
        <li><b>Matière noire</b> : uniquement son effet gravitationnel. <b>Énergie noire</b> : terme de Friedmann de paramètre w constant.</li>
        <li><b>Big Bang</b> : équations de Friedmann, température du rayonnement, croissance linéaire des structures et approximation de Zel'dovich ; l'inflation et l'ère de Planck sont symboliques.</li>
        <li><b>Laboratoire atomique</b> : règles stylisées (barrière coulombienne, ionisation, valence) ; pas de mécanique quantique.</li>
      </ul>
      <h4>Son</h4>
      <p>Dans le vide, aucun son ne se propage : l'ambiance, la musique et les effets sont une mise en scène destinée au joueur.</p>`;
  }

  // =========================================================================
  // Carte de l'univers
  // =========================================================================

  private buildMap(c: HTMLElement): () => void {
    const g = this.game;
    const canvas = h('canvas', { width: 640, height: 420, class: 'map2d big', 'data-testid': 'map-canvas' }) as HTMLCanvasElement;
    let mode: 'system' | 'galaxy' | 'cosmic' = g.level === 'galaxy' ? 'galaxy' : g.level === 'cosmic' ? 'cosmic' : 'system';
    const tabs = h('div', { class: 'tabs' });
    const renderTabs = () => {
      clear(tabs);
      for (const [m, l] of [['system', 'Système stellaire'], ['galaxy', 'Galaxie'], ['cosmic', 'Voisinage cosmique']] as const) {
        tabs.appendChild(h('button', { class: `tab${mode === m ? ' on' : ''}`, onclick: () => { mode = m; renderTabs(); } }, l));
      }
    };
    renderTabs();
    const info = h('p', { class: 'muted' }, 'Cliquez sur la carte pour y voyager.');
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * canvas.width, y = ((e.clientY - r.top) / r.height) * canvas.height;
      const hit = this.mapHits.find((m) => Math.hypot(m.x - x, m.y - y) < 10);
      if (!hit) return;
      this.close('map');
      if (mode === 'system') { if (g.level !== 'system' && g.level !== 'planet') void g.jumpToLevel('system').then(() => g.focus(hit.id)); else g.focus(hit.id); }
      else if (mode === 'galaxy') { void (g.level === 'galaxy' ? g.enterStar(Number(hit.id.slice(1))) : g.goGalaxy()); }
      else void g.enterGalaxy(hit.id.slice(1));
    });
    c.append(tabs, canvas, info);
    return () => this.drawMap(canvas, mode);
  }

  private mapHits: { x: number; y: number; id: string }[] = [];

  private drawMap(canvas: HTMLCanvasElement, mode: 'system' | 'galaxy' | 'cosmic'): void {
    const g = this.game;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#03060c';
    ctx.fillRect(0, 0, W, H);
    this.mapHits = [];
    ctx.font = '11px system-ui';
    if (mode === 'system') {
      const p = g.world.primary();
      if (!p) return;
      const ext = g.systemExtent() * 1.15;
      const sc = (Math.min(W, H) / 2) / ext;
      const X = (x: number) => W / 2 + (x - p.pos.x) * sc, Y = (z: number) => H / 2 + (z - p.pos.z) * sc;
      ctx.strokeStyle = 'rgba(120,170,255,0.15)';
      for (const b of g.world.bodies) {
        if (b.kind === 'moon' || b === p || b.parentId !== p.id) continue;
        const r = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) * sc;
        ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(160,140,120,0.35)';
      const P = g.world.particles;
      for (let i = 0; i < P.count; i += 4) ctx.fillRect(X(P.px[i]), Y(P.pz[i]), 1, 1);
      for (const b of g.world.bodies) {
        if (b.kind === 'moon' || b.kind === 'darkmatter') continue;
        const x = X(b.pos.x), y = Y(b.pos.z);
        ctx.fillStyle = b.kind === 'star' ? '#ffd27a' : b.kind === 'blackhole' ? '#ff7040' : b.kind === 'nebula' ? '#ff70a0' : b.planet?.gasGiant ? '#e8c890' : '#7cb8ff';
        ctx.beginPath(); ctx.arc(x, y, b.kind === 'star' ? 6 : 3.5, 0, Math.PI * 2); ctx.fill();
        if (b.kind !== 'comet' && b.kind !== 'asteroid') { ctx.fillStyle = '#cfe0ff'; ctx.fillText(b.name, x + 6, y - 4); }
        this.mapHits.push({ x, y, id: `b${b.id}` });
      }
      ctx.fillStyle = '#8aa'; ctx.fillText(`Échelle : ${fmt(ext, 3)} UA du centre au bord`, 10, H - 10);
    } else if (mode === 'galaxy') {
      const s = g.galaxy;
      if (!s) return;
      const R = (g.currentGalaxy?.params.radius ?? 50) * 2.2;
      const sc = (Math.min(W, H) / 2) / R;
      const img = ctx.createImageData(W, H);
      for (let i = 0; i < s.n; i++) {
        const x = Math.floor(W / 2 + s.pos[i * 3] * sc), y = Math.floor(H / 2 + s.pos[i * 3 + 2] * sc);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const k = (y * W + x) * 4;
        const young = s.age[i] < 0.25;
        img.data[k] = Math.min(255, img.data[k] + (young ? 60 : 90)); img.data[k + 1] = Math.min(255, img.data[k + 1] + (young ? 90 : 80)); img.data[k + 2] = Math.min(255, img.data[k + 2] + (young ? 140 : 60)); img.data[k + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const mark = (idx: number, label: string, col: string) => {
        const x = W / 2 + s.pos[idx * 3] * sc, y = H / 2 + s.pos[idx * 3 + 2] * sc;
        ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = col; ctx.fillText(label, x + 9, y + 4);
        this.mapHits.push({ x, y, id: `s${idx}` });
      };
      if (g.currentGalaxy?.params.id === 'home') mark(g.solIndex, 'Soleil', '#ffd060');
      mark(g.currentStarIndex(), 'Système actuel', '#7cf');
      for (const k of Object.keys(g.universe.systems)) {
        const [gid, idx] = k.split(':');
        if (gid === g.currentGalaxy?.params.id && idx) mark(Number(idx), 'visité', '#9f9');
      }
      ctx.fillStyle = '#8aa'; ctx.fillText(`${g.currentGalaxy?.params.name} — rayon affiché ${fmt(R * 1000, 3)} al`, 10, H - 10);
    } else {
      const list = g.cosmic.galaxiesNear(0, 0, 0, 60).concat(g.universe.customGalaxies);
      const sc = (Math.min(W, H) / 2) / 60;
      for (const x of list) {
        const px = W / 2 + x.x * sc, py = H / 2 + x.z * sc;
        ctx.fillStyle = x.id === 'home' ? '#ffd060' : x.createdBy === 'player' ? '#f7a' : x.type === 'elliptical' ? '#fc9' : '#9cf';
        ctx.beginPath(); ctx.arc(px, py, x.id === 'home' ? 5 : 1.8 + Math.log10(x.stellarMass / 1e9), 0, Math.PI * 2); ctx.fill();
        if (x.id === 'home' || x.createdBy === 'player') ctx.fillText(x.name, px + 6, py - 4);
        this.mapHits.push({ x: px, y: py, id: `g${x.id}` });
      }
      ctx.fillStyle = '#8aa'; ctx.fillText('Projection sur le plan x–z, rayon 60 Mpc autour de la Voie lactée', 10, H - 10);
    }
  }
}

/** Carte vue de dessus d'un état de système (mode comparaison). */
function drawTopDown(canvas: HTMLCanvasElement, bodies: Body[]): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#03060c';
  ctx.fillRect(0, 0, W, H);
  if (!bodies.length) return;
  const p = bodies.reduce((a, b) => (b.mass > a.mass && b.kind !== 'darkmatter' ? b : a), bodies[0]);
  let ext = 1;
  for (const b of bodies) ext = Math.max(ext, Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z));
  ext = Math.min(ext, 200) * 1.1;
  const sc = W / 2 / ext;
  for (const b of bodies) {
    if (b.kind === 'moon') continue;
    const x = W / 2 + (b.pos.x - p.pos.x) * sc, y = H / 2 + (b.pos.z - p.pos.z) * sc;
    ctx.fillStyle = b.kind === 'star' ? '#ffd27a' : b.kind === 'blackhole' ? '#ff7040' : b.kind === 'nebula' ? '#ff70a0' : '#7cb8ff';
    ctx.beginPath(); ctx.arc(x, y, b.kind === 'star' ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
  }
  void G_SIM;
}

export type { CosmoParams };
