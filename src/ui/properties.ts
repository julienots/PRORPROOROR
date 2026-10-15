import { h, clear, slider, toggle, select, button, badge, readout, lineChart } from './dom';
import type { Game } from '../game';
import { fmt, fmtYears, fmtDistanceAU, fmtMassSun, M_EARTH_SUN, M_JUP_SUN, G_SIM, km2au, R_SUN_KM, clamp, AU_KM } from '../core/units';
import { spectralClass } from '../core/color';
import type { Body } from '../sim/types';
import { normalizeComposition } from '../sim/types';
import { orbitalElements } from '../sim/kepler';
import {
  surfaceGravity, escapeVelocity, habitability, planetTypeLabel, waterState, LIFE_LABELS, bulkDensity, waterBoilingPoint,
} from '../sim/planet';
import { habitableZone, mainSequenceLifetime, jeansMass, freeFallTime, stellarFate } from '../sim/stellar';
import {
  iscoRadiusRs, radiativeEfficiency, eddingtonLuminosity, hawkingTemperature, evaporationTime, shadowRadiusRs,
} from '../sim/blackhole';
import { GALAXY_TYPE_LABEL, GalaxySim, defaultGalaxyParams, normalizeGalaxyParams, rotationCurve, type GalaxyType, type GalaxyParams } from '../sim/galaxy';
import { MicroLab } from '../sim/micro';
import { ELEMENTS } from '../sim/elements';
import { EPOCHS, FATE_LABEL, PLANCK18, omegaK, hubbleAt } from '../sim/cosmology';
import type { GalaxyView } from '../render/views/galaxyView';
import type { CosmicView } from '../render/views/cosmicView';
import type { MicroView } from '../render/views/microView';
import type { BigBangView } from '../render/views/bigBangView';
import { hashCombine } from '../core/rng';

const KIND_LABEL: Record<string, string> = {
  nebula: 'Nébuleuse', protostar: 'Protoétoile', star: 'Étoile', browndwarf: 'Naine brune', whitedwarf: 'Naine blanche',
  neutronstar: 'Étoile à neutrons (pulsar)', blackhole: 'Trou noir', planet: 'Planète', moon: 'Lune', asteroid: 'Astéroïde', comet: 'Comète', darkmatter: 'Halo de matière noire',
};
const PHASE_LABEL: Record<string, string> = {
  collapse: 'Effondrement', protostar: 'Protoétoile', main: 'Séquence principale', subgiant: 'Sous-géante', redgiant: 'Géante rouge',
  supergiant: 'Supergéante', planetarynebula: 'Nébuleuse planétaire', whitedwarf: 'Naine blanche', neutronstar: 'Étoile à neutrons', pulsar: 'Pulsar', blackhole: 'Trou noir',
};

/** Panneau de droite : propriétés de la sélection et éditeurs selon l'échelle. */
export class PropertiesPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private live: (() => void)[] = [];
  private key = '';
  private editing = false;
  private lastTick = 0;
  private chart: { canvas: HTMLCanvasElement; draw: () => void } | null = null;

  constructor(private game: Game, parent: HTMLElement) {
    this.body = h('div', { class: 'props-body' });
    this.el = h('aside', { class: 'props', 'data-testid': 'properties' }, this.body);
    parent.appendChild(this.el);
    game.bus.on('select', () => this.rebuild());
    game.bus.on('level', () => this.rebuild(true));
    game.bus.on('universe', () => this.rebuild(true));
    game.bus.on('history', () => this.rebuild(true));
  }

  /** Enregistre l'état avant la première modification d'une série d'éditions. */
  private beginEdit(label: string): void {
    if (this.editing) return;
    this.editing = true;
    this.game.history.record(label);
    setTimeout(() => (this.editing = false), 900);
  }

  tick(): void {
    const now = performance.now();
    if (now - this.lastTick < 250) return;
    this.lastTick = now;
    // la sélection a pu disparaître (objet détruit) ou changer de nature
    const g = this.game;
    const b = g.selectedBody();
    const k = this.computeKey();
    if (k !== this.key) this.rebuild();
    for (const f of this.live) {
      try { f(); } catch { /* valeur indisponible */ }
    }
    this.chart?.draw();
    void b;
  }

  private computeKey(): string {
    const g = this.game;
    const b = g.selectedBody();
    return `${g.level}|${g.selectionId}|${b?.kind ?? ''}|${b?.star?.phase ?? ''}|${g.world.bodies.length > 0 && !g.selectionId ? g.world.version : ''}`;
  }

  rebuild(force = false): void {
    const k = this.computeKey();
    if (!force && k === this.key) return;
    this.key = k;
    this.live = [];
    this.chart = null;
    clear(this.body);
    const g = this.game;
    switch (g.level) {
      case 'system':
      case 'planet': {
        const b = g.selectedBody();
        if (b) this.bodyPanel(b);
        else if (g.selectionId?.startsWith('n')) this.neighborPanel(Number(g.selectionId.slice(1)));
        else this.systemPanel();
        break;
      }
      case 'galaxy': this.galaxyPanel(); break;
      case 'cosmic': this.cosmicPanel(); break;
      case 'micro': case 'atomic': case 'subatomic': this.microPanel(); break;
      case 'bigbang': this.bigBangPanel(); break;
    }
  }

  private section(title: string, ...children: (Node | null)[]): HTMLElement {
    const s = h('section', { class: 'psec' }, h('h3', null, title), ...children);
    this.body.appendChild(s);
    return s;
  }

  // =========================================================================
  // Système stellaire
  // =========================================================================

  /** Étoile voisine vue dans le ciel du système (voyage interstellaire). */
  private neighborPanel(idx: number): void {
    const g = this.game;
    const sv = g.views.system as import('../render/views/systemView').SystemView;
    const nb = sv.galSky.neighbors.find((n) => n.idx === idx);
    const params = g.currentGalaxy?.params;
    const key = params?.id === 'home' && idx === g.solIndex ? 'sol' : `${params?.id}:${idx}`;
    this.section(idx === g.solIndex && params?.id === 'home' ? 'Le Soleil' : `Étoile #${idx}`,
      readout('Distance', () => (nb ? `${nb.distLy.toPrecision(3)} années-lumière` : '—'), this.live),
      readout('Masse (estimée)', () => (nb ? `${nb.mass.toPrecision(3)} M☉` : '—'), this.live),
      readout('Système', () => (g.universe.systems[key] ? 'déjà visité' : 'inexploré'), this.live),
      h('p', { class: 'note' }, badge('divin'), ' Le voyage interstellaire se fait plus vite que la lumière (pouvoir divin) ; le trajet traverse réellement la galaxie simulée.'),
      h('div', { class: 'btnrow' }, button('Voyager vers cette étoile', () => g.ow.travelToStar(idx), 'primary', undefined, 'travel-star')),
    );
    this.systemPanel();
  }

  private systemPanel(): void {
    const g = this.game;
    const w = g.world;
    const p = w.primary();
    this.section('Système stellaire',
      readout('Objet central', () => { const c = p ?? w.bodies[0]; return c ? `${c.name} (${KIND_LABEL[c.kind]})` : '— (espace vide)'; }, this.live),
      readout('Corps massifs', () => String(w.bodies.length), this.live),
      readout('Particules (débris, gaz)', () => String(w.particles.count), this.live),
      readout('Masse totale', () => fmtMassSun(w.totalMass()), this.live),
      readout('Temps local', () => fmtYears(w.time), this.live),
    );
    // catalogue des objets du système
    const list = h('ul', { class: 'catalog', 'data-testid': 'body-list' });
    const sorted = [...w.bodies].sort((a, b) => b.mass - a.mass);
    for (const b of sorted.slice(0, 80)) {
      list.appendChild(h('li', { onclick: () => g.focus(`b${b.id}`), title: 'Rejoindre' }, h('i', { class: `dot k-${b.kind}` }), b.name, h('small', null, `${KIND_LABEL[b.kind]} · ${fmtMassSun(b.mass)}`)));
    }
    this.section('Catalogue des objets', list);
    this.section('Conseils',
      h('p', { class: 'muted' }, 'Cliquez sur un astre pour l\'examiner. Double-clic : la caméra le rejoint. Molette vers l\'arrière au-delà du système : échelle galactique. Sur une planète, zoom extrême : microscope.'),
    );
  }

  private bodyPanel(b: Body): void {
    const g = this.game;
    const w = g.world;
    const nameInput = h('input', { type: 'text', value: b.name, class: 'name', 'data-testid': 'body-name' }) as HTMLInputElement;
    nameInput.addEventListener('change', () => { b.name = nameInput.value.slice(0, 60) || b.name; });
    const sci = b.kind === 'darkmatter' ? badge('approx') : b.kind === 'nebula' ? badge('etabli') : b.kind === 'blackhole' ? badge('etabli') : badge('etabli');
    this.body.appendChild(h('div', { class: 'phead' }, nameInput, h('div', { class: 'kind' }, h('i', { class: `dot k-${b.kind}` }), KIND_LABEL[b.kind] ?? b.kind, ' ', sci, b.createdBy === 'player' ? badge('divin') : null)));
    this.body.appendChild(h('div', { class: 'btnrow' },
      button('Rejoindre', () => g.focus(`b${b.id}`), '', 'Vol de la caméra vers l\'objet (F)', 'focus'),
      b.planet && !b.planet.gasGiant ? button(g.surface?.bodyId === b.id ? 'Décoller' : 'Atterrir', () => { if (g.surface?.bodyId === b.id) g.ow.leaveSurface(); else g.ow.land(b.id); this.rebuild(true); }, 'primary', 'Exploration au sol (L)', 'land') : null,
      button('Suivre', () => { g.engine.rig.mode = 'follow'; g.focus(`b${b.id}`); }),
      b.planet && !b.planet.gasGiant ? button('Surface', () => g.exploreSurface(), '', 'Exploration rapprochée de la surface', 'explore') : null,
      b.planet ? button('Microscope', () => void g.goMicro(), '', 'Plonger dans la matière de cet astre', 'microscope') : null,
      button(b.pinned ? 'Libérer' : 'Épingler', () => { g.act('pin'); this.rebuild(true); }, '', 'Fixer la position (pouvoir divin)'),
    ));
    // propriétés générales
    const parent = () => (b.parentId !== undefined ? w.get(b.parentId) : undefined);
    const orbit = () => {
      const p = parent();
      if (!p) return null;
      return orbitalElements(
        { x: b.pos.x - p.pos.x, y: b.pos.y - p.pos.y, z: b.pos.z - p.pos.z },
        { x: b.vel.x - p.vel.x, y: b.vel.y - p.vel.y, z: b.vel.z - p.vel.z },
        G_SIM * (p.mass + b.mass),
      );
    };
    this.section('Propriétés',
      readout('Masse', () => fmtMassSun(b.mass), this.live),
      readout('Rayon', () => (b.radius > 0.05 * R_SUN_KM ? `${fmt(b.radius / R_SUN_KM, 4)} R☉` : `${fmt(b.radius, 4)} km`), this.live),
      readout('Température', () => (b.kind === 'blackhole' ? `${fmt(hawkingTemperature(b.mass), 3)} K (Hawking)` : `${fmt(b.temperature, 4)} K`), this.live),
      readout('Vitesse', () => `${fmt(Math.hypot(b.vel.x, b.vel.y, b.vel.z) / 0.21095, 4)} km/s`, this.live),
      readout('Corps dominant', () => parent()?.name ?? '—', this.live),
      readout('Distance au parent', () => { const p = parent(); return p ? fmtDistanceAU(Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y, b.pos.z - p.pos.z)) : '—'; }, this.live),
      readout('Orbite (a, e)', () => { const o = orbit(); return o ? (o.a > 0 ? `${fmtDistanceAU(o.a)}, e = ${o.e.toFixed(3)}` : `non liée (e = ${o.e.toFixed(2)})`) : '—'; }, this.live),
      readout('Période orbitale', () => { const o = orbit(); return o && Number.isFinite(o.period) ? fmtYears(o.period) : '—'; }, this.live),
      readout('Âge', () => fmtYears(b.star?.age ?? b.age), this.live),
    );
    if (b.planet) this.planetEditor(b);
    if (b.star && (b.kind === 'star' || b.kind === 'protostar')) this.starEditor(b);
    if (b.kind === 'whitedwarf' || b.kind === 'neutronstar') this.compactInfo(b);
    if (b.kind === 'blackhole') this.blackHoleEditor(b);
    if (b.kind === 'nebula') this.nebulaEditor(b);
    if (b.kind === 'darkmatter') this.darkMatterEditor(b);
    // pouvoirs génériques
    this.section('Pouvoirs divins',
      h('div', { class: 'btnrow wrap' },
        button('Orbite circulaire', () => g.act('circularize'), '', 'Place l\'objet sur une orbite circulaire autour de son parent'),
        button('Arrêter', () => g.act('stop'), '', 'Annule sa vitesse relative à l\'objet central'),
        b.planet ? button('Impact d\'astéroïde', () => g.act('impact', 0.001), '', 'Un astéroïde de 0,001 M⊕ percute l\'objet', 'impact') : null,
        b.planet ? button('Impact géant', () => g.act('impact', 0.1), 'danger', 'Un corps de 0,1 M⊕ percute l\'objet (type Théia)') : null,
        b.kind !== 'blackhole' && w.bodies.some((x) => x.kind === 'blackhole') ? button('Jeter dans le trou noir', () => g.act('feed'), 'danger', undefined, 'feed-bh') : null,
        button('Pulvériser', () => g.act('explode'), 'danger', 'Destruction (débris persistants)', 'explode'),
      ),
    );
  }

  private planetEditor(b: Body): void {
    const g = this.game;
    const p = b.planet!;
    const edit = (fn: () => void) => { this.beginEdit(`Édition de ${b.name}`); fn(); g.world.refreshDerived(b); };
    const parent = b.parentId !== undefined ? g.world.get(b.parentId) : g.world.primary();
    this.section(`Éditeur de planète — ${planetTypeLabel(b)}`,
      readout('Gravité de surface', () => `${fmt(surfaceGravity(b), 3)} m/s² (${fmt(surfaceGravity(b) / 9.81, 3)} g)`, this.live),
      readout('Vitesse de libération', () => `${fmt(escapeVelocity(b) / 1000, 3)} km/s`, this.live),
      readout('Densité', () => `${fmt(bulkDensity(b), 4)} kg/m³`, this.live),
      readout('Eau', () => { const ws = waterState(b.temperature, p); return `${ws}${ws === 'liquide' ? ` (ébullition ${fmt(waterBoilingPoint(p.pressure), 3)} K)` : ''}`; }, this.live),
      readout('Habitabilité', () => `${(habitability(b) * 100).toFixed(0)} %`, this.live),
      readout('Vie', () => `${LIFE_LABELS[p.life]}${p.life > 0 ? '' : p.lifeTimer > 0 ? ` (conditions favorables depuis ${fmtYears(p.lifeTimer)})` : ''}`, this.live),
      h('p', { class: 'note' }, badge('approx'), ' Habitabilité et apparition de la vie : modèle spéculatif.'),
      slider({ label: 'Masse', min: 1e-6, max: b.kind === 'planet' ? 4000 : 10, value: b.mass / M_EARTH_SUN, log: true, unit: 'M⊕', testid: 'planet-mass', onInput: (v) => edit(() => { b.mass = Math.min(v * M_EARTH_SUN, 0.012); if (b.mass > 15 * M_EARTH_SUN && !p.gasGiant && b.composition.hydrogen > 0.3) p.gasGiant = true; }) }),
      parent && parent !== b ? slider({
        label: 'Rayon orbital', min: Math.max(km2au(parent.radius) * 1.6, 1e-4), max: 2000, value: Math.max(1e-4, Math.hypot(b.pos.x - parent.pos.x, b.pos.y - parent.pos.y, b.pos.z - parent.pos.z)), log: true, unit: 'UA', testid: 'planet-orbit',
        onChange: (v) => edit(() => g.world.placeInOrbit(b, parent, v, 0, Math.atan2(b.pos.z - parent.pos.z, b.pos.x - parent.pos.x))),
      }) : null,
      !p.gasGiant ? slider({ label: 'Surface couverte d\'eau', min: 0, max: 1, value: p.waterFraction, step: 0.01, testid: 'planet-water', onChange: (v) => edit(() => (p.waterFraction = v)) }) : null,
      !p.gasGiant ? slider({ label: 'Continents (fragmentation)', min: 0, max: 1, value: p.continents, step: 0.01, onChange: (v) => edit(() => (p.continents = v)) }) : null,
      slider({ label: 'Pression atmosphérique', min: 1e-4, max: 1e4, value: Math.max(p.pressure, 1e-4), log: true, unit: 'atm', testid: 'planet-pressure', onChange: (v) => edit(() => (p.pressure = v < 1.1e-4 ? 0 : v)) }),
      slider({ label: 'Effet de serre (à 1 atm)', min: 0, max: 150, value: p.greenhouse, step: 1, unit: 'K', onChange: (v) => edit(() => (p.greenhouse = v)) }),
      slider({ label: 'Albédo', min: 0, max: 0.95, value: p.albedo, step: 0.01, onChange: (v) => edit(() => (p.albedo = v)) }),
      slider({ label: 'Période de rotation', min: 1, max: 6000, value: p.rotationHours, log: true, unit: 'h', onInput: (v) => edit(() => (p.rotationHours = v)) }),
      slider({ label: 'Inclinaison de l\'axe', min: 0, max: 180, value: p.axialTilt, step: 0.5, unit: '°', onInput: (v) => edit(() => (p.axialTilt = v)) }),
      !p.gasGiant ? slider({ label: 'Activité volcanique', min: 0, max: 1, value: p.volcanism, step: 0.01, onChange: (v) => edit(() => (p.volcanism = v)) }) : null,
      slider({ label: 'Champ magnétique', min: 0, max: 20, value: p.magneticField, step: 0.05, unit: '× Terre', hint: 'Protège l\'atmosphère du vent stellaire (modèle simplifié)', onChange: (v) => edit(() => (p.magneticField = v)) }),
      toggle('Anneaux', p.hasRings, (v) => edit(() => { p.hasRings = v; if (v && p.ringOuter <= p.ringInner) { p.ringInner = 1.3; p.ringOuter = 2.3; } })),
    );
    const comp = b.composition;
    const compSlider = (label: string, key: keyof typeof comp) => slider({
      label, min: 0, max: 1, value: comp[key], step: 0.01,
      onChange: (v) => edit(() => { comp[key] = v; normalizeComposition(comp); }),
    });
    this.section('Composition (fractions massiques)',
      compSlider('Roches (silicates)', 'rock'), compSlider('Métaux (Fe/Ni)', 'metal'), compSlider('Eau', 'water'), compSlider('Glaces', 'ice'),
      compSlider('Gaz H/He', 'hydrogen'), compSlider('Matière organique', 'organic'),
    );
    this.section('Lunes et vie',
      h('div', { class: 'btnrow wrap' },
        button('Ajouter une lune', () => g.act('addmoon'), '', undefined, 'add-moon'),
        !p.gasGiant ? button('Semer la vie', () => edit(() => { b.composition.organic = Math.max(b.composition.organic, 0.05); normalizeComposition(b.composition); p.lifeTimer = Math.max(p.lifeTimer, 3.1e8); g.toast(`Matière organique ensemencée sur ${b.name} (pouvoir divin). La vie n'apparaîtra que si les conditions sont habitables.`, 'divine'); }), '', 'Pouvoir divin : apporte des molécules organiques') : null,
        !p.gasGiant ? button('Stériliser', () => edit(() => { p.life = 0; p.lifeTimer = 0; })) : null,
      ),
    );
  }

  private starEditor(b: Body): void {
    const g = this.game;
    const s = b.star!;
    const edit = (fn: () => void, refresh = true) => { this.beginEdit(`Édition de ${b.name}`); fn(); if (refresh) g.world.refreshDerived(b); };
    this.section('Éditeur d\'étoile',
      readout('Phase', () => PHASE_LABEL[s.phase] ?? s.phase, this.live),
      readout('Classe spectrale', () => `${spectralClass(b.temperature)} (${fmt(b.temperature, 4)} K)`, this.live),
      readout('Luminosité', () => `${fmt(s.luminosity, 4)} L☉`, this.live),
      readout('Durée de vie (séq. principale)', () => fmtYears(s.msLifetime), this.live),
      readout('Âge relatif', () => `${((s.age / s.msLifetime) * 100).toFixed(1)} %`, this.live),
      readout('Zone habitable', () => { const [a, c] = habitableZone(s.luminosity); return `${fmt(a, 3)} – ${fmt(c, 3)} UA`; }, this.live),
      readout('Destin', () => ({ whitedwarf: 'Naine blanche', neutronstar: 'Supernova → étoile à neutrons', blackhole: 'Supernova → trou noir' })[stellarFate(s.zamsMass)], this.live),
      h('p', { class: 'note' }, badge('approx'), ' Évolution stellaire par relations d\'échelle (pas de modèle de structure interne).'),
      slider({ label: 'Masse', min: 0.08, max: 150, value: s.zamsMass, log: true, unit: 'M☉', testid: 'star-mass', onChange: (v) => edit(() => { const f = s.age / s.msLifetime; b.mass = v; s.zamsMass = v; s.msLifetime = mainSequenceLifetime(v); s.age = f * s.msLifetime; }) }),
      slider({ label: 'Métallicité Z', min: 1e-4, max: 0.08, value: s.metallicity, log: true, onChange: (v) => edit(() => (s.metallicity = v), false) }),
      slider({ label: 'Âge (fraction de la séquence principale)', min: 0, max: 1.15, value: s.age / s.msLifetime, step: 0.005, testid: 'star-age', onChange: (v) => { this.beginEdit(`Âge de ${b.name}`); g.world.ageStar(b.id, v); } }),
      slider({ label: 'Période de rotation', min: 0.1, max: 200, value: s.rotationDays, log: true, unit: 'j', onChange: (v) => edit(() => (s.rotationDays = v), false) }),
      h('div', { class: 'btnrow wrap' },
        button('→ Géante rouge', () => g.act('age', 1.08), '', 'Avance l\'étoile après sa séquence principale'),
        button('Fin de vie', () => g.act('age', 1.2), '', 'Avance jusqu\'à la fin de vie naturelle'),
        button('SUPERNOVA', () => g.act('supernova'), 'danger', 'Explosion (forcée si la masse est insuffisante : pouvoir divin)', 'supernova'),
      ),
    );
  }

  private compactInfo(b: Body): void {
    this.section(b.kind === 'whitedwarf' ? 'Naine blanche' : 'Étoile à neutrons',
      readout('Densité moyenne', () => `${fmt(bulkDensity(b), 3)} kg/m³`, this.live),
      readout('Gravité de surface', () => `${fmt(surfaceGravity(b), 3)} m/s²`, this.live),
      h('p', { class: 'muted' }, b.kind === 'whitedwarf' ? 'Cœur dégénéré refroidissant lentement (limite de Chandrasekhar 1,44 M☉).' : 'Matière nucléaire dégénérée ; les faisceaux du pulsar balaient l\'espace à chaque rotation.'),
    );
  }

  private blackHoleEditor(b: Body): void {
    const g = this.game;
    const bh = b.bh!;
    const edit = (fn: () => void) => { this.beginEdit(`Édition de ${b.name}`); fn(); g.world.refreshDerived(b); };
    const rsKm = () => b.radius;
    this.section('Éditeur de trou noir',
      readout('Rayon de Schwarzschild', () => `${fmt(rsKm(), 4)} km (${fmt(km2au(rsKm()), 3)} UA)`, this.live),
      readout('ISCO (orbite stable minimale)', () => `${fmt(iscoRadiusRs(bh.spin), 3)} Rs`, this.live),
      readout('Rayon de l\'ombre', () => `${fmt(shadowRadiusRs * rsKm(), 4)} km`, this.live),
      readout('Efficacité radiative', () => `${(radiativeEfficiency(bh.spin) * 100).toFixed(1)} % de mc²`, this.live),
      readout('Accrétion', () => `${fmt(bh.accretionRate, 3)} M☉/an`, this.live),
      readout('Luminosité', () => `${fmt(bh.luminosity, 3)} L☉ (Eddington ${fmt(eddingtonLuminosity(b.mass), 3)})`, this.live),
      readout('Matière du disque', () => fmtMassSun(bh.diskMass), this.live),
      readout('Masse avalée', () => fmtMassSun(bh.swallowed), this.live),
      readout('Évaporation de Hawking', () => fmtYears(evaporationTime(b.mass)), this.live),
      h('p', { class: 'note' }, badge('etabli'), ' Horizon, ISCO de Kerr, efficacité. ', badge('approx'), ' Lentille : géodésiques de Schwarzschild ; disque mince.'),
      slider({ label: 'Masse', min: 3, max: 1e10, value: b.mass, log: true, unit: 'M☉', testid: 'bh-mass', onChange: (v) => edit(() => (b.mass = v)) }),
      slider({ label: 'Rotation (spin a*)', min: 0, max: 0.998, value: bh.spin, step: 0.001, testid: 'bh-spin', onInput: (v) => edit(() => (bh.spin = v)) }),
      slider({ label: 'Inclinaison de l\'axe', min: 0, max: 180, value: (Math.acos(clamp(bh.axis.y, -1, 1)) * 180) / Math.PI, step: 1, unit: '°', onInput: (v) => edit(() => { const t = (v * Math.PI) / 180; bh.axis = { x: Math.sin(t), y: Math.cos(t), z: 0 }; }) }),
      toggle('Jets relativistes', bh.jets, (v) => edit(() => (bh.jets = v))),
      h('div', { class: 'btnrow wrap' },
        button('+ 0,01 M☉ de gaz', () => g.act('accrete', 0.01), '', 'Ajoute de la matière environnante (disque)', 'bh-feed'),
        button('+ 1 M☉ de gaz', () => g.act('accrete', 1)),
        button('Approcher', () => { g.engine.rig.mode = 'follow'; g.engine.rig.flyTo(b.pos, km2au(b.radius) * 25, 3); }, '', 'Approche de la caméra à 25 Rs', 'bh-approach'),
        button('Créer une binaire', () => g.act('bhbinary'), '', 'Ajoute un second trou noir en orbite : spirale et fusion avec ondes gravitationnelles', 'bh-binary'),
      ),
    );
    if (bh.merger) this.section('Fusion en cours', h('p', null, `Coalescence : ${fmt(bh.merger.m1, 3)} + ${fmt(bh.merger.m2, 3)} M☉ ; ${fmt(bh.merger.radiatedMass, 3)} M☉ rayonnées en ondes gravitationnelles (pic ≈ ${fmt(bh.merger.peakFrequencyHz, 3)} Hz).`));
  }

  private nebulaEditor(b: Body): void {
    const g = this.game;
    const n = b.nebula!;
    const edit = (fn: () => void) => { this.beginEdit(`Édition de ${b.name}`); fn(); g.world.refreshDerived(b); };
    this.section(n.remnant ? 'Rémanent en expansion' : 'Nuage moléculaire',
      readout('Masse de Jeans', () => fmtMassSun(jeansMass(n.gasTemperature, n.density)), this.live),
      readout('Instable ?', () => (b.mass > jeansMass(n.gasTemperature, n.density) ? 'oui — effondrement gravitationnel' : 'non — pression thermique suffisante'), this.live),
      readout('Temps de chute libre', () => fmtYears(freeFallTime(n.density)), this.live),
      readout('Progression de l\'effondrement', () => `${(n.collapseProgress * 100).toFixed(1)} %`, this.live),
      readout('Éléments lourds', () => `${((b.composition.heavy + b.composition.metal) * 100).toFixed(1)} %`, this.live),
      h('p', { class: 'note' }, badge('etabli'), ' Critère de Jeans et temps de chute libre.'),
      slider({ label: 'Masse', min: 0.01, max: 1e5, value: b.mass, log: true, unit: 'M☉', onChange: (v) => edit(() => (b.mass = v)) }),
      slider({ label: 'Densité', min: 1, max: 1e7, value: n.density, log: true, unit: 'cm⁻³', testid: 'neb-density', onChange: (v) => edit(() => (n.density = v)) }),
      slider({ label: 'Température', min: 3, max: 1e7, value: n.gasTemperature, log: true, unit: 'K', onChange: (v) => edit(() => (n.gasTemperature = v)) }),
      h('div', { class: 'btnrow wrap' },
        button('Onde de choc (×3 densité)', () => edit(() => (n.density *= 3))),
        button('Effondrement immédiat', () => { this.beginEdit(`Effondrement de ${b.name}`); g.world.formStar(b); g.toast('Effondrement accéléré (pouvoir divin).', 'divine'); }, '', 'Pouvoir divin : saute la durée de chute libre', 'neb-collapse'),
      ),
    );
  }

  private darkMatterEditor(b: Body): void {
    const g = this.game;
    const edit = (fn: () => void) => { this.beginEdit(`Édition de ${b.name}`); fn(); g.world.version++; };
    this.section('Matière noire',
      h('p', { class: 'note' }, badge('approx'), ' Nature inconnue : seul son effet gravitationnel est simulé (profil de Plummer). Invisible hors du mode analyse.'),
      slider({ label: 'Masse', min: 1e-6, max: 1e6, value: b.mass, log: true, unit: 'M☉', onChange: (v) => edit(() => (b.mass = v)) }),
      slider({ label: 'Rayon du halo', min: 0.01, max: 1e5, value: km2au(b.radius), log: true, unit: 'UA', onChange: (v) => edit(() => (b.radius = v * AU_KM)) }),
      toggle('Gravité de la matière noire active (comparer avec/sans)', g.world.settings.darkMatterGravity, (v) => { g.world.settings.darkMatterGravity = v; g.toast(v ? 'Matière noire active.' : 'Matière noire désactivée : comparez les trajectoires.', 'science'); }),
    );
  }

  // =========================================================================
  // Galaxie
  // =========================================================================

  private galaxyPanel(): void {
    const g = this.game;
    const gv = g.views.galaxy as GalaxyView;
    const sim = g.galaxy;
    const cg = g.currentGalaxy;
    if (!sim || !cg) return;
    const p = cg.params;
    const sel = g.selectionId;
    if (sel?.startsWith('s')) {
      const idx = Number(sel.slice(1));
      const info = gv.starInfo(idx);
      this.section(idx === g.solIndex && p.id === 'home' ? 'Le Soleil' : `Étoile #${idx}`,
        readout('Masse (estimée)', () => `${fmt(info?.mass ?? 0, 3)} M☉`, this.live),
        readout('Distance au centre', () => `${fmt((gv.starInfo(idx)?.distanceFromCenter ?? 0) * 1000, 4)} al`, this.live),
        readout('Vitesse orbitale', () => `${fmt(gv.starInfo(idx)?.speedKms ?? 0, 4)} km/s`, this.live),
        readout('Population', () => ((info?.age ?? 1) < 0.25 ? 'jeune (bras spiraux)' : 'âgée'), this.live),
        readout('Système', () => (g.universe.systems[p.id === 'home' && idx === g.solIndex ? 'sol' : `${p.id}:${idx}`] ? 'visité / modifié' : 'inexploré (généré à la demande)'), this.live),
        h('div', { class: 'btnrow wrap' },
          button('Voyager (pilote auto.)', () => g.ow.travelToStar(idx), 'primary', 'Vol continu jusqu\'au système', 'travel-star'),
          button('Entrer directement', () => void g.enterStar(idx), '', 'Génère le système stellaire (graine reproductible)', 'enter-star'),
        ),
      );
    }
    const comp = sim.components[0];
    this.section(`${p.name} — ${GALAXY_TYPE_LABEL[p.type]}`,
      readout('Masse stellaire', () => `${fmt(p.stellarMass, 3)} M☉`, this.live),
      readout('Halo de matière noire', () => `${fmt(p.darkMatterMass, 3)} M☉`, this.live),
      readout('Rayon du disque', () => `${fmt(p.radius * 1000, 3)} al`, this.live),
      readout('Étoiles simulées', () => `${sim.n} traceurs (représentant ~${fmt(p.stellarMass / 0.5, 2)} étoiles)`, this.live),
      readout('Temps galactique', () => `${fmt(sim.time, 4)} Ma`, this.live),
      readout('Vitesse à 2 R', () => `${fmt(rotationCurve(comp, 2).withDM[1], 3)} km/s`, this.live),
      h('p', { class: 'note' }, badge('approx'), ' Traceurs dans un potentiel analytique (bulbe Hernquist + disque Miyamoto–Nagai + halo NFW + onde de densité).'),
      toggle('Halo de matière noire actif', comp.haloOn, (v) => { sim.setHalo(v); g.toast(v ? 'Halo rétabli.' : 'Sans matière noire, les étoiles externes ne sont plus retenues : observez la dispersion du disque.', 'science'); }, 'galaxy-dm'),
    );
    // éditeur de galaxie (régénération)
    const draft: GalaxyParams = { ...p };
    this.section('Créateur / éditeur de galaxie',
      select<GalaxyType>('Type', Object.entries(GALAXY_TYPE_LABEL) as [GalaxyType, string][], draft.type, (v) => (draft.type = v)),
      slider({ label: 'Rayon', min: 2, max: 150, value: draft.radius * 1000, log: true, unit: 'al ×1000', format: (v) => (v / 1000).toFixed(1), onInput: (v) => (draft.radius = v / 1000) }),
      slider({ label: 'Masse stellaire', min: 1e8, max: 1e12, value: draft.stellarMass, log: true, unit: 'M☉', onInput: (v) => (draft.stellarMass = v) }),
      slider({ label: 'Matière noire', min: 1e6, max: 1e13, value: Math.max(draft.darkMatterMass, 1e6), log: true, unit: 'M☉', onInput: (v) => (draft.darkMatterMass = v) }),
      slider({ label: 'Fraction de gaz', min: 0, max: 0.9, value: draft.gasFraction, step: 0.01, onInput: (v) => (draft.gasFraction = v) }),
      slider({ label: 'Bulbe', min: 0, max: 1, value: draft.bulgeFraction, step: 0.01, onInput: (v) => (draft.bulgeFraction = v) }),
      slider({ label: 'Bras spiraux', min: 1, max: 6, value: draft.arms, step: 1, onInput: (v) => (draft.arms = Math.round(v)) }),
      slider({ label: 'Angle d\'enroulement', min: 5, max: 40, value: draft.pitchDeg, step: 0.5, unit: '°', onInput: (v) => (draft.pitchDeg = v) }),
      slider({ label: 'Vitesse de rotation', min: -2, max: 2, value: draft.rotation, step: 0.05, unit: '×', onInput: (v) => (draft.rotation = v) }),
      slider({ label: 'Étoiles simulées', min: 2000, max: 120000, value: draft.starCount, step: 1000, onInput: (v) => (draft.starCount = Math.round(v)) }),
      slider({ label: 'Systèmes planétaires', min: 0, max: 1, value: draft.planetFraction, step: 0.01, onInput: (v) => (draft.planetFraction = v) }),
      h('div', { class: 'btnrow' }, button('Appliquer (régénérer)', () => {
        normalizeGalaxyParams(draft);
        g.universe.galaxyOverrides[draft.id] = { ...draft };
        g.galaxy = GalaxySim.create(draft);
        g.currentGalaxy = { params: draft, cosmic: cg.cosmic };
        gv.setGalaxy(g.galaxy, draft);
        g.toast(`${draft.name} régénérée (${GALAXY_TYPE_LABEL[draft.type]}).`, 'divine');
        this.rebuild(true);
      }, 'primary', undefined, 'galaxy-apply')),
    );
    const other: { type: GalaxyType; mass: number } = { type: 'spiral', mass: p.stellarMass * 0.6 };
    this.section('Fusion de galaxies',
      h('p', { class: 'muted' }, 'Une seconde galaxie est lancée sur une orbite de rencontre. Observez les queues de marée (Toomre & Toomre 1972) et la fusion finale. Accélérez le temps !'),
      select<GalaxyType>('Type de l\'intruse', Object.entries(GALAXY_TYPE_LABEL) as [GalaxyType, string][], other.type, (v) => (other.type = v)),
      slider({ label: 'Masse stellaire', min: 1e8, max: 1e12, value: other.mass, log: true, unit: 'M☉', onInput: (v) => (other.mass = v) }),
      h('div', { class: 'btnrow' }, button('Lancer la fusion', () => {
        const q = defaultGalaxyParams(hashCombine(p.seed, sim.components.length, 99), other.type, `Intruse ${sim.components.length}`);
        q.stellarMass = other.mass;
        q.radius = 35 * Math.pow(other.mass / 5e10, 0.35);
        q.starCount = Math.round(Math.min(sim.n, 30000) * 0.6);
        sim.startMerger(q);
        g.engine.rig.flyTo({ x: 0, y: 0, z: 0 }, p.radius * 9, 2);
        g.setSpeedIndex(5);
        g.audio.setMood('destruction', 20);
        g.toast('Fusion lancée : friction dynamique et marées gravitationnelles en action.', 'divine');
      }, 'danger', undefined, 'galaxy-merge')),
    );
  }

  // =========================================================================
  // Cosmos
  // =========================================================================

  private cosmicPanel(): void {
    const g = this.game;
    const cv = g.views.cosmic as CosmicView;
    const sel = g.selectionId?.startsWith('g') ? g.findCosmicGalaxy(g.selectionId.slice(1)) : undefined;
    if (sel) {
      this.section(sel.name,
        readout('Type', () => GALAXY_TYPE_LABEL[sel.type], this.live),
        readout('Masse stellaire', () => `${fmt(sel.stellarMass, 3)} M☉`, this.live),
        readout('Distance à la Voie lactée', () => { const p = cv.positionOf(`g${sel.id}`)!; return `${fmt(Math.hypot(p.x, p.y, p.z), 4)} Mpc physiques`; }, this.live),
        readout('Vitesse de récession', () => { const p = cv.positionOf(`g${sel.id}`)!; const H = hubbleAt(g.universe.cosmology, Math.max(g.scaleFactorNow(), 1e-6)); return `≈ ${fmt(Math.hypot(p.x, p.y, p.z) * H, 4)} km/s (loi de Hubble, H = ${fmt(H, 3)})`; }, this.live),
        h('div', { class: 'btnrow wrap' },
          button('Voyager (pilote auto.)', () => g.ow.travelToGalaxy(sel.id), 'primary', undefined, 'travel-galaxy'),
          button('Entrer directement', () => void g.enterGalaxy(sel.id), '', undefined, 'enter-galaxy'),
        ),
      );
    }
    const c = g.universe.cosmology;
    this.section('Univers',
      readout('Âge cosmique', () => `${g.universe.cosmicTime.toFixed(3)} Ga`, this.live),
      readout('Facteur d\'échelle a', () => g.scaleFactorNow().toPrecision(4), this.live),
      readout('Température du fond diffus', () => `${fmt(c.T0 / Math.max(g.scaleFactorNow(), 1e-9), 4)} K`, this.live),
      readout('Destin du modèle', () => FATE_LABEL[g.cosmoHistory.fate], this.live),
      readout('Galaxies chargées', () => String(cv.galaxies.length), this.live),
      h('p', { class: 'note' }, badge('etabli'), ' Expansion selon les équations de Friedmann (ΛCDM). Les galaxies sont placées dans des secteurs générés à la demande.'),
    );
    const draft: { type: GalaxyType; mass: number } = { type: 'spiral', mass: 5e10 };
    this.section('Créer une galaxie',
      select<GalaxyType>('Type', Object.entries(GALAXY_TYPE_LABEL) as [GalaxyType, string][], draft.type, (v) => (draft.type = v)),
      slider({ label: 'Masse stellaire', min: 1e8, max: 1e12, value: draft.mass, log: true, unit: 'M☉', onInput: (v) => (draft.mass = v) }),
      h('div', { class: 'btnrow' }, button('Créer au centre de la vue', () => {
        const a = g.scaleFactorNow();
        const t = g.engine.rig.target;
        const seed = hashCombine(g.universe.seed, g.universe.customGalaxies.length, Date.now() & 0xffff);
        const ng = {
          id: `p${seed.toString(36)}`, name: `Galaxie divine ${g.universe.customGalaxies.length + 1}`, type: draft.type, seed,
          x: t.x / a, y: t.y / a, z: t.z / a, size: 0.012 * Math.pow(draft.mass / 5e10, 0.33), stellarMass: draft.mass,
          nx: 0, ny: 1, nz: 0, createdBy: 'player' as const,
        };
        g.universe.customGalaxies.push(ng);
        cv.addCustom(ng);
        g.select(`g${ng.id}`);
        g.audio.play('create');
        g.toast(`${ng.name} créée (${GALAXY_TYPE_LABEL[ng.type]}).`, 'divine');
      }, 'primary', undefined, 'create-galaxy')),
    );
    this.section('Fins d\'univers',
      h('p', { class: 'muted' }, 'Modifie le modèle cosmologique puis accélère le temps cosmique.'),
      h('div', { class: 'btnrow wrap' },
        button('Big Freeze', () => g.endOfUniverse('bigfreeze')),
        button('Big Rip', () => g.endOfUniverse('bigrip'), 'danger', undefined, 'end-bigrip'),
        button('Big Crunch', () => g.endOfUniverse('bigcrunch'), 'danger', undefined, 'end-bigcrunch'),
        button('Désintégration du vide', () => g.endOfUniverse('vacuum'), 'danger'),
      ),
      h('p', { class: 'note' }, badge('hypothese'), ' Big Rip et désintégration du vide sont des scénarios hypothétiques.'),
    );
  }

  // =========================================================================
  // Microscopique
  // =========================================================================

  private microPanel(): void {
    const g = this.game;
    const lab = g.micro;
    const mv = g.views.micro as MicroView;
    const sel = g.selectionId?.startsWith('e') ? lab.entities.find((e) => e.id === Number(g.selectionId!.slice(1))) : undefined;
    if (sel) {
      this.section(MicroLab.describe(sel),
        readout('Masse', () => `${fmt(MicroLab.mass(sel), 4)} u`, this.live),
        readout('Charge', () => `${MicroLab.charge(sel) > 0 ? '+' : ''}${MicroLab.charge(sel)} e`, this.live),
        sel.atoms && sel.atoms.length === 1 ? readout('Noyau', () => `Z = ${sel.atoms![0].Z}, N = ${sel.atoms![0].N}`, this.live) : null,
        h('div', { class: 'btnrow' },
          button('Zoom subatomique', () => mv.setSubLevel('subatomic')),
          button('Retirer', () => { lab.remove(sel); g.select(null); }),
        ),
      );
    }
    this.section(`Laboratoire — ${mv.sub === 'micro' ? 'microscopique' : mv.sub === 'subatomic' ? 'subatomique' : 'atomique'}`,
      h('p', { class: 'note' }, badge('approx'), ' Règles simplifiées : barrière coulombienne ∝ Z₁Z₂, ionisation, recombinaison, valence.'),
      slider({ label: 'Température', min: 1, max: 1e10, value: lab.temperature, log: true, unit: 'K', testid: 'lab-temp', onInput: (v) => lab.setTemperature(v) }),
      readout('Entités', () => String(lab.entities.length), this.live),
      h('div', { class: 'btnrow wrap' },
        button('+10 protons', () => lab.spawnMany('p', 10), '', undefined, 'spawn-p'),
        button('+10 neutrons', () => lab.spawnMany('n', 10), '', undefined, 'spawn-n'),
        button('+10 électrons', () => lab.spawnMany('e', 10), '', undefined, 'spawn-e'),
        button('Vider', () => lab.clear()),
        button('Recharger la matière de l\'astre', () => mv.setSource(mv.source)),
      ),
      h('div', { class: 'btnrow' }, button('↑ Retour à l\'astre', () => void g.leaveMicro(), 'primary')),
    );
    const table = h('div', { class: 'ptable' });
    for (const e of ELEMENTS) {
      table.appendChild(h('button', { class: `el c-${e.category}`, title: `${e.name} (Z=${e.Z}) — Maj+clic : noyau nu`, 'data-testid': `el-${e.symbol}`, onclick: (ev: MouseEvent) => { lab.spawnAtom(e.Z, ev.shiftKey); g.audio.play('click'); } }, h('b', null, e.symbol), h('small', null, String(e.Z))));
    }
    this.section('Tableau périodique (créer des atomes)', table);
    const census = h('ul', { class: 'census' });
    this.live.push(() => {
      const m = lab.census();
      const html = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join('');
      if (census.innerHTML !== html) census.innerHTML = html;
    });
    this.section('Recensement', census);
    const disc = h('ul', { class: 'census' });
    this.live.push(() => {
      const html = [...lab.discoveries].slice(-12).reverse().map((d) => `<li>✦ ${d}</li>`).join('');
      if (disc.innerHTML !== html) disc.innerHTML = html;
    });
    this.section('Découvertes', disc);
  }

  // =========================================================================
  // Big Bang
  // =========================================================================

  private bigBangPanel(): void {
    const g = this.game;
    const bb = g.views.bigbang as BigBangView;
    const draft = { ...bb.params };
    let seed = bb.seed;
    const seedInput = h('input', { type: 'text', value: String(seed), 'data-testid': 'bb-seed' }) as HTMLInputElement;
    seedInput.addEventListener('change', () => (seed = Number(seedInput.value) >>> 0 || 1));
    this.section('CRÉATION D\'UN UNIVERS',
      h('p', { class: 'note' }, badge('approx'), ' Représentation simplifiée : le Big Bang n\'est pas une explosion dans un espace préexistant, c\'est l\'expansion de l\'espace lui-même, partout à la fois. Les distances physiques entre toutes les structures croissent avec le facteur d\'échelle a(t).'),
      slider({ label: 'H₀ (constante de Hubble)', min: 30, max: 120, value: draft.H0, step: 0.1, unit: 'km/s/Mpc', onInput: (v) => (draft.H0 = v) }),
      slider({ label: 'Ωm (matière totale)', min: 0.05, max: 3, value: draft.omegaM, step: 0.01, testid: 'bb-om', onInput: (v) => (draft.omegaM = v) }),
      slider({ label: 'Ωb (matière ordinaire)', min: 0.005, max: 0.3, value: draft.omegaB, step: 0.001, onInput: (v) => (draft.omegaB = v) }),
      slider({ label: 'ΩΛ (énergie noire)', min: -1, max: 2, value: draft.omegaL, step: 0.01, testid: 'bb-ol', onInput: (v) => (draft.omegaL = v) }),
      slider({ label: 'w (équation d\'état de l\'énergie noire)', min: -2, max: -0.3, value: draft.w, step: 0.01, onInput: (v) => (draft.w = v) }),
      slider({ label: 'σ₈ (amplitude des fluctuations)', min: 0.2, max: 2, value: draft.sigma8, step: 0.01, onInput: (v) => (draft.sigma8 = v) }),
      slider({ label: 'nₛ (indice spectral)', min: 0.8, max: 1.2, value: draft.ns, step: 0.005, onInput: (v) => (draft.ns = v) }),
      h('label', { class: 'field' }, 'Graine des fluctuations ', seedInput),
      h('div', { class: 'btnrow wrap' },
        button('Configurer + générer', () => { bb.configure(draft, seed); g.toast('Génération du champ de densité primordial (FFT 3D)…', 'science'); void bb.generate().then(() => { g.toast(`Champ généré : ${bb.field?.halos.length ?? 0} halos détectés à a = 1.`, 'science'); this.rebuild(true); }); }, 'primary', undefined, 'bb-generate'),
        button('Valeurs Planck 2018', () => { Object.assign(draft, PLANCK18); bb.configure(PLANCK18, seed); this.rebuild(true); }),
      ),
    );
    const st = () => bb.state;
    const pos = slider({ label: 'Chronologie (échelle logarithmique du temps)', min: 0, max: 1, value: bb.progress, step: 0.001, testid: 'bb-progress', format: (v) => `${(v * 100).toFixed(1)} %`, onInput: (v) => { bb.progress = v; bb.playing = false; } });
    this.live.push(() => pos.setValue(bb.progress));
    this.section('Lecture',
      h('div', { class: 'btnrow wrap' },
        button('▶ Déclencher / lire', () => bb.play(), 'primary big', undefined, 'bb-play'),
        button('❚❚ Pause', () => (bb.playing = false), '', undefined, 'bb-pause'),
        button('⟲ Rejouer', () => { bb.progress = 0; bb.play(); }, '', undefined, 'bb-replay'),
        button('×0,5', () => (bb.speed = Math.max(0.005, bb.speed / 2))),
        button('×2', () => (bb.speed = Math.min(0.5, bb.speed * 2))),
      ),
      pos,
      readout('Temps depuis le début', () => fmtSeconds(st()?.tSeconds ?? 0), this.live),
      readout('Facteur d\'échelle a', () => (st()?.a ?? 0).toExponential(3), this.live),
      readout('Décalage vers le rouge z', () => fmt(st()?.z ?? 0, 4), this.live),
      readout('Température du rayonnement', () => `${fmt(st()?.T ?? 0, 4)} K`, this.live),
      readout('Croissance des structures D', () => (st()?.D ?? 0).toExponential(2), this.live),
      readout('Distance de deux galaxies témoins', () => `${fmt(st()?.physicalSeparationMpc ?? 0, 3)} Mpc physiques (100 Mpc comobiles)`, this.live),
      readout('Matière ayant formé des étoiles', () => `${fmt(st()?.starsLit ?? 0, 3)} particules`, this.live),
      readout('Galaxies (halos effondrés)', () => String(st()?.haloCount ?? 0), this.live),
      readout('Époque', () => st()?.epoch.name ?? '—', this.live),
    );
    const desc = h('p', { class: 'epoch-desc' });
    this.live.push(() => { const e = st()?.epoch; const t = e ? e.description : ''; if (desc.textContent !== t) desc.textContent = t; });
    const steps = h('ol', { class: 'epochs' }, ...EPOCHS.map((e) => {
      const li = h('li', { class: `ep-${e.science}` }, e.name);
      this.live.push(() => li.classList.toggle('on', st()?.epoch.id === e.id));
      return li;
    }));
    this.section('Époque cosmique', desc, steps);
    const canvas = h('canvas', { width: 300, height: 150, class: 'chart' }) as HTMLCanvasElement;
    const draw = () => {
      const hist = bb.history;
      const data: [number, number][] = [];
      for (let i = 0; i < hist.n; i += Math.max(1, Math.floor(hist.n / 300))) data.push([hist.t[i], hist.a[i]]);
      lineChart(canvas, [{ data, color: '#7cc8ff', label: 'a(t)' }], { xLabel: 't (Ga)', marker: (st()?.tSeconds ?? 0) / 3.156e16 });
    };
    this.chart = { canvas, draw };
    this.section('Expansion a(t)',
      canvas,
      readout('Âge à a = 1', () => (Number.isFinite(bb.history.age) ? `${bb.history.age.toFixed(2)} Ga` : 'jamais atteint'), this.live),
      readout('Courbure Ωk', () => omegaK(bb.params).toFixed(3), this.live),
      readout('Destin', () => FATE_LABEL[bb.history.fate], this.live),
      h('div', { class: 'btnrow' }, button('Adopter cet univers', () => bb.adopt(), 'primary', 'Les galaxies formées deviennent celles de la vue cosmique', 'bb-adopt')),
    );
  }
}

function fmtSeconds(s: number): string {
  if (s < 1e-3) return `${s.toExponential(2)} s`;
  if (s < 60) return `${s.toPrecision(3)} s`;
  if (s < 3600) return `${(s / 60).toPrecision(3)} min`;
  if (s < 3.156e7) return `${(s / 86400).toPrecision(3)} jours`;
  return fmtYears(s / 3.156e7);
}

export const _units = { M_JUP_SUN };
