import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { NOISE_GLSL } from '../shaders/noise';
import { blackbodyRGB } from '../../core/color';

/**
 * Ciel de fond : étoiles lointaines (densité concentrée dans le plan galactique),
 * bande de la Voie lactée et nébulosités. Rendu à l'infini (sans profondeur).
 */
export class Sky {
  readonly group = new THREE.Group();
  private band: THREE.Mesh;
  private stars: THREE.Points;
  private bandMat: THREE.ShaderMaterial;
  private starMat: THREE.ShaderMaterial;

  constructor(seed: number, count = 9000) {
    this.group.renderOrder = -10;
    this.bandMat = new THREE.ShaderMaterial({
      uniforms: { intensity: { value: 1 }, normal: { value: new THREE.Vector3(0.3, 0.9, 0.2).normalize() }, seed: { value: (seed % 1000) / 10 }, tint: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
          gl_Position = p.xyww;
          gl_Position.z = gl_Position.w * 0.99999;
        }`,
      fragmentShader: /* glsl */ `
        uniform float intensity; uniform vec3 normal; uniform float seed; uniform vec3 tint;
        varying vec3 vDir;
        ${NOISE_GLSL}
        void main() {
          vec3 d = normalize(vDir);
          float lat = dot(d, normal);
          float band = exp(-lat * lat * 28.0);
          float n = fbm3(d * 3.0 + seed, 6);
          float n2 = fbm3(d * 9.0 - seed, 4);
          float dust = smoothstep(0.1, 0.5, fbm3(d * 5.0 + seed * 2.0, 5)) * exp(-lat * lat * 90.0);
          vec3 col = vec3(0.55, 0.6, 0.85) * band * (0.35 + 0.65 * (0.5 + 0.5 * n)) * 0.22;
          col += vec3(0.9, 0.75, 0.55) * pow(band, 4.0) * (0.5 + 0.5 * n2) * 0.18;
          col *= 1.0 - dust * 0.8;
          // nébulosités colorées
          float neb = smoothstep(0.35, 0.8, fbm3(d * 2.2 + 31.0 + seed, 5));
          col += mix(vec3(0.5, 0.08, 0.2), vec3(0.08, 0.25, 0.5), 0.5 + 0.5 * n) * neb * 0.08 * (0.3 + band);
          gl_FragColor = vec4(col * intensity * tint, 1.0);
        }`,
      depthWrite: false,
      depthTest: false,
      side: THREE.BackSide,
    });
    this.band = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.bandMat);
    this.band.frustumCulled = false;
    this.band.renderOrder = -10;
    this.group.add(this.band);

    const rng = new Rng(seed);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const n = new THREE.Vector3(0.3, 0.9, 0.2).normalize();
    for (let i = 0; i < count; i++) {
      let [x, y, z] = rng.onSphere();
      // concentration vers le plan galactique pour 60 % des étoiles
      if (rng.next() < 0.6) {
        const d = x * n.x + y * n.y + z * n.z;
        const k = 1 - Math.min(1, Math.abs(rng.gauss(0, 0.25)) / Math.max(Math.abs(d), 1e-3)) * 0;
        x -= n.x * d * 0.85 * k; y -= n.y * d * 0.85 * k; z -= n.z * d * 0.85 * k;
        const l = Math.hypot(x, y, z);
        x /= l; y /= l; z /= l;
      }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      const T = rng.next() < 0.7 ? rng.range(3000, 6500) : rng.range(6500, 25000);
      const [r, g, b] = blackbodyRGB(T);
      const m = Math.pow(rng.next(), 6);
      const br = 0.25 + m * 3;
      col[i * 3] = r * br; col[i * 3 + 1] = g * br; col[i * 3 + 2] = b * br;
      size[i] = 1.0 + m * 2.2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { intensity: { value: 1 }, pixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float size; attribute vec3 color; varying vec3 vCol; uniform float pixelRatio;
        void main() {
          vCol = color;
          vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
          gl_Position = p.xyww;
          gl_Position.z = gl_Position.w * 0.99998;
          gl_PointSize = size * pixelRatio;
        }`,
      fragmentShader: /* glsl */ `
        uniform float intensity; varying vec3 vCol;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vCol * a * a * intensity, 1.0);
        }`,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });
    this.stars = new THREE.Points(geo, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    this.group.add(this.stars);
  }

  set intensity(v: number) {
    this.bandMat.uniforms.intensity.value = v;
    this.starMat.uniforms.intensity.value = v;
  }

  set bandVisible(v: boolean) {
    this.band.visible = v;
  }

  setPixelRatio(pr: number): void {
    this.starMat.uniforms.pixelRatio.value = pr;
  }

  setTint(c: THREE.Color): void {
    (this.bandMat.uniforms.tint.value as THREE.Color).copy(c);
  }
}
