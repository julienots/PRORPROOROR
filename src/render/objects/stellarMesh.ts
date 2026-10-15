import * as THREE from 'three';
import { NOISE_GLSL, BLACKBODY_GLSL } from '../shaders/noise';
import { LOGDEPTH_FRAG_HEAD, LOGDEPTH_FRAG_MAIN, LOGDEPTH_VERT_HEAD, LOGDEPTH_VERT_MAIN } from './common';

/** Photosphère stellaire : granulation animée, taches, assombrissement centre-bord. */
export function createStarMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { temperature: { value: 5772 }, time: { value: 0 }, seed: { value: 0 }, intensity: { value: 4 }, activity: { value: 0.5 } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec3 vObj; varying vec3 vN; varying vec3 vWorld;
      void main() {
        vObj = position;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_VERT_MAIN}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      ${NOISE_GLSL}
      ${BLACKBODY_GLSL}
      uniform float temperature; uniform float time; uniform float seed; uniform float intensity; uniform float activity;
      varying vec3 vObj; varying vec3 vN; varying vec3 vWorld;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        vec3 p = normalize(vObj);
        float mu = max(dot(normalize(vN), normalize(-vWorld)), 0.0);
        // loi d'assombrissement centre-bord (Eddington) : I(μ) = 0.4 + 0.6 μ
        float limb = 0.4 + 0.6 * mu;
        float gran = fbm3(p * 40.0 + vec3(time * 0.05, seed, 0.0), 4) * 0.5 + 0.5;
        float cells = fbm3(p * 8.0 + vec3(0.0, time * 0.01, seed), 3);
        float spots = smoothstep(0.55, 0.75, fbm3(p * 3.0 + seed + time * 0.002, 4)) * activity * smoothstep(0.8, 0.2, abs(p.y));
        float T = temperature * (0.92 + 0.1 * gran + 0.04 * cells) * (1.0 - 0.3 * spots) * (0.8 + 0.2 * limb);
        vec3 col = blackbody(T) * limb * (0.85 + 0.3 * gran) * (1.0 - spots * 0.6);
        gl_FragColor = vec4(col * intensity, 1.0);
      }`,
  });
}

/** Couronne/halo (billboard additif) autour d'une étoile. */
export function createCoronaMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(1, 0.9, 0.7) }, time: { value: 0 }, intensity: { value: 1 }, seed: { value: 0 } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        mv.xy += position.xy * scale;
        gl_Position = projectionMatrix * mv;
        ${LOGDEPTH_VERT_MAIN}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      ${NOISE_GLSL}
      uniform vec3 color; uniform float time; uniform float intensity; uniform float seed;
      varying vec2 vUv;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        float r = length(vUv);
        if (r > 1.0) discard;
        float ang = atan(vUv.y, vUv.x);
        float streak = fbm3(vec3(cos(ang) * 3.0, sin(ang) * 3.0, r * 2.0 - time * 0.05 + seed), 4) * 0.5 + 0.5;
        float core = exp(-r * 7.0);
        float halo = exp(-r * 3.0) * (0.5 + 0.8 * streak) * 0.5;
        float a = (core + halo) * smoothstep(1.0, 0.6, r);
        gl_FragColor = vec4(color * a * intensity, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * Nébuleuse volumétrique par lancer de rayons dans une sphère (bruit fBm 3D).
 * Couleurs d'émission : Hα (rose-rouge), [OIII] (bleu-vert), poussières (brun).
 */
export function createNebulaMaterial(steps: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: { STEPS: steps },
    uniforms: {
      center: { value: new THREE.Vector3() }, radius: { value: 1 }, seed: { value: 0 }, time: { value: 0 },
      collapse: { value: 0 }, remnant: { value: 0 }, temperature: { value: 20 }, density: { value: 1 }, heavy: { value: 0.02 },
      starLight: { value: new THREE.Color(0, 0, 0) }, starPos: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_VERT_MAIN}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      ${NOISE_GLSL}
      uniform vec3 center; uniform float radius; uniform float seed; uniform float time; uniform float collapse; uniform float remnant;
      uniform float temperature; uniform float density; uniform float heavy; uniform vec3 starLight; uniform vec3 starPos;
      varying vec3 vWorld;
      float dens(vec3 q) {
        float r = length(q);
        float n = fbm3(q * 2.2 + seed + vec3(0.0, time * 0.003, 0.0), 5) * 0.5 + 0.5;
        float n2 = fbm3(q * 6.0 - seed, 3) * 0.5 + 0.5;
        float shape;
        if (remnant > 0.5) {
          shape = exp(-pow((r - 0.82) * 7.0, 2.0)) * (0.4 + 1.2 * n2); // coquille filamenteuse
        } else {
          float core = mix(1.0, 3.0, collapse);
          shape = exp(-r * r * core * 2.5) * (0.3 + n) * (0.6 + 0.6 * n2);
        }
        return max(shape - 0.12, 0.0);
      }
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        vec3 rd = normalize(vWorld);
        vec3 oc = -center;
        float b = dot(oc, rd);
        float c = dot(oc, oc) - radius * radius;
        float disc = b * b - c;
        if (disc < 0.0) discard;
        float sq = sqrt(disc);
        float t0 = max(-b - sq, 0.0);
        float t1 = -b + sq;
        if (t1 <= 0.0) discard;
        float dt = (t1 - t0) / float(STEPS);
        vec3 acc = vec3(0.0);
        float T = 1.0;
        float hot = clamp(log(max(temperature, 10.0)) / log(1e7), 0.0, 1.0);
        vec3 ha = vec3(1.0, 0.22, 0.38);
        vec3 o3 = vec3(0.15, 0.75, 0.85);
        vec3 dust = vec3(0.35, 0.22, 0.14);
        for (int i = 0; i < STEPS; i++) {
          float t = t0 + (float(i) + 0.5) * dt;
          vec3 q = (rd * t - center) / radius;
          float d = dens(q) * density;
          if (d <= 0.001) continue;
          float lightDist = length(q - (starPos - center) / radius);
          vec3 illum = starLight / (1.0 + lightDist * lightDist * 8.0);
          float mixO = clamp(0.3 + 0.5 * fbm3(q * 1.5 + seed * 3.0, 3) + hot * 0.4, 0.0, 1.0);
          vec3 em = mix(ha, o3, mixO) * (0.25 + hot * 1.4) + illum * 1.5;
          em = mix(em, dust * (0.4 + illum), clamp(heavy * 3.0, 0.0, 0.6) * (1.0 - hot));
          float a = 1.0 - exp(-d * dt / radius * 3.5);
          acc += T * em * a;
          T *= 1.0 - a * 0.85;
          if (T < 0.02) break;
        }
        gl_FragColor = vec4(acc, 1.0 - T);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Disque d'accrétion simple (utilisé quand la lentille gravitationnelle est désactivée). */
export function createDiskMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, inner: { value: 3 }, outer: { value: 15 }, temp: { value: 8000 }, bright: { value: 1 } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGDEPTH_VERT_MAIN} }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      ${NOISE_GLSL}
      ${BLACKBODY_GLSL}
      uniform float time; uniform float inner; uniform float outer; uniform float temp; uniform float bright;
      varying vec2 vP;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        float r = length(vP);
        if (r < inner || r > outer) discard;
        float f = pow(max(1.0 - sqrt(inner / r), 0.0), 0.25) * pow(inner / r, 0.75);
        float ang = atan(vP.y, vP.x);
        float om = 1.0 / (r * sqrt(2.0 * r));
        float n = fbm3(vec3(r * 0.8, cos(ang - time * om * 3.0) * 2.0, sin(ang - time * om * 3.0) * 2.0), 4) * 0.5 + 0.5;
        vec3 col = blackbody(temp * f * 2.2) * f * (0.5 + n) * bright * 6.0;
        float a = smoothstep(outer, outer * 0.6, r);
        gl_FragColor = vec4(col * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Jets relativistes : cônes additifs à texture de bruit défilante. */
export function createJetMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, power: { value: 1 }, color: { value: new THREE.Color(0.55, 0.7, 1.0) } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; ${LOGDEPTH_VERT_MAIN} }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      ${NOISE_GLSL}
      uniform float time; uniform float power; uniform vec3 color;
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        float along = vUv.y;
        float n = snoise(vec3(vUv.x * 6.0, along * 12.0 - time * 3.0, 0.0)) * 0.5 + 0.5;
        float edge = pow(abs(dot(normalize(vN), normalize(-vW))), 1.5);
        float a = (1.0 - along) * edge * (0.4 + 0.8 * n) * power;
        gl_FragColor = vec4(color * a * 2.0, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Halo de matière noire (mode analyse) : densité NFW projetée. */
export function createHaloMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(0.5, 0.3, 1.0) }, intensity: { value: 1 } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      varying vec3 vN; varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; ${LOGDEPTH_VERT_MAIN} }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      uniform vec3 color; uniform float intensity;
      varying vec3 vN; varying vec3 vW;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        float mu = abs(dot(normalize(vN), normalize(-vW)));
        // colonne de densité ∝ longueur de corde pondérée vers le centre
        float a = pow(mu, 1.5) * 0.35 + mu * 0.1;
        gl_FragColor = vec4(color * a * intensity, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

/** Particules (débris, éjectas, gaz) : points additifs à taille fixe en pixels. */
export function createParticleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: 1 }, sizeScale: { value: 1 } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_HEAD}
      attribute vec3 color; attribute float size; varying vec3 vCol;
      uniform float pixelRatio; uniform float sizeScale;
      void main() {
        vCol = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = size * pixelRatio * sizeScale;
        ${LOGDEPTH_VERT_MAIN}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_HEAD}
      varying vec3 vCol;
      void main() {
        ${LOGDEPTH_FRAG_MAIN}
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vCol * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}
