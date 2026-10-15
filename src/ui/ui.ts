import { h, clear, button } from './dom';
import { Game, LEVEL_LABEL, TIME_STEPS, type Tool } from '../game';
import { fmtYears, fmt } from '../core/units';
import { CAMERA_MODE_LABEL, type CameraMode } from '../camera/rig';
import type { ScaleLevel } from '../save/serialize';
import { PropertiesPanel } from './properties';
import { Panels } from './panels';

const TOOLS: [Tool, string, string, string][] = [
  ['select', '⌖', 'Sélection', 'Cliquer pour sélectionner, double-clic pour rejoindre (S)'],
  ['move', '✥', 'Déplacer', 'Glisser un astre pour le déplacer ; son orbite est recalculée (M)'],
  ['create', '✦', 'Créer', 'Cliquer dans l\'espace pour créer l\'objet choisi dans le catalogue (C)'],
  ['push', '➚', 'Pousser', 'Glisser depuis un astre pour lui donner une impulsion (P)'],
  ['collide', '☄', 'Collision', 'Choisir un projectile puis une cible (K)'],
  ['destroy', '✸', 'Détruire', 'Cliquer sur un astre pour le pulvériser (X)'],
];

/** Interface principale (DOM superposé au canevas 3D). */
export class UI {
  readonly root: HTMLElement;
  private top!: HTMLElement;
  private crumbs!: HTMLElement;
  private timeLabel!: HTMLElement;
  private speedLabel!: HTMLElement;
  private status!: HTMLElement;
  private toolbar!: HTMLElement;
  private toasts!: HTMLElement;
  private timeline!: HTMLElement;
  private timelineList!: HTMLElement;
  readonly props: PropertiesPanel;
  readonly panels: Panels;
  private menu: HTMLElement | null = null;
  private pauseBtn!: HTMLButtonElement;
  private camBtn!: HTMLButtonElement;
  private analysisBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private lastStatus = 0;
  private hud!: HTMLElement;

  toggleFlight(): void {
    const g = this.game;
    const rig = g.engine.rig;
    if (g.surface) g.ow.leaveSurface();
    rig.mode = rig.mode === 'free' ? 'orbit' : 'free';
    this.toast(rig.mode === 'free' ? 'Vol libre : ZQSD/WASD pour avancer, glisser pour regarder, E/C monter/descendre, Maj accélère, molette = vitesse. Volez jusqu\'aux étoiles et aux galaxies : l\'univers se génère autour de vous.' : 'Caméra orbitale.', 'info');
    g.audio.play('click');
  }

  toggleLanding(): void {
    const g = this.game;
    if (g.surface) { g.ow.leaveSurface(); return; }
    if (g.level !== 'system' && g.level !== 'planet') { this.toast('Rejoignez d\'abord un système stellaire et sélectionnez une planète.', 'warn'); return; }
    let b = g.selectedBody();
    if (!b?.planet || b.planet.gasGiant) {
      // planète solide la plus proche de la caméra
      const e = g.engine.rig.eye;
      b = [...g.world.bodies].filter((x) => x.planet && !x.planet.gasGiant).sort((p, q) => Math.hypot(p.pos.x - e.x, p.pos.y - e.y, p.pos.z - e.z) - Math.hypot(q.pos.x - e.x, q.pos.y - e.y, q.pos.z - e.z))[0];
    }
    if (b) g.ow.land(b.id);
  }

  constructor(private game: Game, parent: HTMLElement) {
    this.root = h('div', { id: 'ui' });
    parent.appendChild(this.root);
    this.buildTop();
    this.buildToolbar();
    this.toasts = h('div', { class: 'toasts' });
    this.root.appendChild(this.toasts);
    this.buildTimeline();
    this.hud = h('div', { class: 'hud', 'data-testid': 'hud' });
    this.root.appendChild(this.hud);
    this.props = new PropertiesPanel(game, this.root);
    this.panels = new Panels(game, this.root, this);
    game.bus.on('toast', (t) => this.toast(t.text, t.kind));
    game.bus.on('level', () => this.updateCrumbs());
    game.bus.on('tool', () => this.updateToolbar());
    game.bus.on('simevent', (e) => this.addTimeline(e.t, e.message, e.type));
    game.bus.on('history', () => this.updateHistoryButtons());
    game.bus.on('frame', () => this.tick());
    this.bindKeys();
    this.updateCrumbs();
    this.updateToolbar();
  }

  // -------------------------------------------------------------------------

  private buildTop(): void {
    const g = this.game;
    this.crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Échelles' });
    this.timeLabel = h('div', { class: 'simtime', 'data-testid': 'simtime' }, '—');
    this.speedLabel = h('div', { class: 'speed' }, '—');
    this.pauseBtn = button('❚❚', () => { g.togglePause(); this.updatePause(); }, 'icon', 'Pause / lecture (Espace)', 'pause');
    this.status = h('div', { class: 'status' });
    this.undoBtn = button('↶', () => g.undo(), 'icon', 'Annuler (Ctrl+Z)', 'undo');
    this.redoBtn = button('↷', () => g.redo(), 'icon', 'Rétablir (Ctrl+Y)', 'redo');
    this.top = h('header', { class: 'topbar' },
      h('div', { class: 'brand', onclick: () => this.showMenu() }, h('b', null, 'SUPERESSENCE'), h('small', null, 'GOD OF THE COSMOS')),
      this.crumbs,
      h('div', { class: 'timectl' },
        button('«', () => g.changeSpeed(-1), 'icon', 'Ralentir le temps ( [ )', 'slower'),
        this.pauseBtn,
        button('»', () => g.changeSpeed(1), 'icon', 'Accélérer le temps ( ] )', 'faster'),
        h('div', { class: 'timeinfo' }, this.timeLabel, this.speedLabel),
      ),
      h('div', { class: 'actions' },
        this.undoBtn, this.redoBtn,
        button('⚑', () => g.checkpoint(), 'icon', 'Point de restauration rapide', 'checkpoint'),
        button('💾', () => this.panels.open('saves'), 'icon', 'Sauvegardes (Ctrl+S)', 'open-saves'),
        button('⚙', () => this.panels.open('settings'), 'icon', 'Options', 'open-settings'),
        button('?', () => this.panels.open('help'), 'icon', 'Aide et notes scientifiques (F1)', 'open-help'),
      ),
      this.status,
    );
    this.root.appendChild(this.top);
  }

  private buildToolbar(): void {
    const g = this.game;
    this.toolbar = h('aside', { class: 'toolbar' });
    for (const [t, icon, label, tip] of TOOLS) {
      this.toolbar.appendChild(h('button', { class: 'tool', 'data-tool': t, title: tip, onclick: () => { g.setTool(t); if (t === 'create') this.panels.open('create'); }, 'data-testid': `tool-${t}` }, h('i', null, icon), h('span', null, label)));
    }
    this.toolbar.appendChild(h('hr'));
    const pw = (icon: string, label: string, tip: string, fn: () => void, testid: string) =>
      h('button', { class: 'tool power', title: tip, onclick: fn, 'data-testid': testid }, h('i', null, icon), h('span', null, label));
    this.toolbar.appendChild(pw('◎', 'Catalogue', 'Catalogue des objets cosmiques et création', () => this.panels.open('create'), 'open-create'));
    this.analysisBtn = pw('◈', 'Analyse', 'Mode analyse : champs, trajectoires, matière noire (A)', () => this.toggleAnalysis(), 'toggle-analysis') as HTMLButtonElement;
    this.toolbar.appendChild(this.analysisBtn);
    this.camBtn = pw('◉', 'Caméra', 'Changer de mode de caméra (V)', () => this.cycleCamera(), 'camera-mode') as HTMLButtonElement;
    this.toolbar.appendChild(this.camBtn);
    this.toolbar.appendChild(pw('➤', 'Vol libre', 'Voler librement à travers l\'univers (G) — ZQSD/WASD, molette = vitesse', () => this.toggleFlight(), 'toggle-flight'));
    this.toolbar.appendChild(pw('⛰', 'Atterrir', 'Se poser sur la planète sélectionnée / décoller (L)', () => this.toggleLanding(), 'toggle-land'));
    this.toolbar.appendChild(pw('▦', 'Carte', 'Carte de l\'univers (Tab)', () => this.panels.open('map'), 'open-map'));
    this.toolbar.appendChild(pw('✺', 'Big Bang', 'Laboratoire cosmologique : créer un univers', () => { void g.goBigBang(); }, 'open-bigbang'));
    this.toolbar.appendChild(pw('⌬', 'Cosmologie', 'Paramètres cosmologiques et fins d\'univers', () => this.panels.open('cosmo'), 'open-cosmo'));
    this.toolbar.appendChild(pw('☰', 'Historique', 'Historique des actions', () => this.panels.open('history'), 'open-history'));
    this.toolbar.appendChild(pw('⇄', 'Comparer', 'Comparer deux états de l\'univers', () => this.panels.open('compare'), 'open-compare'));
    this.root.appendChild(this.toolbar);
  }

  private buildTimeline(): void {
    this.timelineList = h('ol', { class: 'tl-list' });
    this.timeline = h('section', { class: 'timeline collapsed', 'data-testid': 'timeline' },
      h('header', { onclick: () => this.timeline.classList.toggle('collapsed') }, h('b', null, 'Chronologie'), h('span', { class: 'tl-count' }, '')),
      this.timelineList,
    );
    this.root.appendChild(this.timeline);
  }

  private addTimeline(t: number, msg: string, type: string): void {
    const li = h('li', { class: `tl-${type}` }, h('time', null, this.game.level === 'micro' || this.game.level === 'atomic' ? `${t.toFixed(1)} s` : fmtYears(t)), h('span', null, msg));
    this.timelineList.prepend(li);
    while (this.timelineList.children.length > 200) this.timelineList.lastChild?.remove();
    const c = this.timeline.querySelector('.tl-count')!;
    c.textContent = `${this.timelineList.children.length} évènements`;
  }

  private updateCrumbs(): void {
    const g = this.game;
    clear(this.crumbs);
    const levels: ScaleLevel[] = ['subatomic', 'atomic', 'micro', 'planet', 'system', 'galaxy', 'cosmic'];
    for (const l of levels) {
      const cur = g.level === l || (g.level === 'bigbang' && false);
      this.crumbs.appendChild(h('button', { class: `crumb${cur ? ' on' : ''}`, onclick: () => { void g.jumpToLevel(l); }, 'data-testid': `level-${l}` }, LEVEL_LABEL[l]));
    }
    this.crumbs.appendChild(h('button', { class: `crumb bb${g.level === 'bigbang' ? ' on' : ''}`, onclick: () => { void g.goBigBang(); }, 'data-testid': 'level-bigbang' }, 'Big Bang'));
    document.body.dataset.level = g.level;
  }

  private updateToolbar(): void {
    for (const b of this.toolbar.querySelectorAll<HTMLElement>('[data-tool]')) b.classList.toggle('on', b.dataset.tool === this.game.tool);
    document.body.dataset.tool = this.game.tool;
  }

  private updatePause(): void {
    this.pauseBtn.textContent = this.game.paused ? '▶' : '❚❚';
    this.pauseBtn.classList.toggle('on', this.game.paused);
  }

  private updateHistoryButtons(): void {
    this.undoBtn.disabled = !this.game.history.canUndo();
    this.redoBtn.disabled = !this.game.history.canRedo();
  }

  toggleAnalysis(): void {
    this.game.analysis = !this.game.analysis;
    this.analysisBtn.classList.toggle('on', this.game.analysis);
    if (this.game.analysis) this.panels.open('analysis');
    else this.panels.close('analysis');
    this.game.audio.play('click');
  }

  cycleCamera(): void {
    const order: CameraMode[] = ['orbit', 'follow', 'free', 'cinematic'];
    const rig = this.game.engine.rig;
    rig.mode = order[(order.indexOf(rig.mode) + 1) % order.length];
    this.toast(`Caméra : ${CAMERA_MODE_LABEL[rig.mode]}${rig.mode === 'free' ? ' — ZQSD/WASD pour voler, E/C monter/descendre, Maj accélère' : ''}`, 'info');
    this.game.audio.play('click');
  }

  toast(text: string, kind: string = 'info'): void {
    const el = h('div', { class: `toast t-${kind}` }, text);
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 5) this.toasts.firstChild?.remove();
    setTimeout(() => el.classList.add('out'), kind === 'error' ? 6500 : 5200);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 5800);
  }

  private tick(): void {
    const g = this.game;
    const now = performance.now();
    if (now - this.lastStatus < 200) return;
    this.lastStatus = now;
    const k = g.timeKey();
    const steps = TIME_STEPS[k];
    const sp = g.timeSpeed();
    let t = '';
    let s = '';
    if (k === 'system') {
      t = `T + ${fmtYears(g.world.time)}`;
      const r = g.world.lastReport;
      const eff = r.requested > 0 ? r.achieved / r.requested : 1;
      s = `${fmtYears(sp)} / s${eff < 0.95 && !g.paused ? ` (effectif ${Math.round(eff * 100)} %)` : ''} · ${r.mode === 'kepler' ? 'Kepler séculaire' : 'N-corps'}`;
    } else if (k === 'galaxy') {
      t = `Galaxie : ${fmt(g.galaxy?.time ?? 0, 4)} Ma`;
      s = `${sp} Ma / s`;
    } else if (k === 'cosmic') {
      const a = g.scaleFactorNow();
      t = `Âge cosmique ${g.universe.cosmicTime.toFixed(3)} Ga · a = ${a.toPrecision(3)}`;
      s = `${sp} Ga / s`;
    } else if (k === 'micro') {
      t = `Labo : ${g.micro.time.toFixed(1)} s · ${fmt(g.micro.temperature, 3)} K`;
      s = `vitesse ×${sp}`;
    } else if (g.level === 'bigbang') {
      t = 'Laboratoire cosmologique';
      s = '';
    }
    if (steps) s += '';
    this.timeLabel.textContent = t;
    this.speedLabel.textContent = s;
    const st = g.engine.stats;
    this.status.textContent = `${Math.round(g.engine.fps)} i/s · ${st.calls} appels`;
    this.updatePause();
    this.camBtn.querySelector('span')!.textContent = CAMERA_MODE_LABEL[g.engine.rig.mode];
    this.updateHistoryButtons();
    const hd = g.ow.hud;
    const lines = [hd.mode, hd.speed && `Vitesse : ${hd.speed}`, hd.altitude && `Altitude : ${hd.altitude}`, hd.nearest && `Plus proche : ${hd.nearest}`].filter(Boolean);
    const html = lines.map((l) => `<div>${l}</div>`).join('');
    if (this.hud.innerHTML !== html) this.hud.innerHTML = html;
    this.hud.style.display = lines.length ? '' : 'none';
    this.props.tick();
    this.panels.tick();
  }

  private bindKeys(): void {
    const g = this.game;
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      if (!g.started) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z') { e.preventDefault(); g.undo(); }
        if (k === 'y') { e.preventDefault(); g.redo(); }
        if (k === 's') { e.preventDefault(); g.save(); }
        return;
      }
      if ((g.engine.rig.mode === 'free' || g.surface) && ['w', 'z', 'q', 'a', 's', 'd', 'e', 'c', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) return;
      switch (k) {
        case ' ': e.preventDefault(); g.togglePause(); break;
        case '[': g.changeSpeed(-1); break;
        case ']': g.changeSpeed(1); break;
        case 'a': this.toggleAnalysis(); break;
        case 'v': this.cycleCamera(); break;
        case 'f': if (g.selectionId) g.focus(g.selectionId); break;
        case 's': g.setTool('select'); break;
        case 'm': g.setTool('move'); break;
        case 'c': g.setTool('create'); this.panels.open('create'); break;
        case 'p': g.setTool('push'); break;
        case 'k': g.setTool('collide'); break;
        case 'x': g.setTool('destroy'); break;
        case 'tab': e.preventDefault(); this.panels.toggle('map'); break;
        case 'escape': this.panels.closeAll(); g.setTool('select'); g.select(null); break;
        case 'f1': e.preventDefault(); this.panels.open('help'); break;
        case 'h': document.body.classList.toggle('hide-ui'); break;
        case 'g': this.toggleFlight(); break;
        case 'l': this.toggleLanding(); break;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Menu principal
  // -------------------------------------------------------------------------

  showMenu(): void {
    if (this.menu) return;
    const g = this.game;
    const saves = g.store.list();
    const seedInput = h('input', { type: 'text', value: String(Math.floor(Math.random() * 1e6)), 'data-testid': 'menu-seed' }) as HTMLInputElement;
    const nameInput = h('input', { type: 'text', value: 'Mon univers', 'data-testid': 'menu-name' }) as HTMLInputElement;
    const start = () => { this.closeMenu(); g.started = true; g.audio.start(); };
    this.menu = h('div', { class: 'mainmenu', 'data-testid': 'main-menu' },
      h('div', { class: 'menu-inner' },
        h('h1', null, 'SUPERESSENCE'),
        h('h2', null, 'GOD OF THE COSMOS'),
        h('p', { class: 'tagline' }, 'Créez, comprenez, transformez et détruisez l\'univers — de la particule aux galaxies.'),
        h('div', { class: 'menu-buttons' },
          g.started ? button('Reprendre', () => start(), 'primary', undefined, 'menu-resume') : null,
          button('Explorer le Système solaire', () => { g.newUniverse(nameInput.value || 'Mon univers', Game.seedFrom(seedInput.value), true); start(); g.toast('Bienvenue, divinité. Molette : zoom · glisser : orbite · double-clic : rejoindre un astre.', 'info'); }, 'primary', undefined, 'menu-new'),
          button('Création d\'un univers (Big Bang)', () => { start(); void g.goBigBang(); }, '', undefined, 'menu-bigbang'),
          saves.length ? button(`Continuer « ${saves[0].name} »`, () => { if (g.load(saves[0].id)) start(); }, '', undefined, 'menu-continue') : null,
          button('Charger / gérer les univers', () => { start(); this.panels.open('saves'); }, '', undefined, 'menu-load'),
          button('Options', () => { start(); this.panels.open('settings'); }),
          button('Notes scientifiques & commandes', () => { start(); this.panels.open('help'); }),
        ),
        h('div', { class: 'menu-new' }, h('label', null, 'Nom ', nameInput), h('label', null, 'Graine ', seedInput)),
        h('p', { class: 'disclaimer' }, 'Simulation éducative : les phénomènes sont étiquetés « science établie », « approximation » ou « pouvoir divin ». Le son est une mise en scène : il ne se propage pas dans le vide.'),
      ),
    );
    this.root.appendChild(this.menu);
    document.body.classList.add('menu-open');
    g.engine.rig.mode = 'cinematic';
  }

  closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    document.body.classList.remove('menu-open');
    if (this.game.engine.rig.mode === 'cinematic' && this.game.level !== 'bigbang') this.game.engine.rig.mode = 'orbit';
  }
}
