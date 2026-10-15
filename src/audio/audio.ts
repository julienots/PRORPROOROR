/**
 * Ambiance sonore procédurale (Web Audio API), sans fichier audio.
 * Le son ne se propage pas dans le vide : tout ce qui est entendu est une mise en
 * scène destinée au joueur (bourdon cosmique, musique adaptative, effets stylisés).
 */
export type Mood = 'calm' | 'creation' | 'destruction' | 'cosmic' | 'micro';
export type Sfx = 'click' | 'hover' | 'create' | 'confirm' | 'error' | 'impact' | 'explosion' | 'supernova' | 'chirp' | 'whoosh' | 'bigbang' | 'bond';

export interface AudioSettings { master: number; music: number; sfx: number; ambience: number; muted: boolean }

const SCALES: Record<Mood, number[]> = {
  calm: [0, 2, 4, 7, 9],
  creation: [0, 2, 4, 6, 7, 11],
  destruction: [0, 1, 3, 6, 7, 10],
  cosmic: [0, 3, 5, 7, 10],
  micro: [0, 2, 3, 7, 8],
};

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  private sfx!: GainNode;
  private amb!: GainNode;
  private reverb!: ConvolverNode;
  private droneOsc: OscillatorNode[] = [];
  private droneFilter!: BiquadFilterNode;
  private noiseBuf!: AudioBuffer;
  settings: AudioSettings = { master: 0.7, music: 0.45, sfx: 0.7, ambience: 0.5, muted: false };
  mood: Mood = 'calm';
  private moodHold = 0;
  private nextNote = 0;
  private step = 0;
  private timer: number | null = null;
  private root = 45; // la1

  /** L'audio ne peut démarrer qu'après une interaction de l'utilisateur. */
  start(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.music = ctx.createGain();
    this.sfx = ctx.createGain();
    this.amb = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    this.reverb.connect(wet).connect(this.master);
    for (const g of [this.music, this.sfx, this.amb]) { g.connect(this.master); g.connect(this.reverb); }
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.applySettings();
    this.startDrone();
    this.nextNote = ctx.currentTime + 0.5;
    this.timer = window.setInterval(() => this.schedule(), 100);
  }

  applySettings(): void {
    if (!this.ctx) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.1);
    this.music.gain.setTargetAtTime(s.music * 0.5, t, 0.1);
    this.sfx.gain.setTargetAtTime(s.sfx, t, 0.1);
    this.amb.gain.setTargetAtTime(s.ambience * 0.35, t, 0.1);
  }

  private impulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  private startDrone(): void {
    const ctx = this.ctx!;
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 400;
    this.droneFilter.Q.value = 2;
    this.droneFilter.connect(this.amb);
    const freqs = [55, 55.4, 82.5, 110.3];
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = f > 100 ? 'sine' : 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = f > 100 ? 0.06 : 0.04;
      o.connect(g).connect(this.droneFilter);
      o.start();
      this.droneOsc.push(o);
    }
    // souffle filtré lent (« vent stellaire » stylisé)
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 300;
    bp.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lg = ctx.createGain();
    lg.gain.value = 200;
    lfo.connect(lg).connect(bp.frequency);
    lfo.start();
    n.connect(bp).connect(ng).connect(this.amb);
    n.start();
  }

  /** Change la tonalité d'ambiance (échelle de jeu, intensité). */
  setMood(m: Mood, holdSeconds = 0): void {
    if (holdSeconds > 0) this.moodHold = holdSeconds;
    else if (this.moodHold > 0) return;
    if (this.mood === m) return;
    this.mood = m;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const cutoff = m === 'destruction' ? 900 : m === 'creation' ? 700 : m === 'cosmic' ? 250 : m === 'micro' ? 1200 : 400;
    this.droneFilter.frequency.setTargetAtTime(cutoff, t, 1.5);
    const base = m === 'cosmic' ? 41.2 : m === 'micro' ? 73.4 : 55;
    this.droneOsc.forEach((o, i) => o.frequency.setTargetAtTime(base * [1, 1.007, 1.5, 2.005][i], t, 2));
  }

  tick(dt: number): void {
    if (this.moodHold > 0) this.moodHold -= dt;
  }

  /** Séquenceur génératif (arpèges et nappes selon l'humeur). */
  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const tempo = this.mood === 'destruction' ? 0.18 : this.mood === 'creation' ? 0.24 : 0.42;
    while (this.nextNote < ctx.currentTime + 0.3) {
      const scale = SCALES[this.mood];
      const s = this.step++;
      if (s % 2 === 0 || Math.random() < 0.3) {
        const deg = scale[(s * 3 + Math.floor(Math.random() * 3)) % scale.length];
        const oct = s % 16 < 8 ? 12 : 24;
        this.note(this.root + deg + oct, this.nextNote, tempo * 3, 0.08, this.mood === 'destruction' ? 'sawtooth' : 'triangle');
      }
      if (s % 16 === 0) {
        // nappe
        for (const d of [0, 7, scale[2] ?? 4]) this.note(this.root + d, this.nextNote, tempo * 16, 0.05, 'sine');
      }
      if (this.mood === 'destruction' && s % 4 === 0) this.note(this.root - 12, this.nextNote, tempo, 0.12, 'square');
      this.nextNote += tempo;
    }
  }

  private note(midi: number, t: number, dur: number, vol: number, type: OscillatorType): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.08, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1800;
    o.connect(f).connect(g).connect(this.music);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  play(s: Sfx, intensity = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const out = this.sfx;
    const tone = (f0: number, f1: number, dur: number, vol: number, type: OscillatorType = 'sine', delay = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t + delay);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + delay + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(vol, t + delay + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(g).connect(out);
      o.start(t + delay);
      o.stop(t + delay + dur + 0.05);
    };
    const noise = (dur: number, vol: number, f0: number, f1: number) => {
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(f).connect(g).connect(out);
      n.start(t);
      n.stop(t + dur);
    };
    const k = Math.min(2, Math.max(0.3, intensity));
    switch (s) {
      case 'click': tone(900, 600, 0.06, 0.08, 'sine'); break;
      case 'hover': tone(1400, 1300, 0.03, 0.02, 'sine'); break;
      case 'confirm': tone(660, 660, 0.12, 0.08, 'triangle'); tone(990, 990, 0.18, 0.08, 'triangle', 0.09); break;
      case 'error': tone(220, 160, 0.25, 0.1, 'square'); break;
      case 'create': tone(200, 1200, 0.6, 0.12, 'sine'); tone(300, 1800, 0.6, 0.05, 'triangle', 0.05); noise(0.5, 0.05, 3000, 8000); break;
      case 'whoosh': noise(0.8, 0.12, 400, 3000); break;
      case 'impact': noise(0.6 * k, 0.4 * k, 1200, 60); tone(90, 30, 0.7, 0.3 * k); break;
      case 'explosion': noise(1.8 * k, 0.6 * k, 2500, 40); tone(70, 20, 2 * k, 0.5 * k); break;
      case 'supernova': noise(4, 0.7, 5000, 30); tone(60, 18, 4.5, 0.6); tone(880, 110, 3, 0.08, 'sawtooth', 0.1); break;
      case 'chirp': tone(35, 350, 3.5, 0.25, 'sine'); tone(70, 700, 3.5, 0.08, 'triangle'); tone(350, 250, 1.2, 0.2, 'sine', 3.5); break;
      case 'bigbang': noise(6, 0.6, 8000, 30); tone(30, 15, 6, 0.6); tone(2000, 80, 5, 0.06, 'sawtooth'); break;
      case 'bond': tone(500, 750, 0.15, 0.05, 'sine'); break;
    }
  }
}
