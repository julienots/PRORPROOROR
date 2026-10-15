import * as THREE from 'three';
import type { Body } from '../../sim/types';
import { buildTerrain, sampleSurface, terrainSignature, type TerrainModel } from '../../procgen/terrain';
import { NOISE_GLSL } from '../shaders/noise';
import { LOGDEPTH_FRAG_HEAD, LOGDEPTH_FRAG_MAIN, LOGDEPTH_VERT_HEAD, LOGDEPTH_VERT_MAIN } from './common';

export const MAX_LIGHTS = 4;
export const MAX_OCCLUDERS = 4;

/** Uniformes d'éclairage partagés par tous les matériaux planétaires. */
export function lightUniforms(): Record<string, THREE.IUniform> {
  return {
    lightCount: { value: 0 },
    lightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    lightColor: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Color()) },
    lightRadius: { value: new Array(MAX_LIGHTS).fill(1) },
    occCount: { value: 0 },
    occluders: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4()) },
  };
}

export const LIGHT_GLSL = /* glsl */ `
uniform int lightCount;
uniform vec3 lightPos[${MAX_LIGHTS}];
uniform vec3 lightColor[${MAX_LIGHTS}];
uniform float lightRadius[${MAX_LIGHTS}];
uniform int occCount;
uniform vec4 occluders[${MAX_OCCLUDERS}];
// Ombre douce d'occulteurs sphériques (éclipses) : fraction du disque stellaire masquée
float sphereShadow(vec3 p, vec3 lp, float lr) {
  float sh = 1.0;
  vec3 L = lp - p;
  float dl = length(L);
  vec3 ld = L / dl;
  for (int k = 0; k < ${MAX_OCCLUDERS}; k++) {
    if (k >= occCount) break;
    vec3 oc = occluders[k].xyz - p;
    float t = dot(oc, ld);
    if (t <= 0.0 || t >= dl) continue;
    float dPerp = length(oc - ld * t);
    float ro = occluders[k].w;
    // rayon angulaire de la source vu depuis p, projeté à la distance de l'occulteur
    float rs = lr * t / dl;
    float s = smoothstep(ro - rs, ro + rs, dPerp);
    // obscurité maximale : totale si l'occulteur couvre la source, partielle sinon (transit)
    float dark = min(1.0, (ro * ro) / max(rs * rs, 1e-12));
    sh *= mix(1.0 - dark, 1.0, s);
  }
  return sh;
}
`;

const PLANET_VERT = /* glsl */ `
${LOGDEPTH_VERT_HEAD}
attribute vec3 color;
attribute float emissive;
attribute float water;
varying vec3 vColor; varying float vEmissive; varying float vWater;
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vObj;
void main() {
  vColor = color; vEmissive = emissive; vWater = water;
  vObj = normalize(position);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
  ${LOGDEPTH_VERT_MAIN}
}
`;

const PLANET_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_HEAD}
${LIGHT_GLSL}
${NOISE_GLSL}
uniform float cityLights;
uniform float time;
uniform vec3 ringNormal; uniform vec2 ringRange; uniform vec3 center; uniform float radius;
varying vec3 vColor; varying float vEmissive; varying float vWater;
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vObj;
void main() {
  ${LOGDEPTH_FRAG_MAIN}
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(-vWorld);
  // micro-relief procédural pour les gros plans
  float dcam = length(vWorld);
  float detail = clamp(radius * 40.0 / dcam, 0.0, 1.0);
  if (detail > 0.02) {
    float e = 0.0025;
    vec3 q = vObj * 180.0;
    float n0 = snoise(q);
    vec3 g = vec3(snoise(q + vec3(e*400.0,0,0)) - n0, snoise(q + vec3(0,e*400.0,0)) - n0, snoise(q + vec3(0,0,e*400.0)) - n0);
    N = normalize(N - g * 0.25 * detail * (1.0 - vWater));
  }
  vec3 col = vec3(0.0);
  float lit = 0.0;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= lightCount) break;
    vec3 L = normalize(lightPos[i] - vWorld);
    float ndl = dot(N, L);
    float sh = sphereShadow(vWorld, lightPos[i], lightRadius[i]);
    // ombre des anneaux
    if (ringRange.y > 0.0) {
      float denom = dot(L, ringNormal);
      if (abs(denom) > 1e-4) {
        float t = dot(center - vWorld, ringNormal) / denom;
        if (t > 0.0) {
          float rr = length(vWorld + L * t - center) / radius;
          if (rr > ringRange.x && rr < ringRange.y) sh *= 0.35 + 0.4 * snoise(vec3(rr * 40.0));
        }
      }
    }
    float diff = max(ndl, 0.0);
    // terminateur adouci (diffusion atmosphérique)
    diff = max(diff, smoothstep(-0.12, 0.1, ndl) * 0.08);
    col += vColor * diff * lightColor[i] * sh;
    if (vWater > 0.5) {
      vec3 H = normalize(L + V);
      col += lightColor[i] * pow(max(dot(N, H), 0.0), 90.0) * 0.9 * sh * step(0.0, ndl);
    }
    lit += max(ndl, 0.0) * sh;
  }
  // lumières des villes (vie complexe) côté nuit
  if (cityLights > 0.0 && vWater < 0.5) {
    float c = smoothstep(0.55, 0.9, snoise(vObj * 60.0)) * smoothstep(0.3, 0.8, snoise(vObj * 9.0));
    col += vec3(1.0, 0.75, 0.4) * c * cityLights * (1.0 - smoothstep(0.0, 0.25, lit)) * 0.8;
  }
  col += vColor * 0.012;
  col += vec3(1.0, 0.35, 0.08) * vEmissive * (0.8 + 0.2 * sin(time * 2.0 + vObj.x * 30.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Construit une sphère cubique déplacée par le terrain (par tranches pour ne pas bloquer). */
export class TerrainBuild {
  done = false;
  private face = 0;
  private positions: Float32Array;
  private colors: Float32Array;
  private emissive: Float32Array;
  private water: Float32Array;
  private indices: Uint32Array;
  readonly seg: number;
  constructor(private body: Body, private terrain: TerrainModel, seg: number) {
    this.seg = seg;
    const nv = 6 * (seg + 1) * (seg + 1);
    this.positions = new Float32Array(nv * 3);
    this.colors = new Float32Array(nv * 3);
    this.emissive = new Float32Array(nv);
    this.water = new Float32Array(nv);
    this.indices = new Uint32Array(6 * seg * seg * 6);
  }

  /** Avance la construction ; retourne vrai quand la géométrie est prête. */
  step(budgetMs: number): boolean {
    const t0 = performance.now();
    const s = this.seg;
    const dirs: [number[], number[], number[]][] = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    while (this.face < 6) {
      const [n, u, v] = dirs[this.face];
      const base = this.face * (s + 1) * (s + 1);
      for (let j = 0; j <= s; j++) for (let i = 0; i <= s; i++) {
        const a = (i / s) * 2 - 1, b = (j / s) * 2 - 1;
        // projection cube → sphère à aire quasi uniforme
        let x = n[0] + u[0] * a + v[0] * b, y = n[1] + u[1] * a + v[1] * b, z = n[2] + u[2] * a + v[2] * b;
        const x2 = x * x, y2 = y * y, z2 = z * z;
        const sx = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
        const sy = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
        const sz = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
        x = sx; y = sy; z = sz;
        const smp = sampleSurface(this.terrain, this.body, x, y, z);
        const r = 1 + smp.height;
        const k = base + j * (s + 1) + i;
        this.positions[k * 3] = x * r; this.positions[k * 3 + 1] = y * r; this.positions[k * 3 + 2] = z * r;
        this.colors[k * 3] = smp.color[0]; this.colors[k * 3 + 1] = smp.color[1]; this.colors[k * 3 + 2] = smp.color[2];
        this.emissive[k] = smp.emissive;
        this.water[k] = smp.water ? 1 : 0;
      }
      let q = this.face * s * s * 6;
      for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
        const a = base + j * (s + 1) + i, b = a + 1, c = a + (s + 1), d = c + 1;
        this.indices[q++] = a; this.indices[q++] = c; this.indices[q++] = b;
        this.indices[q++] = b; this.indices[q++] = c; this.indices[q++] = d;
      }
      this.face++;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.done = this.face >= 6;
    return this.done;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    g.setAttribute('emissive', new THREE.BufferAttribute(this.emissive, 1));
    g.setAttribute('water', new THREE.BufferAttribute(this.water, 1));
    g.setIndex(new THREE.BufferAttribute(this.indices, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export function createPlanetMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms(),
      cityLights: { value: 0 }, time: { value: 0 },
      ringNormal: { value: new THREE.Vector3(0, 1, 0) }, ringRange: { value: new THREE.Vector2(0, 0) },
      center: { value: new THREE.Vector3() }, radius: { value: 1 },
    },
    vertexShader: PLANET_VERT,
    fragmentShader: PLANET_FRAG,
  });
}

/** État de terrain d'une planète (modèle + constructions en cours). */
export class PlanetTerrain {
  model: TerrainModel | null = null;
  signature = '';
  tempBucket = 0;
  build: TerrainBuild | null = null;
  seg = 0;

  needsRebuild(b: Body, wantSeg: number): boolean {
    const sig = terrainSignature(b);
    const tb = Math.round(b.temperature / 25) + Math.round((b.heat ?? 0) / 200) * 1000 + (b.planet?.life ?? 0) * 100000;
    if (sig !== this.signature || tb !== this.tempBucket) {
      this.signature = sig;
      this.tempBucket = tb;
      this.model = buildTerrain(b);
      return true;
    }
    return wantSeg !== this.seg;
  }
}

// ---------------------------------------------------------------------------
// Atmosphère, nuages, géantes gazeuses, anneaux
// ---------------------------------------------------------------------------

export function createAtmosphereMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...lightUniforms(), atmColor: { value: new THREE.Color(0.3, 0.55, 1) }, density: { value: 1 }, center: { value: new THREE.Vector3() } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec3 vWorld; varying vec3 vN;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_VERT_MAIN}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      ${LIGHT_GLSL}
      uniform vec3 atmColor; uniform float density; uniform vec3 center;
      varying vec3 vWorld; varying vec3 vN;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        vec3 V = normalize(-vWorld);
        vec3 N = normalize(vN);
        float rim = 1.0 - abs(dot(N, V));
        float glow = pow(rim, 2.5);
        vec3 col = vec3(0.0);
        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          if (i >= lightCount) break;
          vec3 L = normalize(lightPos[i] - vWorld);
          float day = smoothstep(-0.25, 0.4, dot(normalize(vWorld - center), L));
          // diffusion vers l'avant (coucher de soleil) près du terminateur
          float fwd = pow(max(dot(-V, L), 0.0), 8.0);
          vec3 sunset = vec3(1.0, 0.45, 0.15) * fwd * smoothstep(0.4, -0.1, dot(normalize(vWorld - center), L)) * 0.6;
          col += (atmColor * glow * day + sunset * glow) * lightColor[i];
        }
        gl_FragColor = vec4(col * density, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

export function createCloudMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...lightUniforms(), coverage: { value: 0.5 }, time: { value: 0 }, seed: { value: 0 }, cloudColor: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec3 vWorld; varying vec3 vN; varying vec3 vObj;
      void main() {
        vObj = position;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_VERT_MAIN}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      ${LIGHT_GLSL}
      ${NOISE_GLSL}
      uniform float coverage; uniform float time; uniform float seed; uniform vec3 cloudColor;
      varying vec3 vWorld; varying vec3 vN; varying vec3 vObj;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        vec3 p = normalize(vObj);
        // bandes de circulation (cellules de Hadley) + tourbillons
        float lat = p.y;
        vec3 q = p * 2.5 + vec3(seed, 0.0, time * 0.01);
        q.x += sin(lat * 6.0 + time * 0.02) * 0.3;
        float n = fbm3(q, 6) * 0.5 + 0.5;
        float band = 0.6 + 0.4 * cos(lat * 9.0);
        float c = smoothstep(1.0 - coverage, 1.0 - coverage + 0.25, n * band);
        vec3 N = normalize(vN);
        vec3 col = vec3(0.0);
        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          if (i >= lightCount) break;
          vec3 L = normalize(lightPos[i] - vWorld);
          col += cloudColor * lightColor[i] * max(dot(N, L), 0.0) * sphereShadow(vWorld, lightPos[i], lightRadius[i]);
        }
        gl_FragColor = vec4(col * c, c * 0.92);
      }`,
    transparent: true,
    depthWrite: false,
  });
}

export function createGasGiantMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms(), time: { value: 0 }, seed: { value: 0 },
      c1: { value: new THREE.Color(0.85, 0.72, 0.55) }, c2: { value: new THREE.Color(0.6, 0.4, 0.28) }, c3: { value: new THREE.Color(0.95, 0.92, 0.85) },
      ringNormal: { value: new THREE.Vector3(0, 1, 0) }, ringRange: { value: new THREE.Vector2(0, 0) }, center: { value: new THREE.Vector3() }, radius: { value: 1 },
      heat: { value: 0 },
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec3 vWorld; varying vec3 vN; varying vec3 vObj;
      void main() {
        vObj = position;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_VERT_MAIN}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      ${LIGHT_GLSL}
      ${NOISE_GLSL}
      uniform float time; uniform float seed; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; uniform float heat;
      uniform vec3 ringNormal; uniform vec2 ringRange; uniform vec3 center; uniform float radius;
      varying vec3 vWorld; varying vec3 vN; varying vec3 vObj;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        vec3 p = normalize(vObj);
        float lat = p.y;
        float turb = fbm3(vec3(p.x * 3.0, lat * 14.0, p.z * 3.0) + seed + vec3(time * 0.01, 0.0, 0.0), 6);
        float bands = sin(lat * 22.0 + turb * 2.2 + seed) * 0.5 + 0.5;
        float fine = sin(lat * 70.0 + turb * 5.0) * 0.5 + 0.5;
        vec3 col = mix(c1, c2, bands);
        col = mix(col, c3, fine * 0.25);
        // grande tache (anticyclone)
        vec3 sp = normalize(vec3(cos(seed), -0.35, sin(seed)));
        float spot = smoothstep(0.18, 0.0, length((p - sp) * vec3(1.0, 1.8, 1.0)));
        col = mix(col, c2 * vec3(1.3, 0.7, 0.6), spot * 0.8);
        col *= 0.85 + 0.3 * fbm3(p * 8.0 + seed, 3);
        vec3 N = normalize(vN);
        vec3 V = normalize(-vWorld);
        vec3 outc = vec3(0.0);
        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          if (i >= lightCount) break;
          vec3 L = normalize(lightPos[i] - vWorld);
          float sh = sphereShadow(vWorld, lightPos[i], lightRadius[i]);
          if (ringRange.y > 0.0) {
            float denom = dot(L, ringNormal);
            if (abs(denom) > 1e-4) {
              float t = dot(center - vWorld, ringNormal) / denom;
              if (t > 0.0) {
                float rr = length(vWorld + L * t - center) / radius;
                if (rr > ringRange.x && rr < ringRange.y) sh *= 0.45;
              }
            }
          }
          float ndl = max(dot(N, L), 0.0);
          // assombrissement centre-bord
          outc += col * lightColor[i] * pow(ndl, 0.9) * sh;
        }
        float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        outc += c1 * rim * 0.15 * float(lightCount > 0);
        outc += vec3(1.0, 0.3, 0.1) * heat;
        gl_FragColor = vec4(outc, 1.0);
      }`,
  });
}

export function createRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...lightUniforms(), seed: { value: 1 }, inner: { value: 1.3 }, outer: { value: 2.3 }, planetCenter: { value: new THREE.Vector3() }, planetRadius: { value: 1 }, tint: { value: new THREE.Color(0.85, 0.78, 0.65) } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec3 vWorld; varying float vR;
      void main() {
        vR = length(position.xy);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_VERT_MAIN}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      ${LIGHT_GLSL}
      ${NOISE_GLSL}
      uniform float seed; uniform float inner; uniform float outer; uniform vec3 planetCenter; uniform float planetRadius; uniform vec3 tint;
      varying vec3 vWorld; varying float vR;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        float u = (vR - inner) / (outer - inner);
        if (u < 0.0 || u > 1.0) discard;
        float n = snoise(vec3(vR * 30.0, seed, 0.0)) * 0.5 + 0.5;
        float n2 = snoise(vec3(vR * 140.0, seed * 2.0, 0.0)) * 0.5 + 0.5;
        float gap = smoothstep(0.02, 0.06, abs(u - 0.62)) * smoothstep(0.01, 0.03, abs(u - 0.3));
        float a = (0.35 + 0.65 * n) * (0.6 + 0.4 * n2) * gap * smoothstep(0.0, 0.05, u) * smoothstep(1.0, 0.9, u);
        vec3 col = vec3(0.0);
        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          if (i >= lightCount) break;
          vec3 L = lightPos[i] - vWorld;
          vec3 ld = normalize(L);
          // ombre de la planète sur les anneaux
          vec3 oc = planetCenter - vWorld;
          float t = dot(oc, ld);
          float sh = 1.0;
          if (t > 0.0) sh = smoothstep(planetRadius * 0.98, planetRadius * 1.02, length(oc - ld * t));
          col += tint * lightColor[i] * sh * (0.6 + 0.4 * n2);
        }
        gl_FragColor = vec4(col * a, a * 0.9);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
