import { NOISE_GLSL, BLACKBODY_GLSL } from './noise';

export const MAX_LENSES = 4;
export const MAX_RIPPLES = 4;

/**
 * Passe de lentille gravitationnelle en espace écran.
 * Pour chaque pixel proche d'un trou noir, le rayon lumineux est intégré dans la
 * métrique de Schwarzschild (équation de Binet sous forme vectorielle :
 * a = −3/2 · h² · r / |r|⁵, unités Rs = 1). Les croisements du plan du disque
 * produisent l'émission du disque d'accrétion (profil de température de disque mince,
 * effet Doppler relativiste et décalage gravitationnel), y compris ses images
 * secondaires au-dessus et au-dessous de l'ombre.
 * Loin du trou noir, une déflexion de lentille mince α = 2 Rs / b est appliquée.
 * [Approximation] : spin ignoré pour la géodésique (Kerr non résolu), disque infiniment mince.
 */
export const LENSING_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform int lensCount;
uniform vec3 lensPos[${MAX_LENSES}];
uniform float lensRs[${MAX_LENSES}];
uniform vec3 lensAxis[${MAX_LENSES}];
uniform float lensRin[${MAX_LENSES}];
uniform float lensRout[${MAX_LENSES}];
uniform float lensBright[${MAX_LENSES}];
uniform float lensTemp[${MAX_LENSES}];
uniform int rippleCount;
uniform vec4 ripples[${MAX_RIPPLES}]; // xy centre écran, z rayon (uv), w amplitude
uniform mat4 projInv;
uniform mat4 proj;
uniform float time;
uniform float logDepthFar; // log2(far + 1)
uniform int steps;
uniform float aspect;
varying vec2 vUv;
${NOISE_GLSL}
${BLACKBODY_GLSL}

vec3 viewDir(vec2 uv) {
  vec4 p = projInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(p.xyz / p.w);
}

vec2 project(vec3 dir, out bool ok) {
  vec4 c = proj * vec4(dir * 1000.0, 1.0);
  ok = c.w > 0.0;
  return (c.xy / c.w) * 0.5 + 0.5;
}

float sceneDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  if (d >= 1.0) return 1e30;
  return exp2(d * logDepthFar) - 1.0;
}

vec3 sampleScene(vec3 dir) {
  bool ok;
  vec2 uv = project(dir, ok);
  if (!ok) return vec3(0.0);
  vec2 cuv = clamp(uv, vec2(0.001), vec2(0.999));
  float edge = smoothstep(0.0, 0.04, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) + 0.04);
  return texture2D(tDiffuse, cuv).rgb * edge;
}

// base orthonormée du trou noir : y = axe de rotation
mat3 lensBasis(vec3 axis) {
  vec3 up = normalize(axis);
  vec3 ref = abs(up.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 ex = normalize(ref - dot(ref, up) * up);
  vec3 ez = cross(ex, up);
  return mat3(ex, up, ez);
}

vec3 diskEmission(vec3 p, vec3 dir, float rin, float rout, float bright, float tScale) {
  float r = length(p.xz);
  if (r < rin || r > rout) return vec3(0.0);
  // profil de température du disque mince : T ∝ r^(-3/4) (1 - sqrt(rin/r))^(1/4)
  float f = pow(max(1.0 - sqrt(rin / r), 0.0), 0.25) * pow(rin / r, 0.75);
  float T = tScale * f * 2.2;
  // vitesse orbitale képlérienne (unités c, Rs = 1) : v = sqrt(1 / (2 r))
  float v = min(sqrt(0.5 / r), 0.7);
  vec3 vdir = normalize(vec3(-p.z, 0.0, p.x));
  float gam = 1.0 / sqrt(1.0 - v * v);
  float cosT = dot(vdir, -normalize(dir));
  float g = 1.0 / (gam * (1.0 - v * cosT)); // Doppler relativiste
  g *= sqrt(max(1.0 - 1.0 / r, 0.0)); // décalage gravitationnel
  float ang = atan(p.z, p.x);
  float omega = 1.0 / (r * sqrt(2.0 * r));
  float n = fbm3(vec3(r * 0.9, cos(ang - time * omega * 3.0) * 2.0, sin(ang - time * omega * 3.0) * 2.0), 4);
  float turb = 0.55 + 0.45 * n + 0.2 * sin(r * 3.0 - time * 0.5);
  float fade = smoothstep(rout, rout * 0.6, r) * smoothstep(rin, rin * 1.15, r);
  vec3 col = blackbody(T * g);
  return col * pow(g, 3.0) * f * turb * fade * bright * 6.0;
}

void main() {
  vec2 uv = vUv;
  // ondes gravitationnelles (représentation visuelle, amplitude très exagérée)
  for (int k = 0; k < ${MAX_RIPPLES}; k++) {
    if (k >= rippleCount) break;
    vec2 dv = uv - ripples[k].xy;
    dv.x *= aspect;
    float d = length(dv);
    float w = ripples[k].z;
    float env = exp(-pow((d - w) * 18.0, 2.0));
    uv += normalize(dv + 1e-6) * sin((d - w) * 120.0) * env * ripples[k].w * 0.01 / vec2(aspect, 1.0);
  }
  vec3 base = texture2D(tDiffuse, uv).rgb;
  vec3 rd = viewDir(uv);
  vec3 outCol = base;
  for (int L = 0; L < ${MAX_LENSES}; L++) {
    if (L >= lensCount) break;
    float rs = lensRs[L];
    vec3 c = lensPos[L];
    mat3 B = lensBasis(lensAxis[L]);
    mat3 Bt = transpose(B);
    vec3 p = Bt * (-c) / rs; // caméra dans le repère du trou noir
    vec3 d = normalize(Bt * rd);
    float R = max(60.0, lensRout[L] * 1.5);
    float camR = length(p);
    // paramètre d'impact
    float bImp = length(cross(p, d));
    float along = -dot(p, d);
    if (along < 0.0 && camR > R) continue; // derrière la caméra
    // lentille mince en dehors de la sphère d'intégration
    vec3 thin;
    {
      float alpha = 2.0 / max(bImp, 1.0);
      vec3 toC = normalize(-p - d * dot(-p, d));
      vec3 dd = normalize(d + toC * alpha);
      thin = sampleScene(B * dd);
    }
    if (bImp > R) {
      if (bImp < R * 3.0) {
        float w = smoothstep(R * 3.0, R, bImp);
        outCol = mix(outCol, thin, w);
      }
      continue;
    }
    // occultation par un objet plus proche que la zone du trou noir
    float distC = length(c);
    if (sceneDepth(uv) < (distC - R * rs) * 0.999) continue;
    // départ sur la sphère englobante (ou à la caméra si elle est à l'intérieur)
    if (camR > R) {
      float bb = dot(p, d);
      float cc = dot(p, p) - R * R;
      float disc = bb * bb - cc;
      if (disc < 0.0) continue;
      p += d * (-bb - sqrt(disc));
    }
    vec3 h = cross(p, d);
    float h2 = dot(h, h);
    vec3 col = vec3(0.0);
    float alphaAcc = 0.0;
    bool captured = false;
    vec3 vel = d;
    for (int i = 0; i < 400; i++) {
      if (i >= steps) break;
      float r2 = dot(p, p);
      float r = sqrt(r2);
      if (r < 1.0) { captured = true; break; }
      if (r > R * 1.02 && dot(p, vel) > 0.0) break;
      float dt = clamp(0.06 * r, 0.015, 3.0);
      vec3 acc = -1.5 * h2 * p / pow(r2, 2.5);
      vec3 pPrev = p;
      vel += acc * dt;
      p += vel * dt;
      if (sign(pPrev.y) != sign(p.y) && lensBright[L] > 0.0) {
        float t = pPrev.y / (pPrev.y - p.y);
        vec3 hit = mix(pPrev, p, t);
        vec3 e = diskEmission(hit, vel, lensRin[L], lensRout[L], lensBright[L], lensTemp[L]);
        float op = clamp(length(e) * 0.8, 0.0, 0.92);
        col += (1.0 - alphaAcc) * e;
        alphaAcc += (1.0 - alphaAcc) * op;
      }
    }
    vec3 bg = captured ? vec3(0.0) : sampleScene(B * normalize(vel));
    vec3 traced = col + (1.0 - alphaAcc) * bg;
    float w = smoothstep(R, R * 0.75, bImp);
    outCol = mix(thin, traced, w);
  }
  gl_FragColor = vec4(outCol, 1.0);
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
