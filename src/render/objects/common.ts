import * as THREE from 'three';

let glowTex: THREE.Texture | null = null;
let ringTex: THREE.Texture | null = null;
let softTex: THREE.Texture | null = null;

/** Texture radiale de halo lumineux (générée une fois). */
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.08, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.25)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  // aigrettes de diffraction discrètes
  g.globalCompositeOperation = 'lighter';
  for (const a of [0, Math.PI / 2]) {
    g.save();
    g.translate(s / 2, s / 2);
    g.rotate(a);
    const lg = g.createLinearGradient(-s / 2, 0, s / 2, 0);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg;
    g.fillRect(-s / 2, -1.2, s, 2.4);
    g.restore();
  }
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

export function softTexture(): THREE.Texture {
  if (softTex) return softTex;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.4)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  softTex = new THREE.CanvasTexture(c);
  return softTex;
}

/** Anneau de sélection. */
export function ringTexture(): THREE.Texture {
  if (ringTex) return ringTex;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(140,220,255,0.95)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(s / 2, s / 2, s / 2 - 6, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = 'rgba(140,220,255,0.5)';
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    g.beginPath();
    g.moveTo(s / 2 + Math.cos(a) * (s / 2 - 2), s / 2 + Math.sin(a) * (s / 2 - 2));
    g.lineTo(s / 2 + Math.cos(a) * (s / 2 - 16), s / 2 + Math.sin(a) * (s / 2 - 16));
    g.stroke();
  }
  ringTex = new THREE.CanvasTexture(c);
  return ringTex;
}

/** Vertex shader standard pour les ShaderMaterial avec tampon de profondeur logarithmique. */
export const LOGDEPTH_VERT_HEAD = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
`;
export const LOGDEPTH_VERT_MAIN = /* glsl */ `
#include <logdepthbuf_vertex>
`;
export const LOGDEPTH_FRAG_HEAD = /* glsl */ `
#include <logdepthbuf_pars_fragment>
`;
export const LOGDEPTH_FRAG_MAIN = /* glsl */ `
#include <logdepthbuf_fragment>
`;

/** Libère récursivement géométries et matériaux. */
export function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
