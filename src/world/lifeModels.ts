// Building blocks for the living world (src/world/life.ts): a geometry merger that bakes primitives into
// one vertex-coloured mesh per material, the canvas textures, the patched materials (wind-blown cloth,
// cheering crowd, walking banthas) and the procedural models themselves.
// Everything animated moves in the vertex shader of a MeshStandardMaterial patched through
// onBeforeCompile, so lights, shadows, fog and the logarithmic depth chunks stay three's own.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng, clamp } from '../core/rng';
import { noise2 } from './noise';

// ---------------------------------------------------------------------------------------------------
// Geometry merging

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Shared scratch transform: translate, then yaw (ry), pitch (rx), roll (rz), scale. Callers consume the
 * result immediately (Builder copies it), so one module-level matrix is enough at build time.
 */
export function tr(x: number, y: number, z: number, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0): THREE.Matrix4 {
  _e.set(rx, ry, rz);
  return _m.compose(_v.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
}

const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Thin open cylinder from a to b (cables, poles, stays) added to `b` with its current frame. */
export function rod(b: Builder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, color: THREE.ColorRepresentation): void {
  _d.set(bx - ax, by - ay, bz - az);
  const len = _d.length();
  _q.setFromUnitVectors(_up, _d.divideScalar(len));
  _m.compose(_c.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _s.set(1, len, 1));
  b.add(new THREE.CylinderGeometry(r, r, 1, 5, 1, true), color, _m);
}

/** Axis-aligned box from min/max corners (the natural way to lay out masonry). */
export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/**
 * Accumulates primitives (transformed by a structure frame times a part transform), paints each with a
 * flat vertex colour and fills optional custom attributes, then merges everything into one geometry:
 * one draw call per material however many pieces a cluster has.
 */
export class Builder {
  private parts: THREE.BufferGeometry[] = [];
  private frame = new THREE.Matrix4();
  private full = new THREE.Matrix4();
  private nrm = new THREE.Matrix3();
  private col = new THREE.Color();

  /** `extras`: custom attribute name to item size; `keepUV`: parts carry their own uv. */
  constructor(
    private readonly extras: Record<string, number> = {},
    private readonly keepUV = false,
  ) {}

  setFrame(m: THREE.Matrix4): void {
    this.frame.copy(m);
  }

  resetFrame(): void {
    this.frame.identity();
  }

  /** Add `src` (consumed) with flat `color`, placed by frame x `local`; `consts` fill missing extras. */
  add(src: THREE.BufferGeometry, color: THREE.ColorRepresentation, local?: THREE.Matrix4, consts?: Record<string, readonly number[]>): void {
    const g = src.index ? src.toNonIndexed() : src;
    if (g !== src) src.dispose();
    if (!this.keepUV) g.deleteAttribute('uv');
    this.full.copy(this.frame);
    if (local) this.full.multiply(local);
    g.applyMatrix4(this.full);
    const flow = g.getAttribute('aFlow');
    if (flow) flow.applyNormalMatrix(this.nrm.getNormalMatrix(this.full));
    const n = g.getAttribute('position').count;
    this.col.set(color);
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([this.col.r, this.col.g, this.col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    for (const name in this.extras) {
      if (g.hasAttribute(name)) continue;
      const size = this.extras[name];
      const a = new Float32Array(n * size);
      const v = consts?.[name];
      if (v) for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) a[i * size + k] = v[k];
      g.setAttribute(name, new THREE.BufferAttribute(a, size));
    }
    g.clearGroups();
    this.parts.push(g);
  }

  build(): THREE.BufferGeometry {
    const geo = mergeGeometries(this.parts);
    if (!geo) throw new Error('life: incompatible geometry parts');
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return geo;
  }
}

/**
 * Box-projected uv (metres / scale) chosen per triangle from its face normal: masonry and hull plates get
 * a texel density that matches their real size without hand-authored unwraps.
 */
export function boxUV(geo: THREE.BufferGeometry, scale: number): void {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    c.sub(a);
    b.sub(a).cross(c);
    const ax = Math.abs(b.x);
    const ay = Math.abs(b.y);
    const az = Math.abs(b.z);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k);
      const y = pos.getY(i + k);
      const z = pos.getZ(i + k);
      const [s, t] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
      uv[(i + k) * 2] = s / scale;
      uv[(i + k) * 2 + 1] = t / scale;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// ---------------------------------------------------------------------------------------------------
// Textures

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finishTexture(c: HTMLCanvasElement, repeat: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Tileable greyscale plaster: blotchy trowel marks and hairline cracks (multiplied over vertex colours). */
export function plasterTexture(): THREE.CanvasTexture {
  const N = 256;
  const [c, g] = canvas(N, N);
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const blot = noise2((x / N) * 6, (y / N) * 6, 3, 6);
      const fine = noise2((x / N) * 48, (y / N) * 48, 5, 48);
      const v = clamp(0.86 + (blot - 0.5) * 0.2 + (fine - 0.5) * 0.1, 0, 1) * 255;
      const i = (y * N + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v * 0.98;
      img.data[i + 2] = v * 0.95;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Cracks: short random walks, drawn at the 9 wrap offsets so the texture still tiles.
  const rng = new Rng(404);
  g.strokeStyle = 'rgba(60,45,30,0.45)';
  g.lineWidth = 1;
  for (let k = 0; k < 14; k++) {
    const pts: number[] = [rng.range(0, N), rng.range(0, N)];
    let ang = rng.range(0, Math.PI * 2);
    for (let s = 0; s < 8; s++) {
      ang += rng.range(-0.8, 0.8);
      pts.push(pts[pts.length - 2] + Math.cos(ang) * 6, pts[pts.length - 1] + Math.sin(ang) * 6);
    }
    for (let ox = -N; ox <= N; ox += N) {
      for (let oy = -N; oy <= N; oy += N) {
        g.beginPath();
        g.moveTo(pts[0] + ox, pts[1] + oy);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] + ox, pts[i + 1] + oy);
        g.stroke();
      }
    }
  }
  return finishTexture(c, true);
}

/** Tileable riveted hull plating with rust streaks (sandcrawler). */
export function hullTexture(): THREE.CanvasTexture {
  const N = 256;
  const [c, g] = canvas(N, N);
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const streak = noise2((x / N) * 32, (y / N) * 3, 8, 32);
      const blot = noise2((x / N) * 8, (y / N) * 8, 9, 8);
      const seam = x % 64 < 2 || y % 96 < 2 ? 0.55 : 1;
      const rivet = (x % 64 === 5 || x % 64 === 59) && y % 12 === 6 ? 1.25 : 1;
      const v = clamp((0.8 + (streak - 0.5) * 0.3 + (blot - 0.5) * 0.2) * seam * rivet, 0, 1) * 255;
      const rust = clamp((blot - 0.45) * 2, 0, 1);
      const i = (y * N + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v * (1 - rust * 0.25);
      img.data[i + 2] = v * (1 - rust * 0.45);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return finishTexture(c, true);
}

/** Atlas regions (uv rect: u0, v0, u1, v1 with v up, as three samples a flipped canvas). */
export type UVRect = readonly [number, number, number, number];
const ATLAS_W = 1024;
const ATLAS_H = 1024;
const px = (x0: number, y0: number, x1: number, y1: number): UVRect => [x0 / ATLAS_W, 1 - y1 / ATLAS_H, x1 / ATLAS_W, 1 - y0 / ATLAS_H];

export const ATLAS = {
  stripes: px(0, 0, 256, 512),
  banners: [px(256, 0, 384, 512), px(384, 0, 512, 512), px(512, 0, 640, 512), px(640, 0, 768, 512), px(768, 0, 896, 512)],
  flags: [px(896, 0, 1024, 128), px(896, 128, 1024, 256), px(896, 256, 1024, 384), px(896, 384, 1024, 512)],
  wide: px(0, 512, 896, 768),
  plain: px(904, 520, 1016, 632),
  rag: px(0, 768, 1024, 1024),
} as const;

/** Pseudo-Aurebesh glyph: a few strokes on a 3x4 grid (no real script, no i18n concerns). */
function glyph(g: CanvasRenderingContext2D, rng: Rng, x: number, y: number, s: number): void {
  g.beginPath();
  const n = rng.int(2, 4);
  for (let k = 0; k < n; k++) {
    g.moveTo(x + rng.int(0, 2) * s * 0.5, y + rng.int(0, 3) * s * 0.4);
    g.lineTo(x + rng.int(0, 2) * s * 0.5, y + rng.int(0, 3) * s * 0.4);
  }
  g.stroke();
}

/** All cloth on one canvas: awning stripes, five race banners, four flags, a wide banner, Tusken rags. */
export function clothAtlas(): THREE.CanvasTexture {
  const [c, g] = canvas(ATLAS_W, ATLAS_H);
  const rng = new Rng(9);
  // Awning stripes.
  const stripe = ['#d9c8a2', '#9c4a2a', '#d9c8a2', '#b8893f'];
  for (let i = 0; i < 8; i++) {
    g.fillStyle = stripe[i % 4];
    g.fillRect(i * 32, 0, 32, 512);
  }
  // Banners: field, trim, an emblem and a column of glyphs, fringe at the bottom.
  const fields = ['#7d2a1d', '#2c4a6e', '#c39436', '#4b5e2c', '#5b2f60'];
  const trims = ['#e0c27a', '#d8d0bc', '#5a2a18', '#d8c07c', '#e3b25a'];
  for (let b = 0; b < 5; b++) {
    const x = 256 + b * 128;
    g.fillStyle = fields[b];
    g.fillRect(x, 0, 128, 512);
    g.fillStyle = trims[b];
    g.fillRect(x + 6, 0, 8, 470);
    g.fillRect(x + 114, 0, 8, 470);
    g.strokeStyle = trims[b];
    g.lineWidth = 7;
    g.beginPath();
    g.arc(x + 64, 110, 38, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 5;
    g.beginPath();
    if (b % 2) {
      g.moveTo(x + 40, 125);
      g.lineTo(x + 64, 85);
      g.lineTo(x + 88, 125);
    } else {
      g.arc(x + 64, 110, 16, 0, Math.PI * 2);
    }
    g.stroke();
    g.lineWidth = 4;
    for (let k = 0; k < 6; k++) glyph(g, rng, x + 50, 180 + k * 44, 30);
    for (let k = 0; k < 16; k++) {
      g.fillStyle = k % 2 ? trims[b] : fields[b];
      g.fillRect(x + k * 8, 470, 8, 42);
    }
  }
  // Flags: two-tone fields with a stripe or a diamond.
  const flagCols: [string, string][] = [
    ['#a3301f', '#e8d6a8'],
    ['#26507a', '#e2b44a'],
    ['#e0ad3c', '#5a2216'],
    ['#3d6a3a', '#ead9b0'],
  ];
  for (let f = 0; f < 4; f++) {
    const y = f * 128;
    g.fillStyle = flagCols[f][0];
    g.fillRect(896, y, 128, 128);
    g.fillStyle = flagCols[f][1];
    if (f % 2) g.fillRect(896, y + 50, 128, 28);
    else {
      g.beginPath();
      g.moveTo(960, y + 22);
      g.lineTo(1000, y + 64);
      g.lineTo(960, y + 106);
      g.lineTo(920, y + 64);
      g.fill();
    }
  }
  // Wide race banner: checker bands top and bottom, glyph line, twin emblems.
  g.fillStyle = '#6e2318';
  g.fillRect(0, 512, 896, 256);
  for (let i = 0; i < 56; i++) {
    for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? '#1b1410' : '#efe4cc';
      g.fillRect(i * 16, 512 + j * 16, 16, 16);
      g.fillRect(i * 16, 736 - j * 16, 16, 16);
    }
  }
  g.strokeStyle = '#efd28a';
  g.lineWidth = 8;
  for (const ex of [90, 806]) {
    g.beginPath();
    g.arc(ex, 640, 52, 0, Math.PI * 2);
    g.stroke();
  }
  g.lineWidth = 7;
  for (let k = 0; k < 14; k++) glyph(g, rng, 180 + k * 40, 605, 34);
  // Plain patch for solid vertex-coloured parts that share this material.
  g.fillStyle = '#d4d4d4';
  g.fillRect(896, 512, 128, 128);
  // Tusken rags: wrapped strips of dyed hide in uneven bands.
  for (let y = 768; y < 1024; y += 4) {
    const t = noise2(y / 16, 0.5, 71);
    const l = 120 + t * 70;
    g.fillStyle = `rgb(${l | 0},${(l * 0.86) | 0},${(l * 0.68) | 0})`;
    g.fillRect(0, y, 1024, 4);
  }
  g.globalAlpha = 0.35;
  for (let k = 0; k < 600; k++) {
    g.fillStyle = rng.chance(0.5) ? '#3b2a1c' : '#d8c3a0';
    g.fillRect(rng.range(0, 1024), rng.range(768, 1020), rng.range(4, 40), rng.range(1, 3));
  }
  g.globalAlpha = 1;
  return finishTexture(c, false);
}

/** Remap a primitive's 0..1 uv into an atlas rect. */
export function remapUV(geo: THREE.BufferGeometry, r: UVRect): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
  return geo;
}

// ---------------------------------------------------------------------------------------------------
// Materials

export interface LifeUniforms {
  uTime: { value: number };
  uSurge: { value: number };
}

interface Patch {
  header: string;
  color?: string;
  normal?: string;
  vertex?: string;
}

/** Inject vertex code into a standard material; `key` keeps three's program cache from mixing patches. */
function patch(mat: THREE.MeshStandardMaterial, key: string, uniforms: LifeUniforms, p: Patch): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uSurge = uniforms.uSurge;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform float uSurge;\n${p.header}`)
      .replace('#include <color_vertex>', `#include <color_vertex>\n${p.color ?? ''}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${p.normal ?? ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${p.vertex ?? ''}`);
  };
  mat.customProgramCacheKey = () => key;
}

export function adobeMaterial(): THREE.MeshStandardMaterial {
  const map = plasterTexture();
  return new THREE.MeshStandardMaterial({ vertexColors: true, map, bumpMap: map, bumpScale: 1.2, roughness: 0.94, metalness: 0 });
}

export function metalMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.6 });
}

export function hullMaterial(): THREE.MeshStandardMaterial {
  const map = hullTexture();
  return new THREE.MeshStandardMaterial({ vertexColors: true, map, bumpMap: map, bumpScale: 0.8, roughness: 0.7, metalness: 0.35 });
}

/**
 * Cloth: each vertex knows how far it is from its pinned edge (aCloth.x, 0..1), the cloth length along the
 * flow (aCloth.y, m), the ripple amplitude (aCloth.z, m) and the flow direction (aFlow). A travelling
 * wave displaces it along the cloth normal; the normal is tilted by the wave's slope so the ripples also
 * read in the lighting, not only in the silhouette.
 */
export function clothMaterial(uniforms: LifeUniforms, map: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  patch(mat, 'life-cloth', uniforms, {
    header: 'attribute vec3 aCloth;\nattribute vec3 aFlow;',
    normal: /* glsl */ `
      float clothK = 7.5;
      float clothPh = uTime * 3.4 - aCloth.x * clothK + dot(position.xz, vec2(0.11, 0.07));
      float clothA = aCloth.z * aCloth.x;
      float clothD = clothA * (sin(clothPh) + 0.35 * sin(clothPh * 2.3 + 1.7));
      float clothSlope = (aCloth.z * sin(clothPh) - clothA * clothK * cos(clothPh)) / max(aCloth.y, 0.5);
      vec3 clothN = normal;
      objectNormal = normalize(objectNormal - aFlow * clothSlope);`,
    vertex: 'transformed += clothN * clothD;',
  });
  return mat;
}

/**
 * Crowd: aPart 0 body, 1 head, 2 arms; aSeed per instance. Fans bob all the time, a few cheer in shifting
 * groups, and uSurge (a pod passing the stands) makes most of them jump with their arms up.
 */
export function crowdMaterial(uniforms: LifeUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  patch(mat, 'life-crowd', uniforms, {
    header: 'attribute float aPart;\nattribute float aSeed;',
    color: /* glsl */ `
      if (aPart > 0.5 && aPart < 1.5) {
        float skinK = fract(aSeed * 7.31);
        vColor.rgb = mix(vec3(0.36, 0.22, 0.14), vec3(0.82, 0.62, 0.46), skinK);
        if (fract(aSeed * 13.7) > 0.86) vColor.rgb = mix(vec3(0.28, 0.42, 0.32), vec3(0.42, 0.38, 0.58), skinK);
      }`,
    normal: /* glsl */ `
      float crowdT = uTime * (1.6 + 1.8 * fract(aSeed * 9.13)) + aSeed * 40.0;
      float crowdIdle = step(0.9, fract(aSeed * 5.17 + floor(uTime * 0.25 + aSeed * 3.0) * 0.618));
      float crowdCheer = clamp(uSurge * (0.55 + 0.7 * fract(aSeed * 3.71)) + crowdIdle * 0.6, 0.0, 1.0);
      float crowdSide = position.x > 0.0 ? 1.0 : -1.0;
      float crowdArm = aPart > 1.5 ? crowdSide * crowdCheer * (2.3 + 0.35 * sin(crowdT * 2.7)) : 0.0;
      float crowdC = cos(crowdArm);
      float crowdS = sin(crowdArm);
      objectNormal.xy = vec2(crowdC * objectNormal.x - crowdS * objectNormal.y, crowdS * objectNormal.x + crowdC * objectNormal.y);`,
    vertex: /* glsl */ `
      if (aPart > 1.5) {
        vec2 crowdP = transformed.xy - vec2(crowdSide * 0.27, 0.72);
        transformed.xy = vec2(crowdC * crowdP.x - crowdS * crowdP.y, crowdS * crowdP.x + crowdC * crowdP.y) + vec2(crowdSide * 0.27, 0.72);
      }
      transformed.y += sin(crowdT) * 0.025 + max(0.0, sin(crowdT * 2.2)) * 0.32 * crowdCheer;`,
  });
  return mat;
}

/**
 * Banthas: aPart 0 body, 1/2 the two diagonal leg pairs, 3 head, 4 horns. Per instance aAnim = (gait
 * phase, gait 0..1, graze 0..1), integrated on the CPU so speed changes never jump the phase.
 */
export function banthaMaterial(uniforms: LifeUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  patch(mat, 'life-bantha', uniforms, {
    header: 'attribute float aPart;\nattribute vec3 aAnim;',
    color: 'if (aPart > 3.5) vColor.rgb = vec3(0.7, 0.64, 0.52);',
    normal: /* glsl */ `
      float bHead = aPart > 2.5 ? 1.0 : 0.0;
      float bNod = bHead * (aAnim.z * (0.7 + 0.1 * sin(uTime * 0.9 + aAnim.x)) - aAnim.y * 0.1 * sin(aAnim.x * 2.0));
      float bC = cos(bNod);
      float bS = sin(bNod);
      objectNormal.yz = vec2(bC * objectNormal.y - bS * objectNormal.z, bS * objectNormal.y + bC * objectNormal.z);`,
    vertex: /* glsl */ `
      if (bHead > 0.5) {
        vec2 bP = transformed.yz - vec2(2.75, 1.9);
        transformed.yz = vec2(bC * bP.x - bS * bP.y, bS * bP.x + bC * bP.y) + vec2(2.75, 1.9);
      }
      float bLegs = step(0.5, aPart) * step(aPart, 2.5);
      float bPh = aAnim.x + (aPart > 1.5 ? 3.14159 : 0.0);
      float bReach = clamp((1.9 - transformed.y) / 1.9, 0.0, 1.0) * bLegs;
      transformed.z += sin(bPh) * aAnim.y * 0.75 * bReach;
      transformed.y += max(0.0, -cos(bPh)) * aAnim.y * 0.3 * bReach;
      transformed.y += abs(sin(aAnim.x)) * aAnim.y * 0.12 * (1.0 - bLegs);`,
  });
  return mat;
}

// ---------------------------------------------------------------------------------------------------
// Cloth pieces

/** How a cloth piece is held: by its top edge, its left edge (flags) or all round (awnings). */
export type Pin = 'top' | 'left' | 'edges';

/** Subdivided cloth rectangle in the XY plane (normal +Z), centred on x, top edge at y = 0. */
export function clothQuad(w: number, h: number, sw: number, sh: number, rect: UVRect, pin: Pin, amp: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, sw, sh);
  g.translate(pin === 'left' ? w / 2 : 0, -h / 2, 0);
  remapUV(g, rect);
  const pos = g.getAttribute('position');
  const cloth = new Float32Array(pos.count * 3);
  const flow = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const fx = pin === 'left' ? pos.getX(i) / w : pos.getX(i) / w + 0.5;
    const fy = -pos.getY(i) / h;
    const s = pin === 'top' ? fy : pin === 'left' ? fx : Math.sin(Math.PI * fx) * Math.sin(Math.PI * fy);
    cloth.set([s, pin === 'left' ? w : h, amp], i * 3);
    flow.set(pin === 'left' ? [1, 0, 0] : [0, -1, 0], i * 3);
  }
  g.setAttribute('aCloth', new THREE.BufferAttribute(cloth, 3));
  g.setAttribute('aFlow', new THREE.BufferAttribute(flow, 3));
  return g;
}

/** Triangular pennant hanging from its top edge (width w, drop h), built directly at a, b on a cable. */
export function pennant(ax: number, ay: number, az: number, bx: number, by: number, bz: number, h: number, rect: UVRect, amp: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  const my = (ay + by) / 2 - h;
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([ax, ay, az, mx, my, mz, bx, by, bz]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([rect[0], rect[3], (rect[0] + rect[2]) / 2, rect[1], rect[2], rect[3]]), 2));
  g.setAttribute('aCloth', new THREE.BufferAttribute(new Float32Array([0, h, amp, 1, h, amp, 0, h, amp]), 3));
  g.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]), 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------------
// Models (local frames: +Z forward, origin on the ground)

/** Seated fan facing +Z: torso, folded legs, head, two arms hanging from the shoulders at (±0.27, 0.72). */
export function spectatorGeometry(): THREE.BufferGeometry {
  const b = new Builder({ aPart: 1 });
  b.add(new THREE.CylinderGeometry(0.19, 0.25, 0.72, 6), 0xffffff, tr(0, 0.38, 0), { aPart: [0] });
  b.add(box(-0.2, 0.0, 0.05, 0.2, 0.2, 0.5), 0xb8b0a4, undefined, { aPart: [0] });
  b.add(new THREE.IcosahedronGeometry(0.15, 0), 0xffffff, tr(0, 0.92, 0.02, 0, 1, 1.12, 1), { aPart: [1] });
  for (const s of [-1, 1]) b.add(box(s * 0.27 - 0.06, 0.26, -0.06, s * 0.27 + 0.06, 0.74, 0.06), 0xffffff, undefined, { aPart: [2] });
  return b.build();
}

/** Bantha facing +Z, about 3.6 m at the hump: shaggy capsule body, pillar legs, heavy head, spiral horns. */
export function banthaGeometry(): THREE.BufferGeometry {
  const b = new Builder({ aPart: 1 });
  const fur = 0xffffff;
  b.add(new THREE.CapsuleGeometry(1.25, 2.4, 4, 10), fur, tr(0, 2.55, 0, 0, 1, 1, 1, Math.PI / 2), { aPart: [0] });
  b.add(new THREE.SphereGeometry(1.15, 10, 8), fur, tr(0, 3.25, 0.5, 0, 1, 0.8, 1.3), { aPart: [0] });
  // Shaggy skirt of fur hanging under the belly.
  b.add(new THREE.CylinderGeometry(1.2, 1.45, 1.1, 10, 1, true), 0xd8d0c8, tr(0, 1.9, 0, 0, 1, 1, 1.7), { aPart: [0] });
  b.add(new THREE.ConeGeometry(0.22, 1.6, 6), fur, tr(0, 2.2, -2.6, 0, 1, 1, 1, -2.4), { aPart: [0] });
  const legs: [number, number, number][] = [
    [-0.75, 1.3, 1],
    [0.75, 1.3, 2],
    [-0.75, -1.3, 2],
    [0.75, -1.3, 1],
  ];
  for (const [x, z, part] of legs) b.add(new THREE.CylinderGeometry(0.42, 0.36, 2.0, 8), 0xc8c0b8, tr(x, 1.0, z), { aPart: [part] });
  b.add(new THREE.SphereGeometry(0.78, 10, 8), fur, tr(0, 2.7, 2.6, 0, 0.85, 0.95, 1.15), { aPart: [3] });
  b.add(new THREE.SphereGeometry(0.45, 8, 6), 0xb0a8a0, tr(0, 2.3, 3.25, 0, 0.9, 0.8, 1), { aPart: [3] });
  for (const s of [-1, 1]) {
    b.add(new THREE.TorusGeometry(0.42, 0.12, 5, 12, Math.PI * 1.6), 0xffffff, tr(s * 0.72, 3.05, 2.45, (s * Math.PI) / 2, 1, 1, 1, 0, 0.6), { aPart: [4] });
  }
  return b.build();
}

/** Moisture vaporator: banded lathe tower on a tripod, condenser fins near the top. */
export function vaporatorGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  const prof: [number, number][] = [
    [0.36, 0],
    [0.36, 0.35],
    [0.22, 0.45],
    [0.22, 3.4],
    [0.34, 3.55],
    [0.34, 3.95],
    [0.17, 4.05],
    [0.17, 6.1],
    [0.3, 6.2],
    [0.3, 6.55],
    [0.12, 6.65],
    [0.12, 7.25],
    [0.001, 7.35],
  ];
  b.add(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 10), 0xc4c2bc);
  b.add(new THREE.CylinderGeometry(0.25, 0.25, 0.5, 10), 0x54504a, tr(0, 2.2, 0));
  b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.3, 10), 0x7a3e22, tr(0, 5.2, 0));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    b.add(box(-0.03, -0.9, 0, 0.03, 0.9, 0.55), 0xa8a6a0, tr(Math.sin(a) * 0.15, 5.0, Math.cos(a) * 0.15, a));
    b.add(new THREE.CylinderGeometry(0.06, 0.08, 1.7, 5), 0x6a665e, tr(Math.sin(a) * 0.55, 0.55, Math.cos(a) * 0.55, a, 1, 1, 1, -0.55));
  }
  return b.build();
}

/** Sandcrawler facing +Z (about 60 x 22 x 27 m) into `b`: tapering hull, treads, superstructure. */
export function sandcrawler(b: Builder): void {
  const rust = 0x8a6248;
  const dark = 0x2e2a26;
  const shape = new THREE.Shape();
  const prof: [number, number][] = [
    [-29, 5],
    [26, 5],
    [27, 8],
    [17, 22],
    [9, 26],
    [-23, 26],
    [-29, 20],
  ];
  shape.moveTo(prof[0][0], prof[0][1]);
  for (let i = 1; i < prof.length; i++) shape.lineTo(prof[i][0], prof[i][1]);
  const hull = new THREE.ExtrudeGeometry(shape, { depth: 20, bevelEnabled: false });
  hull.translate(0, 0, -10);
  hull.rotateY(-Math.PI / 2);
  // Taper the sides toward the roof: the crawler's trapezoid cross-section.
  const pos = hull.getAttribute('position');
  for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) * (1 - 0.24 * clamp((pos.getY(i) - 5) / 21, 0, 1)));
  hull.computeVertexNormals();
  b.add(hull, rust);
  // Tread units and their bogie frames.
  for (const x of [-8, 8]) {
    for (const z of [-17, 15]) {
      b.add(box(x - 3, 0, z - 8, x + 3, 4.6, z + 8), dark);
      b.add(box(x - 3.4, 4.2, z - 8.5, x + 3.4, 5.6, z + 8.5), 0x5a4a3c);
      for (let k = -3; k <= 3; k++) b.add(new THREE.CylinderGeometry(1.1, 1.1, 6.2, 10), 0x4a4440, tr(x, 1.6, z + k * 2.2, 0, 1, 1, 1, 0, Math.PI / 2));
    }
  }
  // Front: dark loading mouth with a lowered ramp, window band up on the slant.
  b.add(box(-6, 5.5, 25.5, 6, 11, 26.6), 0x141210);
  b.add(box(-6, -0.4, 0, 6, 0.4, 9), 0x6a5444, tr(0, 2.6, 26, 0, 1, 1, 1, 0.3));
  b.add(box(-7.5, -0.6, -0.3, 7.5, 0.6, 0.3), 0x1a1c20, tr(0, 18.7, 19.75, 0, 1, 1, 1, -0.62));
  // Side plating, roof superstructure, masts.
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const y0 = 8 + (k % 2) * 4;
      // Follow the hull taper so the plates sit flush on the sloping side.
      const hw = 10 * (1 - (0.24 * (y0 + 2 - 5)) / 21);
      b.add(box(-0.4, -2, 0, 0.4, 2, 8), k % 2 ? 0x7a5a44 : 0x6e5040, tr(s * (hw + 0.1), y0 + 2, -24 + k * 10, 0, 1, 1, 1, 0, s * 0.114));
    }
  }
  b.add(box(-6, 26, -20, 6, 31, -6), 0x7e5c46);
  b.add(box(-3, 31, -16, 3, 34, -9), 0x6c5040);
  b.add(box(-3.2, 31.6, -9.1, 3.2, 32.4, -8.8), 0x1a1c20);
  for (const [x, z, h] of [
    [-4, -18, 9],
    [3.5, -12, 6],
    [0, 4, 4],
  ]) {
    b.add(new THREE.CylinderGeometry(0.15, 0.25, h, 6), 0x3a3632, tr(x, 26 + h / 2 + (z < -5 ? 5 : 0), z));
  }
}
