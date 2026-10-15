import * as THREE from 'three';
import { AU_KM, R_SUN_KM, clamp, km2au } from '../../core/units';
import { blackbodyRGB } from '../../core/color';
import type { Vec3 } from '../../core/vec';
import type { Body } from '../../sim/types';
import { habitableZone } from '../../sim/stellar';
import { iscoRadiusRs, horizonRadiusRs } from '../../sim/blackhole';
import { potentialAt, createBuffers } from '../../sim/gravity';
import { PARTICLE_DEBRIS, PARTICLE_EJECTA, PARTICLE_GAS } from '../../sim/particles';
import { Sky } from '../objects/sky';
import { glowTexture, ringTexture, softTexture, disposeObject } from '../objects/common';
import {
  createPlanetMaterial, createAtmosphereMaterial, createCloudMaterial, createGasGiantMaterial, createRingMaterial,
  PlanetTerrain, TerrainBuild, MAX_LIGHTS, MAX_OCCLUDERS,
} from '../objects/planetMesh';
import {
  createStarMaterial, createCoronaMaterial, createNebulaMaterial, createDiskMaterial, createJetMaterial, createHaloMaterial, createParticleMaterial,
} from '../objects/stellarMesh';
import type { View, PickResult } from './view';
import type { Game } from '../../game';

/** Unités de rendu : 1 unité = 1000 km. */
export const KM_UNIT = 1e-3;
export const AU_UNIT = AU_KM * KM_UNIT;

interface Light {
  pos: THREE.Vector3; // relatif à l'œil (unités)
  color: THREE.Color;
  lum: number; // L☉
  radius: number; // unités
  au: Vec3;
}

interface Ctx {
  rel: THREE.Vector3;
  r: number; // rayon en unités
  dist: number;
  px: number;
  lights: Light[];
  occluders: THREE.Vector4[];
  time: number;
  dtReal: number;
  dtSim: number;
}

abstract class BodyVisual {
  readonly group = new THREE.Group();
  dot: THREE.Sprite;
  constructor(public body: Body) {
    this.dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTexture(), color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.dot.renderOrder = 2;
    this.group.add(this.dot);
  }
  abstract update(c: Ctx, v: SystemView): void;
  /** Point lumineux de repérage quand l'objet fait moins de quelques pixels. */
  protected updateDot(c: Ctx, v: SystemView, color: THREE.ColorRepresentation, minPx = 2.5, maxShowPx = 3): void {
    const show = c.px < maxShowPx;
    this.dot.visible = show;
    if (show) {
      const s = v.worldSizeForPixels(minPx * 2.2, c.dist);
      this.dot.scale.set(s, s, s);
      (this.dot.material as THREE.SpriteMaterial).color.set(color);
    }
  }
  dispose(): void {
    disposeObject(this.group);
  }
}

class StarVisual extends BodyVisual {
  sphere: THREE.Mesh;
  mat = createStarMaterial();
  corona: THREE.Mesh;
  coronaMat = createCoronaMaterial();
  glow: THREE.Sprite;
  beams: THREE.Group | null = null;
  constructor(body: Body) {
    super(body);
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.mat);
    this.corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.coronaMat);
    this.corona.renderOrder = 3;
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.glow.renderOrder = 4;
    this.group.add(this.sphere, this.corona, this.glow);
    this.mat.uniforms.seed.value = (body.seed % 1000) / 7;
    this.coronaMat.uniforms.seed.value = (body.seed % 100) / 3;
    if (body.kind === 'neutronstar') {
      const jm = createJetMaterial();
      jm.uniforms.color.value = new THREE.Color(0.6, 0.8, 1.0);
      const geo = new THREE.ConeGeometry(0.25, 1, 24, 1, true);
      geo.translate(0, -0.5, 0);
      this.beams = new THREE.Group();
      const a = new THREE.Mesh(geo, jm), b = new THREE.Mesh(geo, jm);
      a.rotation.x = Math.PI; b.rotation.x = 0;
      this.beams.add(a, b);
      this.group.add(this.beams);
    }
  }
  update(c: Ctx, v: SystemView): void {
    const b = this.body;
    const T = b.temperature || 5000;
    const L = b.star?.luminosity ?? (b.kind === 'browndwarf' ? 1e-5 : 0.01);
    const [cr, cg, cb] = blackbodyRGB(T);
    const col = new THREE.Color(cr, cg, cb);
    this.sphere.scale.setScalar(c.r);
    this.mat.uniforms.temperature.value = T;
    this.mat.uniforms.time.value = c.time;
    this.mat.uniforms.intensity.value = b.kind === 'browndwarf' ? 1.2 : b.kind === 'protostar' ? 3 : 4;
    this.mat.uniforms.activity.value = b.kind === 'star' ? 0.6 : 0.2;
    this.sphere.visible = c.px > 0.5;
    // couronne
    this.corona.visible = c.px > 2 && b.kind !== 'browndwarf';
    this.corona.scale.setScalar(c.r * (b.kind === 'protostar' ? 6 : 3.2));
    (this.coronaMat.uniforms.color.value as THREE.Color).copy(col);
    this.coronaMat.uniforms.time.value = c.time;
    this.coronaMat.uniforms.intensity.value = b.kind === 'neutronstar' ? 0.4 : 1.2;
    // halo visible de loin
    const minPx = 14 + 9 * Math.log10(1 + L);
    const s = Math.max(c.r * 9, v.worldSizeForPixels(minPx * 2, c.dist));
    this.glow.scale.setScalar(s);
    (this.glow.material as THREE.SpriteMaterial).color.copy(col).multiplyScalar(b.kind === 'browndwarf' ? 0.3 : clamp(0.6 + 0.25 * Math.log10(1 + L), 0.4, 2.5));
    this.dot.visible = false;
    if (this.beams && b.star) {
      // faisceaux du pulsar en rotation rapide autour d'un axe incliné
      this.beams.scale.setScalar(c.r * 400);
      this.beams.rotation.set(0.4, c.time * 6, 0);
      this.beams.children.forEach((m) => {
        const mm = (m as THREE.Mesh).material as THREE.ShaderMaterial;
        mm.uniforms.time.value = c.time;
      });
    }
  }
}

class PlanetVisual extends BodyVisual {
  mesh: THREE.Mesh | null = null;
  mat = createPlanetMaterial();
  terrain = new PlanetTerrain();
  pending: TerrainBuild | null = null;
  pendingSeg = 0;
  atmo: THREE.Mesh;
  atmoMat = createAtmosphereMaterial();
  clouds: THREE.Mesh;
  cloudMat = createCloudMaterial();
  gas: THREE.Mesh | null = null;
  gasMat: THREE.ShaderMaterial | null = null;
  rings: THREE.Mesh | null = null;
  ringMat: THREE.ShaderMaterial | null = null;
  tail: THREE.Mesh | null = null;
  spin = new THREE.Group();
  rotAngle = 0;
  constructor(body: Body) {
    super(body);
    this.group.add(this.spin);
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.atmoMat);
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.cloudMat);
    this.spin.add(this.atmo, this.clouds);
    this.cloudMat.uniforms.seed.value = (body.seed % 1000) / 13;
    if (body.planet?.gasGiant) {
      this.gasMat = createGasGiantMaterial();
      this.gas = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.gasMat);
      this.spin.add(this.gas);
      const ice = body.composition.ice > 0.2;
      const rnd = (body.seed % 997) / 997;
      this.gasMat.uniforms.seed.value = rnd * 50;
      if (ice) {
        (this.gasMat.uniforms.c1.value as THREE.Color).setRGB(0.55, 0.75, 0.9);
        (this.gasMat.uniforms.c2.value as THREE.Color).setRGB(0.3, 0.5, 0.8);
        (this.gasMat.uniforms.c3.value as THREE.Color).setRGB(0.75, 0.9, 0.95);
      } else {
        (this.gasMat.uniforms.c1.value as THREE.Color).setHSL(0.08 + rnd * 0.05, 0.45, 0.68);
        (this.gasMat.uniforms.c2.value as THREE.Color).setHSL(0.05 + rnd * 0.04, 0.5, 0.42);
      }
    }
    if (body.kind === 'comet') {
      const jm = createJetMaterial();
      jm.uniforms.color.value = new THREE.Color(0.6, 0.85, 1.0);
      const geo = new THREE.ConeGeometry(0.3, 1, 24, 1, true);
      geo.translate(0, -0.5, 0);
      this.tail = new THREE.Mesh(geo, jm);
      this.group.add(this.tail);
    }
  }

  private ensureRings(): void {
    const p = this.body.planet!;
    if (p.hasRings && !this.rings) {
      this.ringMat = createRingMaterial();
      this.rings = new THREE.Mesh(new THREE.RingGeometry(1, 1, 256, 1), this.ringMat);
      this.rings.rotation.x = -Math.PI / 2;
      this.ringMat.uniforms.seed.value = (this.body.seed % 100) / 10;
      if (this.body.composition.ice > 0.3) (this.ringMat.uniforms.tint.value as THREE.Color).setRGB(0.7, 0.75, 0.8);
      this.group.add(this.rings);
    }
    if (this.rings) {
      this.rings.visible = p.hasRings;
      const geo = this.rings.geometry as THREE.RingGeometry;
      if (geo.parameters.innerRadius !== p.ringInner || geo.parameters.outerRadius !== p.ringOuter) {
        this.rings.geometry.dispose();
        this.rings.geometry = new THREE.RingGeometry(p.ringInner, p.ringOuter, 256, 1);
        this.ringMat!.uniforms.inner.value = p.ringInner;
        this.ringMat!.uniforms.outer.value = p.ringOuter;
      }
    }
  }

  update(c: Ctx, v: SystemView): void {
    const b = this.body, p = b.planet!;
    const visible = c.px > 1.2;
    this.ensureRings();
    // inclinaison et rotation propre
    const tilt = (p.axialTilt * Math.PI) / 180;
    this.group.rotation.set(0, 0, tilt);
    const dRot = (2 * Math.PI * c.dtSim * 8766) / Math.max(0.1, p.rotationHours);
    this.rotAngle += clamp(dRot, -0.8 * c.dtReal, 0.8 * c.dtReal);
    this.spin.rotation.y = this.rotAngle;
    this.clouds.rotation.y = this.rotAngle * 0.15;
    // éclairage
    const lightSetup = (m: THREE.ShaderMaterial) => v.applyLights(m, c, b);
    if (p.gasGiant && this.gas && this.gasMat) {
      this.gas.visible = visible;
      this.gas.scale.setScalar(c.r);
      lightSetup(this.gasMat);
      this.gasMat.uniforms.time.value = c.time;
      this.gasMat.uniforms.center.value.copy(c.rel);
      this.gasMat.uniforms.radius.value = c.r;
      this.gasMat.uniforms.ringRange.value.set(p.hasRings ? p.ringInner : 0, p.hasRings ? p.ringOuter : 0);
      this.gasMat.uniforms.ringNormal.value.set(-Math.sin(tilt), Math.cos(tilt), 0);
      this.gasMat.uniforms.heat.value = clamp(((b.heat ?? 0) - 200) / 3000, 0, 1);
      this.atmo.visible = false;
      this.clouds.visible = false;
    } else {
      // terrain avec niveaux de détail
      const want = !visible ? 0 : c.px < 25 ? 24 : c.px < 90 ? 48 : c.px < 300 ? 96 : v.game.engine.settings.terrainDetail;
      if (want > 0 && (this.terrain.needsRebuild(b, want) || !this.mesh) && (!this.pending || this.pendingSeg !== want)) {
        this.pending = new TerrainBuild(b, this.terrain.model!, want);
        this.pendingSeg = want;
        v.queueBuild(this);
      }
      if (this.mesh) {
        this.mesh.visible = visible;
        this.mesh.scale.setScalar(c.r);
        lightSetup(this.mat);
        this.mat.uniforms.time.value = c.time;
        this.mat.uniforms.cityLights.value = p.life >= 3 ? 1 : 0;
        this.mat.uniforms.center.value.copy(c.rel);
        this.mat.uniforms.radius.value = c.r;
        this.mat.uniforms.ringRange.value.set(p.hasRings ? p.ringInner : 0, p.hasRings ? p.ringOuter : 0);
        this.mat.uniforms.ringNormal.value.set(-Math.sin(tilt), Math.cos(tilt), 0);
      }
      // atmosphère
      const P = p.pressure;
      const hasAtmo = P > 0.003 && visible;
      this.atmo.visible = hasAtmo;
      if (hasAtmo) {
        const thick = clamp(0.015 + 0.012 * Math.log10(1 + P), 0.012, 0.08);
        this.atmo.scale.setScalar(c.r * (1 + thick));
        lightSetup(this.atmoMat);
        this.atmoMat.uniforms.center.value.copy(c.rel);
        const col = this.atmoMat.uniforms.atmColor.value as THREE.Color;
        // couleur selon la composition : diffusion Rayleigh (N₂/O₂), CO₂ dense, brume organique, poussière
        if (b.composition.organic > 0.03 && P > 0.5) col.setRGB(0.95, 0.6, 0.25);
        else if (P > 20) col.setRGB(0.95, 0.85, 0.55);
        else if (p.waterFraction < 0.05 && P < 0.05) col.setRGB(0.85, 0.55, 0.4);
        else col.setRGB(0.3, 0.55, 1.0);
        this.atmoMat.uniforms.density.value = clamp(0.5 + 0.35 * Math.log10(1 + P * 3), 0.3, 1.8);
      }
      const cover = P > 50 ? 0.98 : clamp(p.waterFraction * 0.7 * clamp(P, 0, 2) + (P > 5 ? 0.3 : 0), 0, 0.95);
      this.clouds.visible = hasAtmo && cover > 0.05;
      if (this.clouds.visible) {
        this.clouds.scale.setScalar(c.r * 1.012);
        lightSetup(this.cloudMat);
        this.cloudMat.uniforms.coverage.value = cover;
        this.cloudMat.uniforms.time.value = c.time;
        (this.cloudMat.uniforms.cloudColor.value as THREE.Color).set(P > 20 ? 0xf0dca0 : b.composition.organic > 0.03 ? 0xe0a050 : 0xffffff);
      }
    }
    if (this.rings && this.ringMat) {
      this.rings.scale.setScalar(c.r);
      this.rings.visible = p.hasRings && c.px * p.ringOuter > 1;
      lightSetup(this.ringMat);
      this.ringMat.uniforms.planetCenter.value.copy(c.rel);
      this.ringMat.uniforms.planetRadius.value = c.r;
    }
    // queue de comète (sublimation près de l'étoile)
    if (this.tail) {
      const L = c.lights[0];
      if (L) {
        const dAU = Math.max(0.05, Math.hypot(L.au.x - b.pos.x, L.au.y - b.pos.y, L.au.z - b.pos.z));
        const act = clamp(3 / (dAU * dAU), 0, 1);
        this.tail.visible = act > 0.02;
        const dir = c.rel.clone().sub(L.pos).normalize();
        this.tail.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().negate());
        const len = Math.max(c.r * 2000 * act, v.worldSizeForPixels(40 * act, c.dist));
        this.tail.scale.set(len * 0.08, len, len * 0.08);
        const jm = this.tail.material as THREE.ShaderMaterial;
        jm.uniforms.time.value = c.time;
        jm.uniforms.power.value = act;
      }
    }
    const baseCol = p.gasGiant ? 0xe8c890 : p.waterFraction > 0.5 ? 0x6aa8ff : 0xc8b8a0;
    this.updateDot(c, v, baseCol);
  }

  attachBuilt(): void {
    if (!this.pending) return;
    const geo = this.pending.geometry();
    this.terrain.seg = this.pending.seg;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geo;
    } else {
      this.mesh = new THREE.Mesh(geo, this.mat);
      this.spin.add(this.mesh);
    }
    this.pending = null;
  }
}

class BlackHoleVisual extends BodyVisual {
  horizon: THREE.Mesh;
  disk: THREE.Mesh;
  diskMat = createDiskMaterial();
  jets: THREE.Group;
  jetMat = createJetMaterial();
  twin: THREE.Mesh;
  constructor(body: Body) {
    super(body);
    const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.horizon = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), black);
    this.twin = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), black);
    this.twin.visible = false;
    this.disk = new THREE.Mesh(new THREE.RingGeometry(1, 40, 128, 4), this.diskMat);
    this.jets = new THREE.Group();
    const geo = new THREE.ConeGeometry(0.12, 1, 32, 1, true);
    geo.translate(0, -0.5, 0);
    const a = new THREE.Mesh(geo, this.jetMat), b = new THREE.Mesh(geo, this.jetMat);
    a.rotation.x = Math.PI;
    this.jets.add(a, b);
    this.group.add(this.horizon, this.twin, this.disk, this.jets);
  }
  update(c: Ctx, v: SystemView): void {
    const b = this.body, h = b.bh!;
    const rs = (schwarzschildKmOf(b) * KM_UNIT);
    const axis = new THREE.Vector3(h.axis.x, h.axis.y, h.axis.z).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    this.group.quaternion.copy(q);
    const merging = h.merger;
    const hr = horizonRadiusRs(h.spin);
    this.horizon.scale.setScalar(rs * hr);
    this.twin.visible = false;
    if (merging) {
      // deux horizons spiralant vers le centre (phase finale, temps réel)
      const f = clamp(merging.startTime / merging.duration, 0, 1);
      const sep = merging.sep0Km * KM_UNIT * Math.pow(1 - Math.min(f, 0.999), 0.25);
      const r1 = sep * merging.m2 / (merging.m1 + merging.m2), r2 = sep * merging.m1 / (merging.m1 + merging.m2);
      if (f < 0.97) {
        this.horizon.position.set(Math.cos(merging.phase) * r1, 0, Math.sin(merging.phase) * r1);
        this.twin.visible = true;
        this.twin.position.set(-Math.cos(merging.phase) * r2, 0, -Math.sin(merging.phase) * r2);
        this.horizon.scale.setScalar(rs * hr * merging.m1 / (merging.m1 + merging.m2));
        this.twin.scale.setScalar(rs * hr * merging.m2 / (merging.m1 + merging.m2));
      } else this.horizon.position.set(0, 0, 0);
      v.game.shakeCamera(f > 0.9 ? 1.2 : 0.2 * f);
    } else {
      this.horizon.position.set(0, 0, 0);
    }
    const rin = iscoRadiusRs(h.spin);
    const lumBright = clamp(0.35 + 0.18 * Math.log10(1 + h.luminosity), 0.15, 3);
    const hasDisk = h.diskMass > 1e-8 || h.luminosity > 1e-3;
    const rout = clamp(14 + 6 * Math.log10(1 + h.diskMass * 1e4), 12, 40);
    const temp = clamp(3000 + 2500 * Math.log10(1 + h.accretionRate * 1e8), 3500, 30000);
    const lensOn = v.game.engine.settings.lensing && c.px > 0.6;
    this.disk.visible = hasDisk && !lensOn && c.px * rout > 1;
    this.disk.scale.setScalar(rs);
    this.disk.rotation.x = -Math.PI / 2;
    this.diskMat.uniforms.inner.value = rin;
    this.diskMat.uniforms.outer.value = rout;
    this.diskMat.uniforms.temp.value = temp;
    this.diskMat.uniforms.bright.value = hasDisk ? lumBright : 0;
    this.diskMat.uniforms.time.value = c.time;
    this.jets.visible = h.jets && h.accretionRate > 1e-9 && h.spin > 0.3;
    const jl = rs * clamp(300 + 200 * Math.log10(1 + h.accretionRate * 1e9), 200, 3000);
    this.jets.scale.set(jl * 0.25, jl, jl * 0.25);
    this.jetMat.uniforms.time.value = c.time;
    this.jetMat.uniforms.power.value = clamp(h.spin * 0.8 * lumBright, 0.1, 1.5);
    // lentille gravitationnelle (passe écran)
    if (lensOn && c.dist < rs * 6000) {
      v.game.engine.lenses.push({
        viewPos: v.game.engine.toView(c.rel),
        rs: rs * (merging ? 1.0 : 1.0),
        axis: v.game.engine.toViewDir(axis),
        rin, rout, brightness: hasDisk ? lumBright : 0, temperature: temp,
      });
    }
    this.updateDot(c, v, 0xff9a40, 2.5, 3);
  }
}

function schwarzschildKmOf(b: Body): number {
  return 2.953 * Math.max(1e-6, b.mass - (b.bh?.diskMass ?? 0));
}

class NebulaVisual extends BodyVisual {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  constructor(body: Body, steps: number) {
    super(body);
    this.mat = createNebulaMaterial(steps);
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.mat);
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);
    this.mat.uniforms.seed.value = (body.seed % 1000) / 37;
  }
  update(c: Ctx, v: SystemView): void {
    const n = this.body.nebula!;
    this.mesh.scale.setScalar(c.r);
    this.mat.uniforms.center.value.copy(c.rel);
    this.mat.uniforms.radius.value = c.r;
    this.mat.uniforms.time.value = c.time;
    this.mat.uniforms.collapse.value = clamp(n.collapseProgress, 0, 1);
    this.mat.uniforms.remnant.value = n.remnant ? 1 : 0;
    this.mat.uniforms.temperature.value = n.gasTemperature;
    this.mat.uniforms.density.value = n.remnant ? clamp(0.6 + Math.log10(1 + n.density) * 0.3, 0.2, 2.5) : clamp(0.6 + Math.log10(n.density) * 0.25, 0.4, 3);
    this.mat.uniforms.heavy.value = this.body.composition.heavy + this.body.composition.metal;
    // étoile éclairante la plus proche à l'intérieur du nuage
    let best: Light | null = null;
    let bd = Infinity;
    for (const L of c.lights) {
      const d = L.pos.distanceTo(c.rel);
      if (d < bd && d < c.r * 1.5) { bd = d; best = L; }
    }
    const sl = this.mat.uniforms.starLight.value as THREE.Color;
    if (best) { sl.copy(best.color).multiplyScalar(clamp(0.3 + 0.3 * Math.log10(1 + best.lum), 0.2, 3)); this.mat.uniforms.starPos.value.copy(best.pos); }
    else sl.setRGB(0, 0, 0);
    this.updateDot(c, v, n.remnant ? 0x60e0ff : 0xff7090, 3, 2);
  }
}

class DarkMatterVisual extends BodyVisual {
  mesh: THREE.Mesh;
  constructor(body: Body) {
    super(body);
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), createHaloMaterial());
    this.group.add(this.mesh);
  }
  update(c: Ctx, v: SystemView): void {
    const show = v.game.analysis || v.game.selectionId === `b${this.body.id}`;
    this.mesh.visible = show;
    this.mesh.scale.setScalar(c.r * 1.6);
    this.updateDot(c, v, 0x8060ff, show ? 3 : 0, show ? 3 : 0);
  }
}

interface Trail {
  pts: Float64Array; // positions relatives au parent (UA)
  n: number;
  head: number;
  line: THREE.Line;
  parentId: number | undefined;
  last: Vec3;
}

interface Effect {
  obj: THREE.Object3D;
  au: Vec3;
  age: number;
  life: number;
  grow: number; // unités/s
  kind: 'flash' | 'shell';
  base: number;
}

/** Vue du système stellaire (échelles planétaire et stellaire, rendu continu km ↔ UA). */
export class SystemView implements View {
  readonly scene = new THREE.Scene();
  readonly level = 'system' as const;
  readonly renderScale = AU_UNIT;
  sky: Sky;
  visuals = new Map<number, BodyVisual>();
  private particles: THREE.Points;
  private pPos: Float32Array;
  private pCol: Float32Array;
  private pSize: Float32Array;
  private trails = new Map<number, Trail>();
  private trailGroup = new THREE.Group();
  private selRing: THREE.Sprite;
  private hz: THREE.Mesh;
  private grid: THREE.LineSegments;
  private gridFrame = 0;
  private predicted = new THREE.Group();
  private predTimer = 0;
  private effects: Effect[] = [];
  private buildQueue: PlanetVisual[] = [];
  private frame = 0;
  private gwWaves: { au: Vec3; age: number; amp: number }[] = [];
  showTrails = true;

  constructor(public game: Game) {
    this.sky = new Sky(1234);
    this.scene.add(this.sky.group);
    const cap = 40000;
    this.pPos = new Float32Array(cap * 3);
    this.pCol = new Float32Array(cap * 3);
    this.pSize = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.particles = new THREE.Points(g, createParticleMaterial());
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 6;
    this.scene.add(this.particles);
    this.scene.add(this.trailGroup);
    this.selRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), depthTest: false, depthWrite: false, transparent: true }));
    this.selRing.renderOrder = 20;
    this.scene.add(this.selRing);
    this.hz = new THREE.Mesh(new THREE.RingGeometry(1, 2, 128, 1), new THREE.MeshBasicMaterial({ color: 0x30ff80, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    this.hz.rotation.x = -Math.PI / 2;
    this.scene.add(this.hz);
    const gridGeo = new THREE.BufferGeometry();
    this.grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }));
    this.grid.frustumCulled = false;
    this.scene.add(this.grid);
    this.scene.add(this.predicted);
  }

  enter(): void {
    const rig = this.game.engine.rig;
    rig.renderScale = AU_UNIT;
    rig.minDistance = km2au(0.002);
    rig.maxDistance = 4e5;
    this.clearTrails();
  }

  exit(): void {
    this.game.labels.clear();
  }

  /** Taille en unités monde qui occupe `px` pixels à la distance `dist`. */
  worldSizeForPixels(px: number, dist: number): number {
    const rig = this.game.engine.rig;
    const f = this.game.engine.height / (2 * Math.tan((rig.camera.fov * Math.PI) / 360));
    return (px * dist) / f;
  }

  queueBuild(p: PlanetVisual): void {
    if (!this.buildQueue.includes(p)) this.buildQueue.push(p);
  }

  private lights: Light[] = [];

  /** Applique l'éclairage (sources + occulteurs) au matériau d'un corps. */
  applyLights(m: THREE.ShaderMaterial, c: Ctx, b: Body): void {
    const u = m.uniforms;
    const n = Math.min(MAX_LIGHTS, c.lights.length);
    u.lightCount.value = n;
    for (let i = 0; i < n; i++) {
      const L = c.lights[i];
      (u.lightPos.value as THREE.Vector3[])[i].copy(L.pos);
      const d2 = Math.max(1e-10, (L.au.x - b.pos.x) ** 2 + (L.au.y - b.pos.y) ** 2 + (L.au.z - b.pos.z) ** 2);
      // exposition perceptive : I = (L/d²)^0.2 (compression de la dynamique, choix artistique)
      const inten = clamp(Math.pow(L.lum / d2, 0.2), 0.08, 3);
      (u.lightColor.value as THREE.Color[])[i].copy(L.color).multiplyScalar(inten * 1.4);
      u.lightRadius.value[i] = L.radius;
    }
    const oc = this.game.engine.settings.eclipseShadows ? c.occluders.filter((o) => Math.abs(o.x - c.rel.x) + Math.abs(o.y - c.rel.y) + Math.abs(o.z - c.rel.z) > c.r * 0.01).slice(0, MAX_OCCLUDERS) : [];
    u.occCount.value = oc.length;
    oc.forEach((o, i) => (u.occluders.value as THREE.Vector4[])[i].copy(o));
  }

  private makeVisual(b: Body): BodyVisual {
    switch (b.kind) {
      case 'star': case 'protostar': case 'browndwarf': case 'whitedwarf': case 'neutronstar':
        return new StarVisual(b);
      case 'blackhole':
        return new BlackHoleVisual(b);
      case 'nebula':
        return new NebulaVisual(b, this.game.engine.settings.volumetricSteps);
      case 'darkmatter':
        return new DarkMatterVisual(b);
      default:
        return new PlanetVisual(b);
    }
  }

  private syncVisuals(): void {
    const w = this.game.world;
    const alive = new Set<number>();
    for (const b of w.bodies) {
      alive.add(b.id);
      let v = this.visuals.get(b.id);
      const wantKind = b.kind === 'star' || b.kind === 'protostar' || b.kind === 'browndwarf' || b.kind === 'whitedwarf' || b.kind === 'neutronstar' ? 'star' : b.kind;
      const haveKind = v ? (v instanceof StarVisual ? 'star' : v instanceof BlackHoleVisual ? 'blackhole' : v instanceof NebulaVisual ? 'nebula' : v instanceof DarkMatterVisual ? 'darkmatter' : 'planet') : null;
      const sameKind = haveKind === wantKind || (haveKind === 'planet' && ['planet', 'moon', 'asteroid', 'comet'].includes(b.kind));
      if (v && (!sameKind || (v instanceof StarVisual && (b.kind === 'neutronstar') !== !!v.beams))) {
        this.scene.remove(v.group);
        v.dispose();
        v = undefined;
      }
      if (!v) {
        v = this.makeVisual(b);
        this.visuals.set(b.id, v);
        this.scene.add(v.group);
      }
      v.body = b;
    }
    for (const [id, v] of this.visuals) {
      if (!alive.has(id)) {
        this.scene.remove(v.group);
        v.dispose();
        this.visuals.delete(id);
        this.buildQueue = this.buildQueue.filter((p) => p !== v);
        const t = this.trails.get(id);
        if (t) { this.trailGroup.remove(t.line); t.line.geometry.dispose(); this.trails.delete(id); }
      }
    }
  }

  clearTrails(): void {
    for (const t of this.trails.values()) { this.trailGroup.remove(t.line); t.line.geometry.dispose(); }
    this.trails.clear();
  }

  update(dtReal: number): void {
    const game = this.game;
    const w = game.world;
    const rig = game.engine.rig;
    const eye = rig.eye;
    const time = game.realTime;
    const dtSim = w.lastReport.achieved;
    this.frame++;
    game.engine.lenses = [];
    this.syncVisuals();
    // sources lumineuses
    const lights: Light[] = [];
    for (const b of w.bodies) {
      const lum = b.star && (b.kind === 'star' || b.kind === 'protostar' || b.kind === 'whitedwarf') ? b.star.luminosity : b.kind === 'browndwarf' ? 1e-5 : b.bh ? b.bh.luminosity : 0;
      if (lum <= 0) continue;
      const [r, g, bb] = blackbodyRGB(b.bh ? 9000 : b.temperature || 5000);
      lights.push({ pos: rig.rel(b.pos, AU_UNIT), color: new THREE.Color(r, g, bb), lum, radius: Math.max(b.radius * KM_UNIT, 1), au: b.pos });
    }
    lights.sort((a, b) => b.lum - a.lum);
    this.lights = lights.slice(0, MAX_LIGHTS);
    // occulteurs pour les éclipses : corps proches de la caméra et assez grands
    const occ: THREE.Vector4[] = [];
    for (const b of w.bodies) {
      if (!b.planet || b.radius < 300) continue;
      const rel = rig.rel(b.pos, AU_UNIT);
      occ.push(new THREE.Vector4(rel.x, rel.y, rel.z, b.radius * KM_UNIT));
    }
    occ.sort((a, b) => b.w / Math.max(1, Math.hypot(b.x, b.y, b.z)) - a.w / Math.max(1, Math.hypot(a.x, a.y, a.z)));
    const occluders = occ.slice(0, 12);
    // corps
    const H = game.engine.height;
    const pf = H / (2 * Math.tan((rig.camera.fov * Math.PI) / 360));
    game.labels.begin();
    const labelCandidates: { id: string; name: string; x: number; y: number; pri: number; cls: string; marker: boolean }[] = [];
    for (const b of w.bodies) {
      const v = this.visuals.get(b.id)!;
      const rel = rig.rel(b.pos, AU_UNIT);
      v.group.position.copy(rel);
      const r = b.radius * KM_UNIT;
      const dist = rel.length();
      const px = (r / Math.max(dist, 1e-9)) * pf;
      v.update({ rel, r, dist, px, lights: this.lights, occluders, time, dtReal, dtSim }, this);
      // étiquettes
      if (game.engine.settings.labels && b.kind !== 'darkmatter') {
        const s = game.engine.toScreen(rel);
        if (s.visible && s.x > -0.05 && s.x < 1.05 && s.y > -0.05 && s.y < 1.05) {
          const pri = (b.kind === 'star' || b.kind === 'blackhole' ? 1e6 : 0) + b.mass * 1e6 + (game.selectionId === `b${b.id}` ? 1e12 : 0);
          labelCandidates.push({ id: `b${b.id}`, name: b.name, x: s.x * game.engine.width, y: s.y * game.engine.height, pri, cls: `k-${b.kind}${game.selectionId === `b${b.id}` ? ' sel' : ''}`, marker: px < 3 });
        }
      }
    }
    labelCandidates.sort((a, b) => b.pri - a.pri);
    const placed: { x: number; y: number }[] = [];
    for (const l of labelCandidates) {
      if (placed.length > 45) break;
      if (placed.some((p) => Math.abs(p.x - l.x) < 60 && Math.abs(p.y - l.y) < 14)) continue;
      placed.push(l);
      game.labels.add(l.id, l.name, l.x, l.y, l.cls, l.marker);
    }
    game.labels.end();
    // construction progressive des terrains (budget par image)
    let budget = 6;
    while (this.buildQueue.length && budget > 0) {
      const p = this.buildQueue[0];
      if (!p.pending) { this.buildQueue.shift(); continue; }
      const t0 = performance.now();
      if (p.pending.step(budget)) { p.attachBuilt(); this.buildQueue.shift(); }
      budget -= performance.now() - t0;
    }
    this.updateParticles();
    this.updateTrails();
    this.updateSelection(pf);
    this.updateAnalysis(dtReal);
    this.updateEffects(dtReal, pf);
    this.sky.setPixelRatio(game.engine.renderer.getPixelRatio());
    void eye;
  }

  private updateParticles(): void {
    const P = this.game.world.particles;
    const eye = this.game.engine.rig.eye;
    const n = Math.min(P.count, this.pSize.length, this.game.engine.settings.particleBudget);
    const stride = P.count > n ? P.count / n : 1;
    for (let k = 0; k < n; k++) {
      const i = Math.floor(k * stride);
      this.pPos[k * 3] = (P.px[i] - eye.x) * AU_UNIT;
      this.pPos[k * 3 + 1] = (P.py[i] - eye.y) * AU_UNIT;
      this.pPos[k * 3 + 2] = (P.pz[i] - eye.z) * AU_UNIT;
      const kind = P.kind[i];
      const T = P.temp[i];
      let r = 0.5, g = 0.45, b = 0.4, s = 1.6;
      if (kind === PARTICLE_EJECTA || (kind === PARTICLE_GAS && T > 3000)) {
        const [cr, cg, cb] = blackbodyRGB(Math.min(T, 30000));
        const k2 = clamp(Math.log10(T) / 6, 0.2, 1.2);
        r = cr * k2; g = cg * k2; b = cb * k2; s = kind === PARTICLE_EJECTA ? 2.2 : 2.6;
      } else if (kind === PARTICLE_GAS) { r = 0.8; g = 0.35; b = 0.5; s = 2.4; }
      else if (kind === PARTICLE_DEBRIS) { const h = T > 1000 ? 1 : 0; r = 0.22 + 0.7 * h; g = 0.2 + 0.2 * h; b = 0.18; s = 1.3; }
      else { r = 0.55; g = 0.75; b = 0.9; s = 1.5; }
      this.pCol[k * 3] = r; this.pCol[k * 3 + 1] = g; this.pCol[k * 3 + 2] = b;
      this.pSize[k] = s;
    }
    const geo = this.particles.geometry;
    geo.setDrawRange(0, n);
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (this.particles.material as THREE.ShaderMaterial).uniforms.pixelRatio.value = this.game.engine.renderer.getPixelRatio();
  }

  private updateTrails(): void {
    const w = this.game.world;
    const eye = this.game.engine.rig.eye;
    if (this.frame % 30 === 0) w.computeParents();
    const N = 360;
    for (const b of w.bodies) {
      if (b.kind === 'darkmatter' || b.kind === 'nebula' || b.parentId === undefined) continue;
      const parent = w.get(b.parentId);
      if (!parent) continue;
      let t = this.trails.get(b.id);
      if (!t || t.parentId !== b.parentId) {
        if (t) { this.trailGroup.remove(t.line); t.line.geometry.dispose(); }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
        const colors = new Float32Array(N * 3);
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
        line.frustumCulled = false;
        this.trailGroup.add(line);
        t = { pts: new Float64Array(N * 3), n: 0, head: 0, line, parentId: b.parentId, last: { x: Infinity, y: 0, z: 0 } };
        this.trails.set(b.id, t);
      }
      const rx = b.pos.x - parent.pos.x, ry = b.pos.y - parent.pos.y, rz = b.pos.z - parent.pos.z;
      const dr = Math.hypot(rx - t.last.x, ry - t.last.y, rz - t.last.z);
      const rr = Math.hypot(rx, ry, rz);
      if (dr > rr * 0.015 || t.n === 0) {
        t.pts[t.head * 3] = rx; t.pts[t.head * 3 + 1] = ry; t.pts[t.head * 3 + 2] = rz;
        t.head = (t.head + 1) % N;
        t.n = Math.min(N, t.n + 1);
        t.last = { x: rx, y: ry, z: rz };
      }
      const pos = t.line.geometry.attributes.position as THREE.BufferAttribute;
      const col = t.line.geometry.attributes.color as THREE.BufferAttribute;
      const base = b.kind === 'star' ? [1, 0.8, 0.4] : b.kind === 'moon' ? [0.5, 0.6, 0.7] : b.kind === 'comet' ? [0.5, 0.9, 1] : b.kind === 'blackhole' ? [1, 0.5, 0.2] : [0.35, 0.6, 1];
      const sel = this.game.selectionId === `b${b.id}` ? 2 : 1;
      for (let k = 0; k < t.n; k++) {
        const idx = (t.head - t.n + k + N) % N;
        pos.array[k * 3] = (parent.pos.x + t.pts[idx * 3] - eye.x) * AU_UNIT;
        pos.array[k * 3 + 1] = (parent.pos.y + t.pts[idx * 3 + 1] - eye.y) * AU_UNIT;
        pos.array[k * 3 + 2] = (parent.pos.z + t.pts[idx * 3 + 2] - eye.z) * AU_UNIT;
        const a = (k / t.n) * 0.5 * sel;
        col.array[k * 3] = base[0] * a; col.array[k * 3 + 1] = base[1] * a; col.array[k * 3 + 2] = base[2] * a;
      }
      // dernier point = position actuelle
      if (t.n > 0) {
        const k = t.n - 1;
        pos.array[k * 3] = (b.pos.x - eye.x) * AU_UNIT; pos.array[k * 3 + 1] = (b.pos.y - eye.y) * AU_UNIT; pos.array[k * 3 + 2] = (b.pos.z - eye.z) * AU_UNIT;
      }
      t.line.geometry.setDrawRange(0, t.n);
      pos.needsUpdate = true;
      col.needsUpdate = true;
      t.line.visible = this.showTrails;
    }
  }

  private updateSelection(pf: number): void {
    const id = this.game.selectionId;
    const b = id?.startsWith('b') ? this.game.world.get(Number(id.slice(1))) : undefined;
    if (!b) { this.selRing.visible = false; return; }
    const rel = this.game.engine.rig.rel(b.pos, AU_UNIT);
    const dist = rel.length();
    const r = b.radius * KM_UNIT * (b.kind === 'blackhole' ? 3 : 1);
    const px = (r / Math.max(dist, 1e-9)) * pf;
    this.selRing.visible = true;
    this.selRing.position.copy(rel);
    const s = Math.max(r * 2.6, this.worldSizeForPixels(Math.max(28, px * 2.6), dist));
    this.selRing.scale.set(s, s, s);
    this.selRing.material.rotation += 0.01;
  }

  private updateAnalysis(dtReal: number): void {
    const game = this.game;
    const w = game.world;
    const rig = game.engine.rig;
    const on = game.analysis;
    const primary = w.primary();
    // zone habitable
    this.hz.visible = on && !!primary?.star;
    if (this.hz.visible && primary?.star) {
      const [a, b] = habitableZone(primary.star.luminosity);
      const geo = this.hz.geometry as THREE.RingGeometry;
      if (Math.abs(geo.parameters.innerRadius - a * AU_UNIT) > 1e-3 * a * AU_UNIT) {
        this.hz.geometry.dispose();
        this.hz.geometry = new THREE.RingGeometry(a * AU_UNIT, b * AU_UNIT, 160, 1);
      }
      this.hz.position.copy(rig.rel(primary.pos, AU_UNIT));
    }
    // grille de potentiel (puits gravitationnel)
    this.grid.visible = on;
    if (on && this.frame % 6 === 0) {
      this.gridFrame++;
      const buf = createBuffers(w.bodies.length);
      buf.n = w.bodies.length;
      w.bodies.forEach((b, i) => { buf.px[i] = b.pos.x; buf.py[i] = b.pos.y; buf.pz[i] = b.pos.z; buf.m[i] = b.kind === 'darkmatter' && !w.settings.darkMatterGravity ? 0 : b.mass; buf.eps[i] = w.softening(b) + km2au(b.radius); });
      const N = 56;
      const ext = rig.distance * 1.6;
      const cx = rig.target.x, cz = rig.target.z, cy = primary ? primary.pos.y : rig.target.y;
      const heights = new Float64Array((N + 1) * (N + 1));
      let minPhi = 0;
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const x = cx + ((i / N) * 2 - 1) * ext, z = cz + ((j / N) * 2 - 1) * ext;
        const phi = potentialAt(buf, x, cy, z);
        heights[j * (N + 1) + i] = phi;
        if (phi < minPhi) minPhi = phi;
      }
      const verts: number[] = [], cols: number[] = [];
      const hscale = ext * 0.35;
      const yOf = (phi: number) => -Math.log10(1 + (-phi / (Math.abs(minPhi) * 1e-3 + 1e-12))) / 3 * hscale;
      const push = (i: number, j: number) => {
        const phi = heights[j * (N + 1) + i];
        const x = cx + ((i / N) * 2 - 1) * ext, z = cz + ((j / N) * 2 - 1) * ext;
        const y = cy + yOf(phi);
        verts.push((x - rig.eye.x) * AU_UNIT, (y - rig.eye.y) * AU_UNIT, (z - rig.eye.z) * AU_UNIT);
        const k = clamp(-yOf(phi) / hscale, 0, 1);
        cols.push(0.15 + 0.7 * k, 0.4 + 0.2 * (1 - k), 0.9 - 0.5 * k);
      };
      for (let j = 0; j <= N; j++) for (let i = 0; i < N; i++) { push(i, j); push(i + 1, j); }
      for (let i = 0; i <= N; i++) for (let j = 0; j < N; j++) { push(i, j); push(i, j + 1); }
      const g = this.grid.geometry;
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    }
    // trajectoires prédites (copie N-corps indépendante)
    this.predicted.visible = on;
    this.predTimer -= dtReal;
    if (on && this.predTimer <= 0) {
      this.predTimer = 1.0;
      for (const c of [...this.predicted.children]) { this.predicted.remove(c); (c as THREE.Line).geometry.dispose(); }
      const sel = game.selectionId?.startsWith('b') ? w.get(Number(game.selectionId.slice(1))) : undefined;
      const span = sel?.parentId !== undefined ? estimatePeriod(sel, w.get(sel.parentId)) : 2;
      const traj = w.predictTrajectories(clamp(span, 1e-3, 500), 160);
      this.predictedTraj = traj;
    }
    if (on && this.predictedTraj) {
      for (const c of [...this.predicted.children]) { this.predicted.remove(c); (c as THREE.Line).geometry.dispose(); }
      for (const [id, pts] of this.predictedTraj) {
        const b = w.get(id);
        if (!b || b.kind === 'darkmatter') continue;
        const arr = new Float32Array(pts.length * 3);
        pts.forEach((p, k) => { arr[k * 3] = (p.x - rig.eye.x) * AU_UNIT; arr[k * 3 + 1] = (p.y - rig.eye.y) * AU_UNIT; arr[k * 3 + 2] = (p.z - rig.eye.z) * AU_UNIT; });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const isSel = game.selectionId === `b${id}`;
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: isSel ? 0xffd060 : 0x80ffb0, transparent: true, opacity: isSel ? 0.9 : 0.35 }));
        line.frustumCulled = false;
        this.predicted.add(line);
      }
    }
  }
  private predictedTraj: Map<number, Vec3[]> | null = null;

  /** Effet visuel ponctuel (explosion, onde de choc) à une position (UA). */
  spawnEffect(au: Vec3, magnitude: number, kind: 'flash' | 'shell' = 'flash', color = 0xffd8a0): void {
    const base = Math.max(1, magnitude);
    if (kind === 'flash') {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.renderOrder = 15;
      this.scene.add(s);
      this.effects.push({ obj: s, au: { ...au }, age: 0, life: 1.2 + base * 0.5, grow: 0, kind, base });
    } else {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, wireframe: true }));
      this.scene.add(m);
      this.effects.push({ obj: m, au: { ...au }, age: 0, life: 4, grow: 0, kind, base });
    }
  }

  gravitationalWave(au: Vec3, amp = 1): void {
    this.gwWaves.push({ au: { ...au }, age: 0, amp });
  }

  private updateEffects(dt: number, pf: number): void {
    const rig = this.game.engine.rig;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.age += dt;
      const f = e.age / e.life;
      if (f >= 1) {
        this.scene.remove(e.obj);
        disposeObject(e.obj);
        this.effects.splice(i, 1);
        continue;
      }
      const rel = rig.rel(e.au, AU_UNIT);
      e.obj.position.copy(rel);
      const dist = rel.length();
      if (e.kind === 'flash') {
        const px = (40 + e.base * 60) * Math.sin(Math.PI * Math.min(1, f * 1.5 + 0.1));
        const s = this.worldSizeForPixels(px * 2, dist);
        e.obj.scale.setScalar(s);
        ((e.obj as THREE.Sprite).material as THREE.SpriteMaterial).opacity = 1 - f;
      } else {
        const px = 20 + f * (200 + e.base * 80);
        e.obj.scale.setScalar(this.worldSizeForPixels(px, dist));
        ((e.obj as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - f);
      }
    }
    // ondes gravitationnelles → passe de distorsion
    const ripples = [];
    for (let i = this.gwWaves.length - 1; i >= 0; i--) {
      const g = this.gwWaves[i];
      g.age += dt;
      if (g.age > 3.5) { this.gwWaves.splice(i, 1); continue; }
      const s = this.game.engine.toScreen(rig.rel(g.au, AU_UNIT));
      ripples.push({ x: s.x, y: 1 - s.y, radius: g.age * 0.35, amp: g.amp * (1 - g.age / 3.5) });
    }
    this.game.engine.ripples = ripples;
    void pf;
  }

  pick(px: number, py: number): PickResult | null {
    const game = this.game;
    const rig = game.engine.rig;
    const pf = game.engine.height / (2 * Math.tan((rig.camera.fov * Math.PI) / 360));
    let best: { b: Body; score: number } | null = null;
    for (const b of game.world.bodies) {
      if (b.kind === 'darkmatter' && !game.analysis) continue;
      const rel = rig.rel(b.pos, AU_UNIT);
      const s = game.engine.toScreen(rel);
      if (!s.visible) continue;
      const sx = s.x * game.engine.width, sy = s.y * game.engine.height;
      const dist = rel.length();
      const rpx = ((b.radius * KM_UNIT) / Math.max(dist, 1e-9)) * pf;
      const d = Math.hypot(sx - px, sy - py);
      const tol = b.kind === 'nebula' ? rpx * 0.5 : Math.max(rpx, 12);
      if (d > tol) continue;
      const score = (b.kind === 'nebula' ? 1e6 : 0) + dist * (1 + d / Math.max(tol, 1));
      if (!best || score < best.score) best = { b, score };
    }
    return best ? { kind: 'body', id: `b${best.b.id}`, label: best.b.name } : null;
  }

  positionOf(id: string): Vec3 | null {
    if (!id.startsWith('b')) return null;
    const b = this.game.world.get(Number(id.slice(1)));
    return b ? { ...b.pos } : null;
  }

  framingDistance(id: string): number {
    const b = this.game.world.get(Number(id.slice(1)));
    if (!b) return 1;
    const r = km2au(b.radius);
    if (b.kind === 'nebula' || b.kind === 'darkmatter') return r * 3;
    if (b.kind === 'blackhole') return Math.max(r * 60, km2au(R_SUN_KM) * 0.05);
    if (b.planet?.hasRings) return r * b.planet.ringOuter * 3.5;
    return r * 4;
  }
}

function estimatePeriod(b: Body, p: Body | undefined): number {
  if (!p) return 2;
  const a = Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y, b.pos.z - p.pos.z);
  return 2 * Math.PI * Math.sqrt((a * a * a) / (4 * Math.PI * Math.PI * Math.max(1e-12, p.mass + b.mass))) * 1.05;
}
