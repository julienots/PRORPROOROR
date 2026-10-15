import * as THREE from 'three';
import { blackbodyRGB } from '../../core/color';
import type { GalaxySim } from '../../sim/galaxy';
import { planeBasis } from '../../sim/galaxy';
import type { CosmicGalaxy } from '../../procgen/universe';
import { softTexture } from './common';

/** Une étoile voisine (pour les étiquettes et le voyage interstellaire). */
export interface Neighbor {
  idx: number;
  distLy: number;
  dir: THREE.Vector3; // direction unitaire (repère galactique = repère du système)
  mass: number;
}

const DIR_VERT = /* glsl */ `
attribute float size; attribute vec3 color; varying vec3 vCol; uniform float pixelRatio; uniform float intensity;
void main() {
  vCol = color * intensity;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
  gl_Position.z = gl_Position.w * 0.99997;
  gl_PointSize = size * pixelRatio;
}`;

const DIR_FRAG = /* glsl */ `
uniform sampler2D map; varying vec3 vCol;
void main() {
  float a = texture2D(map, gl_PointCoord).a;
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

function directionalPoints(n: number): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: 1 }, intensity: { value: 1 }, map: { value: softTexture() } },
    vertexShader: DIR_VERT, fragmentShader: DIR_FRAG,
    // test de profondeur : placées au plan lointain, elles passent derrière le sol et les astres
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: true,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = -8;
  return p;
}

/**
 * Ciel réel vu depuis une étoile de la galaxie simulée : chaque étoile-traceur de la
 * galaxie est projetée à l'infini dans sa vraie direction, avec un éclat ∝ L/d².
 * La bande de la Voie lactée et les étoiles voisines sont donc cohérentes avec la vue
 * galactique (même géométrie), ce qui rend le passage d'échelle continu.
 */
export class GalacticSky {
  readonly group = new THREE.Group();
  private stars = directionalPoints(1);
  private galaxies = directionalPoints(1);
  neighbors: Neighbor[] = [];
  /** Direction du centre galactique (repère local). */
  centerDir = new THREE.Vector3(1, 0, 0);
  key = '';

  constructor() {
    this.group.add(this.stars, this.galaxies);
    this.group.renderOrder = -9;
  }

  /** Reconstruit le ciel depuis l'étoile `idx` (ou depuis un point quelconque `origin`, en kal). */
  build(sim: GalaxySim, idx: number, origin?: THREE.Vector3): void {
    const n = sim.n;
    const ox = origin ? origin.x : sim.pos[idx * 3], oy = origin ? origin.y : sim.pos[idx * 3 + 1], oz = origin ? origin.z : sim.pos[idx * 3 + 2];
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const near: Neighbor[] = [];
    let k = 0;
    for (let j = 0; j < n; j++) {
      if (j === idx) continue;
      const dx = sim.pos[j * 3] - ox, dy = sim.pos[j * 3 + 1] - oy, dz = sim.pos[j * 3 + 2] - oz;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-9) continue;
      const ly = d * 1000;
      pos[k * 3] = dx / d; pos[k * 3 + 1] = dy / d; pos[k * 3 + 2] = dz / d;
      const m = sim.starMass[j];
      const young = sim.age[j] < 0.25;
      // chaque traceur représente une population : éclat intégré ∝ L / d²
      const lum = Math.pow(Math.max(m, 0.1), 2.5) * (young ? 6 : 1);
      const I = lum / (ly * ly);
      const mag = Math.log10(I + 1e-12); // ~ −8 (loin) … 0 (proche)
      const [r, g, b] = blackbodyRGB(young ? 12000 : 3800 + m * 1500);
      const br = Math.min(3, Math.max(0.12, 0.35 + (mag + 7) * 0.35));
      col[k * 3] = r * br; col[k * 3 + 1] = g * br; col[k * 3 + 2] = b * br;
      size[k] = Math.min(9, Math.max(1.6, 2 + (mag + 6) * 1.1));
      if (ly < 3000) near.push({ idx: j, distLy: ly, dir: new THREE.Vector3(dx / d, dy / d, dz / d), mass: m });
      k++;
    }
    this.replace(this.stars, pos, col, size, k);
    near.sort((a, b) => a.distLy - b.distLy);
    this.neighbors = near.slice(0, 14);
    const c = new THREE.Vector3(-ox, -oy, -oz);
    if (c.lengthSq() > 0) this.centerDir.copy(c.normalize());
  }

  /** Galaxies voisines vues depuis la galaxie courante (repère local du disque). */
  buildGalaxies(home: CosmicGalaxy, others: CosmicGalaxy[]): void {
    const basis = planeBasis({ x: home.nx, y: home.ny, z: home.nz });
    const n = others.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    let k = 0;
    for (const o of others) {
      if (o.id === home.id) continue;
      const dx = o.x - home.x, dy = o.y - home.y, dz = o.z - home.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-6) continue;
      // repère cosmique → repère local de la galaxie (e1, n, e2)
      const lx = (dx * basis.e1.x + dy * basis.e1.y + dz * basis.e1.z) / d;
      const ly = (dx * basis.n.x + dy * basis.n.y + dz * basis.n.z) / d;
      const lz = (dx * basis.e2.x + dy * basis.e2.y + dz * basis.e2.z) / d;
      pos[k * 3] = lx; pos[k * 3 + 1] = ly; pos[k * 3 + 2] = lz;
      const ang = o.size / d; // rad
      const ell = o.type === 'elliptical' || o.type === 'lenticular';
      const br = Math.min(1.2, 0.15 + ang * 60);
      col[k * 3] = (ell ? 1 : 0.75) * br; col[k * 3 + 1] = (ell ? 0.85 : 0.8) * br; col[k * 3 + 2] = (ell ? 0.65 : 1) * br;
      size[k] = Math.min(40, Math.max(2, ang * 900));
      k++;
    }
    this.replace(this.galaxies, pos, col, size, k);
  }

  private replace(p: THREE.Points, pos: Float32Array, col: Float32Array, size: Float32Array, n: number): void {
    p.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, n * 3), 3));
    g.setAttribute('size', new THREE.BufferAttribute(size.subarray(0, n), 1));
    p.geometry = g;
  }

  setPixelRatio(pr: number): void {
    for (const p of [this.stars, this.galaxies]) (p.material as THREE.ShaderMaterial).uniforms.pixelRatio.value = pr;
  }

  set intensity(v: number) {
    for (const p of [this.stars, this.galaxies]) (p.material as THREE.ShaderMaterial).uniforms.intensity.value = v;
  }
}
