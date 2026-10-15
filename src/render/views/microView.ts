import * as THREE from 'three';
import { clamp } from '../../core/units';
import { Rng } from '../../core/rng';
import type { Vec3 } from '../../core/vec';
import type { Body } from '../../sim/types';
import { MicroLab, LAB_SIZE, type MicroEntity } from '../../sim/micro';
import { ELEMENT_BY_Z } from '../../sim/elements';
import { glowTexture, ringTexture, LOGDEPTH_FRAG_HEAD, LOGDEPTH_FRAG_MAIN, LOGDEPTH_VERT_HEAD, LOGDEPTH_VERT_MAIN } from '../objects/common';
import type { View, PickResult } from './view';
import type { Game } from '../../game';
import type { ScaleLevel } from '../../save/serialize';

const MAX_SPH = 6000;

/** Nuage électronique (densité de probabilité stylisée, fresnel). */
function cloudMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      attribute vec3 instColor;
      varying vec3 vN; varying vec3 vW; varying vec3 vC;
      void main() {
        vC = instColor;
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = w.xyz; vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_VERT_MAIN}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      varying vec3 vN; varying vec3 vW; varying vec3 vC;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        float mu = abs(dot(normalize(vN), normalize(-vW)));
        float a = pow(mu, 2.0) * 0.25 + pow(1.0 - mu, 4.0) * 0.15;
        gl_FragColor = vec4(vC * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
}

/**
 * Vue microscopique : laboratoire de particules, atomes et molécules.
 * Sous-niveaux : microscopique (grains, µm) ↔ atomique (Å) ↔ subatomique (fm).
 */
export class MicroView implements View {
  readonly scene = new THREE.Scene();
  level: ScaleLevel = 'atomic';
  readonly renderScale = 1;
  source: Body | null = null;
  private nucleons: THREE.InstancedMesh;
  private electrons: THREE.InstancedMesh;
  private atoms: THREE.InstancedMesh;
  private clouds: THREE.InstancedMesh;
  private bonds: THREE.InstancedMesh;
  private photons: THREE.Points;
  private photonPos = new Float32Array(3000 * 3);
  private box: THREE.LineSegments;
  private grains: THREE.InstancedMesh;
  private detail = new THREE.Group();
  private sel: THREE.Sprite;
  private cloudColor: THREE.InstancedBufferAttribute;
  sub: 'micro' | 'atomic' | 'subatomic' = 'atomic';
  selectedEntity: number | null = null;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  private tmpP = new THREE.Vector3();
  private col = new THREE.Color();

  constructor(private game: Game) {
    this.scene.background = new THREE.Color(0x03070d);
    const sph = new THREE.SphereGeometry(1, 20, 14);
    const std = (c: number, e = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.1, emissive: e });
    this.nucleons = new THREE.InstancedMesh(sph, new THREE.MeshStandardMaterial({ roughness: 0.4 }), MAX_SPH);
    this.electrons = new THREE.InstancedMesh(sph, new THREE.MeshBasicMaterial({ color: 0x66bbff }), MAX_SPH);
    this.atoms = new THREE.InstancedMesh(sph, std(0xffffff), MAX_SPH);
    const cgeo = new THREE.SphereGeometry(1, 24, 16);
    this.cloudColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPH * 3), 3);
    cgeo.setAttribute('instColor', this.cloudColor);
    this.clouds = new THREE.InstancedMesh(cgeo, cloudMaterial(), MAX_SPH);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 10);
    this.bonds = new THREE.InstancedMesh(cyl, std(0xcccccc), MAX_SPH);
    for (const m of [this.nucleons, this.electrons, this.atoms, this.clouds, this.bonds]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.photonPos, 3));
    this.photons = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xfff2a0, size: 4, sizeAttenuation: false, map: glowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.photons.frustumCulled = false;
    this.scene.add(this.photons);
    const h = LAB_SIZE / 2;
    this.box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(h * 2, h * 2, h * 2)), new THREE.LineBasicMaterial({ color: 0x2a6a9a, transparent: true, opacity: 0.5 }));
    this.scene.add(this.box);
    this.scene.add(new THREE.AmbientLight(0x6080a0, 0.6));
    const dl = new THREE.DirectionalLight(0xffffff, 2.2);
    dl.position.set(1, 2, 1.5);
    this.scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0x88aaff, 0.8);
    dl2.position.set(-2, -1, -1);
    this.scene.add(dl2);
    // grains microscopiques (cristaux / poussières) pour l'échelle du micromètre
    const rng = new Rng(5);
    this.grains = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x9a8a7a, roughness: 0.9, flatShading: true }), 400);
    for (let i = 0; i < 400; i++) {
      this.tmpP.set(rng.gauss(0, 15000), rng.gauss(0, 6000), rng.gauss(0, 15000));
      this.tmpQ.setFromEuler(new THREE.Euler(rng.range(0, 6), rng.range(0, 6), rng.range(0, 6)));
      const s = rng.logRange(600, 4000);
      this.tmpS.set(s, s * rng.range(0.5, 1.2), s * rng.range(0.6, 1.3));
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.grains.setMatrixAt(i, this.tmpM);
    }
    this.grains.visible = false;
    this.scene.add(this.grains);
    this.scene.add(this.detail);
    this.sel = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), depthTest: false, transparent: true }));
    this.sel.renderOrder = 20;
    this.scene.add(this.sel);
  }

  get lab(): MicroLab {
    return this.game.micro;
  }

  /** Remplit le laboratoire selon la composition du corps d'origine. */
  setSource(b: Body | null): void {
    this.source = b;
    const lab = this.lab;
    if (lab.entities.length > 0 && b === null) return;
    lab.clear();
    lab.setTemperature(b ? clamp(b.temperature, 10, 5000) : 300);
    const c = b?.composition;
    const recipe: [number, number][] = c
      ? [
        [14, Math.round(c.rock * 20)], [8, Math.round((c.rock + c.water + c.ice) * 30)], [26, Math.round(c.metal * 12)],
        [1, Math.round((c.water + c.ice + c.organic + c.hydrogen) * 40)], [6, Math.round(c.organic * 60 + c.ice * 6)],
        [7, Math.round(c.organic * 20 + 2)], [12, Math.round(c.rock * 6)], [2, Math.round(c.hydrogen * 10)],
      ]
      : [[1, 30], [8, 12], [6, 6], [7, 4]];
    for (const [Z, n] of recipe) for (let i = 0; i < Math.min(n, 60); i++) lab.spawnAtom(Z);
    if (lab.entities.length < 10) for (let i = 0; i < 20; i++) lab.spawnAtom(1);
  }

  enter(): void {
    const rig = this.game.engine.rig;
    rig.minDistance = 4;
    rig.maxDistance = 60000;
    rig.mode = 'orbit';
    rig.set({ x: 0, y: 0, z: 0 }, LAB_SIZE * 1.6);
    this.sub = 'atomic';
    this.level = 'atomic';
    this.selectedEntity = null;
  }

  exit(): void {
    this.game.labels.clear();
    this.detail.clear();
  }

  setSubLevel(l: ScaleLevel): void {
    const rig = this.game.engine.rig;
    if (l === 'micro') rig.flyTo({ x: 0, y: 0, z: 0 }, 30000, 1.5);
    else if (l === 'atomic') rig.flyTo({ x: 0, y: 0, z: 0 }, LAB_SIZE * 1.6, 1.5);
    else if (l === 'subatomic') {
      const e = this.lab.entities.find((x) => x.kind === 'cluster' && x.atoms!.length === 1) ?? this.lab.entities.find((x) => x.kind === 'p' || x.kind === 'n');
      if (e) { this.selectedEntity = e.id; rig.flyTo({ x: e.x, y: e.y, z: e.z }, 8, 1.5); this.game.select(`e${e.id}`); }
    }
  }

  zoomOut(): void {
    void this.game.leaveMicro();
  }

  zoomIn(): void {
    if (this.selectedEntity === null) this.setSubLevel('subatomic');
  }

  onClick(px: number, py: number, pick: PickResult | null): void {
    void px; void py;
    if (pick) {
      this.selectedEntity = Number(pick.id.slice(1));
      this.game.select(pick.id);
    } else {
      this.selectedEntity = null;
      this.game.select(null);
    }
  }

  private entityById(id: number): MicroEntity | undefined {
    return this.lab.entities.find((e) => e.id === id);
  }

  update(dt: number): void {
    const g = this.game;
    const rig = g.engine.rig;
    const eye = rig.eye;
    const lab = this.lab;
    // sous-niveau selon la distance
    const d = rig.distance;
    const newSub = d > 6000 ? 'micro' : d < 25 && this.selectedEntity !== null ? 'subatomic' : 'atomic';
    if (newSub !== this.sub) {
      this.sub = newSub;
      this.level = newSub;
      g.level = newSub;
      g.bus.emit('level', newSub);
      if (newSub === 'micro') g.toast('Échelle microscopique (≈ µm) : grains minéraux stylisés.', 'science');
      if (newSub === 'subatomic') g.toast('Échelle subatomique (≈ fm) : nucléons et quarks (représentation symbolique de la chromodynamique).', 'science');
    }
    const showLab = this.sub !== 'micro';
    this.grains.visible = this.sub === 'micro';
    this.grains.position.set(-eye.x, -eye.y, -eye.z);
    this.box.position.set(-eye.x, -eye.y, -eye.z);
    let nN = 0, nE = 0, nA = 0, nC = 0, nB = 0, nP = 0;
    const put = (m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, s: number, q?: THREE.Quaternion, sy?: number) => {
      this.tmpP.set(x - eye.x, y - eye.y, z - eye.z);
      this.tmpS.set(s, sy ?? s, s);
      this.tmpM.compose(this.tmpP, q ?? this.tmpQ.identity(), this.tmpS);
      m.setMatrixAt(i, this.tmpM);
    };
    if (showLab) {
      for (const e of lab.entities) {
        if (e.kind === 'photon') {
          if (nP < 3000) { this.photonPos[nP * 3] = e.x - eye.x; this.photonPos[nP * 3 + 1] = e.y - eye.y; this.photonPos[nP * 3 + 2] = e.z - eye.z; nP++; }
          continue;
        }
        if (e.kind === 'p' || e.kind === 'n') {
          if (nN >= MAX_SPH) continue;
          put(this.nucleons, nN, e.x, e.y, e.z, 2.2);
          this.nucleons.setColorAt(nN, this.col.set(e.kind === 'p' ? 0xff4a3a : 0xb0b8c0));
          nN++;
          continue;
        }
        if (e.kind === 'e') {
          if (nE < MAX_SPH) { put(this.electrons, nE, e.x, e.y, e.z, 1.0); nE++; }
          continue;
        }
        // clusters : noyau, nuage électronique, liaisons
        const atoms = e.atoms!;
        const spin = (e.spin ?? 0) * g.realTime;
        const cs = Math.cos(spin), sn = Math.sin(spin);
        const world = atoms.map((a) => ({ x: e.x + a.ox * cs - a.oz * sn, y: e.y + a.oy, z: e.z + a.ox * sn + a.oz * cs }));
        atoms.forEach((a, k) => {
          const w = world[k];
          const el = ELEMENT_BY_Z.get(a.Z);
          const A = a.Z + a.N;
          if (a.electrons === 0 || this.sub === 'subatomic') {
            // noyau nu : amas de nucléons
            const r = 1.4 * Math.cbrt(A);
            const rng = new Rng(A * 131 + a.Z);
            for (let n = 0; n < Math.min(A, 60); n++) {
              if (nN >= MAX_SPH) break;
              const [ux, uy, uz] = rng.onSphere();
              const rr = r * Math.cbrt(rng.next()) * 0.8;
              put(this.nucleons, nN, w.x + ux * rr, w.y + uy * rr, w.z + uz * rr, 1.25);
              this.nucleons.setColorAt(nN, this.col.set(n < a.Z ? 0xff4a3a : 0xb0b8c0));
              nN++;
            }
          } else if (nA < MAX_SPH) {
            // atome : sphère couleur CPK (rayon ~ covalent stylisé)
            const r = 4 + 2.2 * Math.cbrt(a.Z);
            put(this.atoms, nA, w.x, w.y, w.z, r);
            this.atoms.setColorAt(nA, this.col.set(el?.color ?? '#ff00ff'));
            nA++;
          }
          if (a.electrons > 0 && nC < MAX_SPH) {
            const shells = a.electrons <= 2 ? 1 : a.electrons <= 10 ? 2 : a.electrons <= 28 ? 3 : 4;
            const rc = (4 + 2.2 * Math.cbrt(a.Z)) * (1.6 + shells * 0.5) * (atoms.length > 1 ? 0.8 : 1);
            put(this.clouds, nC, w.x, w.y, w.z, rc);
            const c = new THREE.Color(el?.color ?? '#88aaff').lerp(new THREE.Color(0x5599ff), 0.6);
            this.cloudColor.setXYZ(nC, c.r, c.g, c.b);
            nC++;
          }
        });
        for (const [i, j, o] of e.bonds ?? []) {
          const A = world[i], B = world[j];
          const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
          const len = Math.hypot(dx, dy, dz);
          if (len < 1e-6) continue;
          this.tmpQ.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
          const q = this.tmpQ.clone();
          for (let k = 0; k < o && nB < MAX_SPH; k++) {
            const off = (k - (o - 1) / 2) * 2.2;
            const perp = new THREE.Vector3(1, 0, 0).applyQuaternion(q).multiplyScalar(off);
            put(this.bonds, nB, (A.x + B.x) / 2 + perp.x, (A.y + B.y) / 2 + perp.y, (A.z + B.z) / 2 + perp.z, 0.9, q, len);
            nB++;
          }
        }
      }
    }
    this.nucleons.count = nN; this.electrons.count = nE; this.atoms.count = nA; this.clouds.count = nC; this.bonds.count = nB;
    for (const m of [this.nucleons, this.electrons, this.atoms, this.clouds, this.bonds]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.cloudColor.needsUpdate = true;
    this.photons.geometry.setDrawRange(0, nP);
    (this.photons.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.updateDetail(dt);
    // sélection
    const sel = this.selectedEntity !== null ? this.entityById(this.selectedEntity) : undefined;
    this.sel.visible = !!sel && this.sub !== 'micro';
    if (sel) {
      this.sel.position.set(sel.x - eye.x, sel.y - eye.y, sel.z - eye.z);
      this.sel.scale.setScalar(Math.max(18, this.sel.position.length() * 0.06));
      if (rig.mode === 'follow') rig.target = { x: sel.x, y: sel.y, z: sel.z };
    }
    g.labels.begin();
    if (sel && this.sub !== 'micro') {
      const s = g.engine.toScreen(this.sel.position);
      if (s.visible) g.labels.add(`e${sel.id}`, MicroLab.describe(sel), s.x * g.engine.width, s.y * g.engine.height + 16, 'sel');
    }
    if (this.sub === 'micro') g.labels.add('micro', 'Grains minéraux (~1–10 µm) — représentation stylisée', g.engine.width / 2, 120, 'k-info');
    g.labels.end();
  }

  /** Détail subatomique : quarks de valence (charges de couleur) et tubes de gluons. */
  private qGeo = new THREE.SphereGeometry(0.22, 12, 8);
  private qMats = [0xff3030, 0x30ff40, 0x3060ff].map((c) => new THREE.MeshBasicMaterial({ color: c }));
  private gluonMat = new THREE.LineBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.6 });

  private updateDetail(_dt: number): void {
    for (const c of this.detail.children) if (c instanceof THREE.LineSegments) c.geometry.dispose();
    this.detail.clear();
    if (this.sub !== 'subatomic' || this.selectedEntity === null) return;
    const e = this.entityById(this.selectedEntity);
    if (!e) return;
    const eye = this.game.engine.rig.eye;
    const t = this.game.realTime;
    const nucleons: { x: number; y: number; z: number; p: boolean }[] = [];
    if (e.kind === 'p' || e.kind === 'n') nucleons.push({ x: e.x, y: e.y, z: e.z, p: e.kind === 'p' });
    else if (e.kind === 'cluster' && e.atoms!.length === 1) {
      const a = e.atoms![0];
      const A = a.Z + a.N;
      const rng = new Rng(A * 131 + a.Z);
      const r = 1.4 * Math.cbrt(A);
      for (let n = 0; n < Math.min(A, 12); n++) {
        const [ux, uy, uz] = rng.onSphere();
        const rr = r * Math.cbrt(rng.next()) * 0.8;
        nucleons.push({ x: e.x + ux * rr, y: e.y + uy * rr, z: e.z + uz * rr, p: n < a.Z });
      }
    }
    for (const [k, n] of nucleons.entries()) {
      const flavors = n.p ? ['u', 'u', 'd'] : ['u', 'd', 'd'];
      const pts: THREE.Vector3[] = [];
      for (let q = 0; q < 3; q++) {
        const ang = t * 1.7 + (q * Math.PI * 2) / 3 + k;
        const pos = new THREE.Vector3(n.x - eye.x + Math.cos(ang) * 0.6, n.y - eye.y + Math.sin(ang * 1.3) * 0.4, n.z - eye.z + Math.sin(ang) * 0.6);
        // charge de couleur qui s'échange (échange de gluons)
        const m = new THREE.Mesh(this.qGeo, this.qMats[(q + Math.floor(t * 2 + k)) % 3]);
        m.position.copy(pos);
        m.scale.setScalar(flavors[q] === 'u' ? 1.1 : 0.9);
        this.detail.add(m);
        pts.push(pos);
      }
      const lg = new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[1], pts[2], pts[2], pts[0]]);
      this.detail.add(new THREE.LineSegments(lg, this.gluonMat));
    }
  }

  pick(px: number, py: number): PickResult | null {
    const g = this.game;
    const eye = g.engine.rig.eye;
    let best: MicroEntity | null = null, bd = Infinity;
    for (const e of this.lab.entities) {
      if (e.kind === 'photon') continue;
      const s = g.engine.toScreen(new THREE.Vector3(e.x - eye.x, e.y - eye.y, e.z - eye.z));
      if (!s.visible) continue;
      const d = Math.hypot(s.x * g.engine.width - px, s.y * g.engine.height - py);
      if (d < 16 && d < bd) { bd = d; best = e; }
    }
    return best ? { kind: 'entity', id: `e${best.id}`, label: MicroLab.describe(best) } : null;
  }

  positionOf(id: string): Vec3 | null {
    const e = this.entityById(Number(id.slice(1)));
    return e ? { x: e.x, y: e.y, z: e.z } : null;
  }

  framingDistance(_id: string): number {
    return 60;
  }
}
