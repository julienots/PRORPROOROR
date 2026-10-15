import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { LENSING_FRAG, FULLSCREEN_VERT, MAX_LENSES, MAX_RIPPLES } from './shaders/lensing';
import { CameraRig } from '../camera/rig';

export type QualityPreset = 'performance' | 'equilibre' | 'qualite';

export interface GraphicsSettings {
  preset: QualityPreset;
  pixelRatio: number;
  bloom: boolean;
  bloomStrength: number;
  lensing: boolean;
  lensSteps: number;
  volumetricSteps: number;
  particleBudget: number;
  terrainDetail: number; // segments max par face
  eclipseShadows: boolean;
  galaxyStars: number;
  bigBangGrid: number;
  labels: boolean;
}

export const PRESETS: Record<QualityPreset, Omit<GraphicsSettings, 'preset'>> = {
  performance: { pixelRatio: 0.75, bloom: true, bloomStrength: 0.7, lensing: true, lensSteps: 90, volumetricSteps: 24, particleBudget: 15000, terrainDetail: 64, eclipseShadows: false, galaxyStars: 20000, bigBangGrid: 32, labels: true },
  equilibre: { pixelRatio: 1, bloom: true, bloomStrength: 0.9, lensing: true, lensSteps: 160, volumetricSteps: 48, particleBudget: 30000, terrainDetail: 128, eclipseShadows: true, galaxyStars: 40000, bigBangGrid: 48, labels: true },
  qualite: { pixelRatio: 1.5, bloom: true, bloomStrength: 1.0, lensing: true, lensSteps: 280, volumetricSteps: 80, particleBudget: 40000, terrainDetail: 192, eclipseShadows: true, galaxyStars: 80000, bigBangGrid: 64, labels: true },
};

export interface LensSpec {
  /** Position dans le repère de vue de la caméra (relative à l'œil, unités de la scène). */
  viewPos: THREE.Vector3;
  rs: number; // rayon de Schwarzschild (unités de la scène)
  axis: THREE.Vector3; // axe (repère vue)
  rin: number; rout: number; // en Rs
  brightness: number;
  temperature: number;
}

export interface RippleSpec { x: number; y: number; radius: number; amp: number }

/**
 * Moteur de rendu : WebGL2, tampon de profondeur logarithmique, post-traitement
 * (lentille gravitationnelle → bloom → tonemapping ACES).
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly rig: CameraRig;
  composer: EffectComposer;
  private renderPass: RenderPass;
  private lensPass: ShaderPass;
  private bloomPass: UnrealBloomPass;
  private target: THREE.WebGLRenderTarget;
  settings: GraphicsSettings;
  lenses: LensSpec[] = [];
  ripples: RippleSpec[] = [];
  readonly canvas: HTMLCanvasElement;
  private scene: THREE.Scene = new THREE.Scene();
  fps = 60;
  private frameTimes: number[] = [];
  /** Statistiques de rendu pour le panneau de diagnostic. */
  stats = { calls: 0, triangles: 0, points: 0 };

  constructor(container: HTMLElement, settings: GraphicsSettings) {
    this.settings = settings;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'scene';
    container.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const w = container.clientWidth || window.innerWidth, h = container.clientHeight || window.innerHeight;
    this.rig = new CameraRig(w / h);
    this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    this.target.depthTexture = new THREE.DepthTexture(w, h);
    this.target.depthTexture.type = THREE.FloatType;
    this.composer = new EffectComposer(this.renderer, this.target);
    this.renderPass = new RenderPass(this.scene, this.rig.camera);
    this.composer.addPass(this.renderPass);
    const uniforms: Record<string, THREE.IUniform> = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      lensCount: { value: 0 },
      lensPos: { value: Array.from({ length: MAX_LENSES }, () => new THREE.Vector3()) },
      lensRs: { value: new Array(MAX_LENSES).fill(1) },
      lensAxis: { value: Array.from({ length: MAX_LENSES }, () => new THREE.Vector3(0, 1, 0)) },
      lensRin: { value: new Array(MAX_LENSES).fill(3) },
      lensRout: { value: new Array(MAX_LENSES).fill(15) },
      lensBright: { value: new Array(MAX_LENSES).fill(1) },
      lensTemp: { value: new Array(MAX_LENSES).fill(8000) },
      rippleCount: { value: 0 },
      ripples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4()) },
      projInv: { value: new THREE.Matrix4() },
      proj: { value: new THREE.Matrix4() },
      time: { value: 0 },
      logDepthFar: { value: 1 },
      steps: { value: settings.lensSteps },
      aspect: { value: w / h },
    };
    this.lensPass = new ShaderPass(new THREE.ShaderMaterial({ uniforms, vertexShader: FULLSCREEN_VERT, fragmentShader: LENSING_FRAG, depthTest: false, depthWrite: false }));
    this.composer.addPass(this.lensPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), settings.bloomStrength, 0.6, 0.82);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.applySettings(settings);
    window.addEventListener('resize', () => this.resize());
    this.rig.attach(this.canvas);
  }

  applySettings(s: GraphicsSettings): void {
    this.settings = s;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * s.pixelRatio);
    this.bloomPass.enabled = s.bloom;
    this.bloomPass.strength = s.bloomStrength;
    this.lensPass.uniforms.steps.value = s.lensSteps;
    this.resize();
  }

  resize(): void {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth || window.innerWidth, h = parent.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.rig.setAspect(w / h);
    this.lensPass.uniforms.aspect.value = w / h;
  }

  get width(): number { return this.canvas.clientWidth || window.innerWidth; }
  get height(): number { return this.canvas.clientHeight || window.innerHeight; }

  render(scene: THREE.Scene, dt: number): void {
    this.scene = scene;
    this.renderPass.scene = scene;
    const cam = this.rig.camera;
    cam.updateMatrixWorld();
    const u = this.lensPass.uniforms;
    const active = this.settings.lensing ? this.lenses.slice(0, MAX_LENSES) : [];
    u.lensCount.value = active.length;
    active.forEach((l, i) => {
      (u.lensPos.value as THREE.Vector3[])[i].copy(l.viewPos);
      u.lensRs.value[i] = l.rs;
      (u.lensAxis.value as THREE.Vector3[])[i].copy(l.axis);
      u.lensRin.value[i] = l.rin;
      u.lensRout.value[i] = l.rout;
      u.lensBright.value[i] = l.brightness;
      u.lensTemp.value[i] = l.temperature;
    });
    const rip = this.ripples.slice(0, MAX_RIPPLES);
    u.rippleCount.value = rip.length;
    rip.forEach((r, i) => (u.ripples.value as THREE.Vector4[])[i].set(r.x, r.y, r.radius, r.amp));
    u.projInv.value.copy(cam.projectionMatrixInverse);
    u.proj.value.copy(cam.projectionMatrix);
    u.time.value += dt;
    u.logDepthFar.value = Math.log2(cam.far + 1);
    u.tDepth.value = this.composer.readBuffer.depthTexture;
    this.lensPass.enabled = active.length > 0 || rip.length > 0;
    this.composer.render(dt);
    const info = this.renderer.info.render;
    this.stats.calls = info.calls;
    this.stats.triangles = info.triangles;
    this.stats.points = info.points;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = avg > 0 ? 1 / avg : 60;
  }

  /** Projette un point (repère vue relatif à l'œil) en coordonnées écran [0..1]. */
  toScreen(rel: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = rel.clone().applyMatrix4(this.rig.camera.matrixWorldInverse);
    const visible = v.z < 0;
    v.applyMatrix4(this.rig.camera.projectionMatrix);
    return { x: (v.x + 1) / 2, y: (1 - v.y) / 2, visible };
  }

  /** Transforme un vecteur relatif (monde) en repère vue (pour la passe de lentille). */
  toView(rel: THREE.Vector3): THREE.Vector3 {
    return rel.clone().applyMatrix4(this.rig.camera.matrixWorldInverse);
  }

  toViewDir(dir: THREE.Vector3): THREE.Vector3 {
    return dir.clone().transformDirection(this.rig.camera.matrixWorldInverse);
  }
}
