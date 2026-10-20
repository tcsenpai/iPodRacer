// Procedural PBR texture sets for the podracer, generated once and shared by every pod. Livery colours are
// not baked in: the maps carry paint coverage masks and the material shader applies each pod's colours, so
// six pods cost one set of textures instead of six. Data textures (not canvases) because the paint mask
// lives in the alpha channel too, and canvas premultiplication would destroy the RGB under low alpha.
import * as THREE from 'three';
import { hash2, mulberry32, smoothstep } from '../core/rng';

const S = 1024;

export interface PodTextureSet {
  /** Bare-metal albedo (sRGB): panel tones, seam grime, rivet heads, heat-tempered metal. */
  map: THREE.DataTexture;
  /** Paint coverage (linear): R lacquer tint, G primary paint, B trim paint (all after wear), A grime multiplier. */
  paint: THREE.DataTexture;
  /** Tangent-space normals: panel seams, rivets, hatches, dents, hammer marks. */
  normal: THREE.DataTexture;
  /** R scorch noise (damage threshold), G roughness, B metalness: three reads G/B for roughness/metalness maps. */
  orm: THREE.DataTexture;
}

/** Surface-specific layout; panels, rivets, dents and wear are shared logic. u wraps around, v runs along. */
export interface SurfaceRecipe {
  seed: number;
  /** Panel row seams along v, ascending, starting at 0 and ending at 1. */
  rows: readonly number[];
  /** Panels around the circumference in every row. */
  columns: number;
  /** v below which the surface is unpainted dark interior (engine intake throat); 0 for none. */
  interior: number;
  /**
   * Layout at (u, v) into out: [0..2] paint coverage before wear (lacquer tint, primary paint, trim paint),
   * [3] soot base and [4] soot gain on a 0..1 streak noise stretched along v, [5] heat temper 0..1 on bare
   * metal. Sampled once per 4 texels along u (it must vary smoothly or in straight edges along u).
   */
  layout(u: number, v: number, out: Float32Array): void;
}

/** Tileable fractal value noise over an S x S grid, stretched to [0, 1]. */
function fbm(rng: () => number, periods: readonly number[]): Float32Array {
  const out = new Float32Array(S * S);
  periods.forEach((P, o) => {
    const amp = 1 / (o + 1);
    const lat = new Float32Array(P * P);
    for (let i = 0; i < lat.length; i++) lat[i] = rng();
    const k = P / S;
    for (let y = 0; y < S; y++) {
      const fy = y * k;
      const y0 = Math.floor(fy);
      let ty = fy - y0;
      ty = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % P) * P;
      const r1 = ((y0 + 1) % P) * P;
      for (let x = 0; x < S; x++) {
        const fx = x * k;
        const x0 = Math.floor(fx);
        let tx = fx - x0;
        tx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % P;
        const c1 = (x0 + 1) % P;
        const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * tx;
        const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * tx;
        out[y * S + x] += (a + (b - a) * ty) * amp;
      }
    }
  });
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < out.length; i++) {
    lo = Math.min(lo, out[i]);
    hi = Math.max(hi, out[i]);
  }
  const inv = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * inv;
  return out;
}

function dataTexture(data: Uint8Array, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Rows are written v-ascending, so no flip; u wraps around the lathe seam.
  t.flipY = false;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.userData.shared = true;
  t.needsUpdate = true;
  return t;
}

// Temper colours of steel by temperature, flattened [t, r, g, b] stops: cold, straw, bronze-purple, blue, oxide.
const TEMPER = new Float32Array([0, 0.72, 0.73, 0.75, 0.22, 0.8, 0.66, 0.4, 0.42, 0.58, 0.36, 0.44, 0.62, 0.3, 0.38, 0.64, 0.82, 0.22, 0.26, 0.36, 1, 0.15, 0.16, 0.19]);

interface NoiseFields {
  /** Broad blotches (dents, macro grime). */
  macro: Float32Array;
  /** Mid-frequency (wear patches, streaks, scorch). */
  mid: Float32Array;
  /** Fine grain (hammer marks, chips, brushed roughness). */
  fine: Float32Array;
}

/**
 * Paints every recipe at S x S. The noise fields are computed once and shared by all sets: they are the
 * slowest part, and the surfaces never sit side by side where a repeated pattern could be noticed.
 */
export function paintSurfaces(recipes: readonly SurfaceRecipe[]): PodTextureSet[] {
  const rng = mulberry32(0x9e3779b9);
  const noise: NoiseFields = { macro: fbm(rng, [3, 6, 12]), mid: fbm(rng, [8, 16, 32, 64]), fine: fbm(rng, [96, 192, 384]) };
  return recipes.map((r) => paintSurface(r, noise));
}

function paintSurface(r: SurfaceRecipe, { macro, mid, fine }: NoiseFields): PodTextureSet {
  const height = new Float32Array(S * S);
  const albedo = new Uint8Array(S * S * 4);
  const paint = new Uint8Array(S * S * 4);
  const orm = new Uint8Array(S * S * 4);
  const normal = new Uint8Array(S * S * 4);
  // Clamped views do the 0..255 clamping and rounding on store.
  const albedoC = new Uint8ClampedArray(albedo.buffer);
  const paintC = new Uint8ClampedArray(paint.buffer);
  const ormC = new Uint8ClampedArray(orm.buffer);
  const normalC = new Uint8ClampedArray(normal.buffer);

  // Row lookup: panel band index and distance (px) to the nearest row seam.
  const rowBand = new Int32Array(S);
  const rowDist = new Float32Array(S);
  for (let y = 0, b = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    while (b < r.rows.length - 2 && v >= r.rows[b + 1]) b++;
    rowBand[y] = b;
    rowDist[y] = Math.min(v - r.rows[b], r.rows[b + 1] - v) * S;
  }
  const pw = S / r.columns;
  const cov = new Float32Array(3);
  const lay = new Float32Array(6);
  const colHash = new Float32Array(r.columns);

  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    const b = rowBand[y];
    const dv = rowDist[y];
    const off = hash2(b, 7, r.seed) * pw; // staggered panel columns per row
    for (let c = 0; c < r.columns; c++) colHash[c] = hash2(b, c, r.seed + 1);
    const streakRow = Math.floor(y * 0.06) * S; // mid noise stretched ~16x along v
    const interior = v < r.interior;
    const ry = (y % 12) - 5.5;
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if ((x & 3) === 0) r.layout((x + 2) / S, v, lay);
      const px = (x + off) % pw;
      const du = Math.min(px, pw - px);
      const ph = colHash[Math.floor((x + off) / pw) % r.columns];
      const d = Math.min(du, dv);
      const groove = Math.max(0, 1 - d / 1.6);
      const mi = mid[i];
      const fi = fine[i];

      // Height: raised panels with soft bevels, V-groove seams, domed rivets along both seam directions,
      // inset access hatches on some panels, broad dents and fine hammer marks.
      let h = 0.25 * smoothstep(0, 5, d) - 0.9 * groove;
      // Squared distance to the nearest rivet centre (every 12 px, 5 px in from the seams).
      const rx = (x % 12) - 5.5;
      const rd2 = Math.min((dv - 5) * (dv - 5) + rx * rx, (du - 5) * (du - 5) + ry * ry);
      const rivet = rd2 < 5.29 ? Math.sqrt(1 - rd2 / 5.29) : 0;
      h += rivet * 0.7;
      if (ph < 0.18) {
        const hd = Math.abs(d - 11);
        if (hd < 1.4) h -= 0.6 * (1 - hd / 1.4);
      }
      h -= 1.4 * smoothstep(0.68, 0.95, macro[i]) * (0.5 + 0.5 * mi);
      h += (fi - 0.5) * 0.08;
      height[i] = interior ? h * 0.3 : h;

      // Paint, chipped where edges and rivets take knocks, plus scattered scratches.
      if (interior) {
        cov[0] = cov[1] = cov[2] = 0;
      } else {
        cov[0] = lay[0];
        cov[1] = lay[1];
        cov[2] = lay[2];
        const edge = 1 - smoothstep(0, 8, d) + rivet * 0.6;
        const keep = 1 - smoothstep(0.82, 0.88, fi * 0.72 + mi * 0.28 + edge * 0.42);
        cov[0] *= keep;
        cov[1] *= keep;
        cov[2] *= keep;
      }
      const soot = interior ? 0.3 : lay[3] + lay[4] * mid[streakRow + x];
      const seam = 1 - smoothstep(0, 3, d);
      const grime = Math.min(0.88, soot + seam * 0.35 + Math.max(0, macro[i] - 0.62) * 0.4);
      const prim = Math.max(cov[1], cov[2]);

      // Bare-metal albedo with per-panel tone; temper colours where the metal runs hot.
      let ar = 0.72;
      let ag = 0.73;
      let ab = 0.75;
      const heat = interior ? 0 : lay[5] * (1 - Math.max(cov[0], prim));
      if (heat > 0) {
        const t = Math.min(1, Math.max(0, heat + (mi - 0.5) * 0.18));
        let k = 4;
        while (k < TEMPER.length - 4 && TEMPER[k] < t) k += 4;
        const f = (t - TEMPER[k - 4]) / (TEMPER[k] - TEMPER[k - 4]);
        ar = TEMPER[k - 3] + (TEMPER[k + 1] - TEMPER[k - 3]) * f;
        ag = TEMPER[k - 2] + (TEMPER[k + 2] - TEMPER[k - 2]) * f;
        ab = TEMPER[k - 1] + (TEMPER[k + 3] - TEMPER[k - 1]) * f;
      } else if (interior) {
        ar = 0.2;
        ag = 0.2;
        ab = 0.22;
      }
      const tone = 0.93 + ph * 0.1 + (mi - 0.5) * 0.06 + (fi - 0.5) * 0.05;
      const shade = 255 * tone * (1 - 0.45 * groove) * (1 + rivet * 0.08);
      const o = i * 4;
      albedoC[o] = ar * shade;
      albedoC[o + 1] = ag * shade;
      albedoC[o + 2] = ab * shade;
      albedo[o + 3] = 255;
      paintC[o] = cov[0] * 255;
      paintC[o + 1] = cov[1] * 255;
      paintC[o + 2] = cov[2] * 255;
      paintC[o + 3] = (1 - grime) * 255;

      // Roughness / metalness: brushed bare metal, glossy lacquer, satin paint, rough seams and soot.
      let rough = 0.34 + (fi - 0.5) * 0.16;
      rough += (0.28 - rough) * cov[0];
      rough += (0.45 - rough) * prim;
      rough += (1 - smoothstep(0, 2, d)) * 0.25;
      rough += (0.88 - rough) * grime;
      rough += (0.3 - rough) * heat * 0.5;
      let metal = 1;
      metal += (0.6 - metal) * cov[0];
      metal += (0.08 - metal) * prim;
      metal *= 1 - grime * 0.7;
      ormC[o] = (0.65 * mi + 0.35 * fi) * 255;
      ormC[o + 1] = (interior ? 0.55 : rough) * 255;
      ormC[o + 2] = (interior ? 0.7 : metal) * 255;
      orm[o + 3] = 255;
    }
  }

  // Sobel normals; u wraps, v clamps (the lathe ends are not continuous).
  const strength = 0.35;
  for (let y = 0; y < S; y++) {
    const ym = Math.max(0, y - 1) * S;
    const y0 = y * S;
    const yp = Math.min(S - 1, y + 1) * S;
    for (let x = 0; x < S; x++) {
      const xm = x === 0 ? S - 1 : x - 1;
      const xp = x === S - 1 ? 0 : x + 1;
      const dx = height[ym + xp] + 2 * height[y0 + xp] + height[yp + xp] - (height[ym + xm] + 2 * height[y0 + xm] + height[yp + xm]);
      const dy = height[yp + xm] + 2 * height[yp + x] + height[yp + xp] - (height[ym + xm] + 2 * height[ym + x] + height[ym + xp]);
      const nx = -dx * strength;
      const ny = -dy * strength;
      const l = 127.5 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y0 + x) * 4;
      normalC[o] = nx * l + 127.5;
      normalC[o + 1] = ny * l + 127.5;
      normalC[o + 2] = l + 127.5;
      normal[o + 3] = 255;
    }
  }

  return { map: dataTexture(albedo, true), paint: dataTexture(paint, false), normal: dataTexture(normal, false), orm: dataTexture(orm, false) };
}

/** Exhaust plume ramp (shared): bright at the nozzle (v = 0) fading to the tip, with faint shock bands. */
export function plumeTexture(): THREE.DataTexture {
  const W = 4;
  const H = 128;
  const d = new Uint8Array(W * H * 4);
  const dc = new Uint8ClampedArray(d.buffer);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    const f = 255 * Math.pow(1 - v, 1.6) * (1 + 0.22 * Math.sin(v * 42) * (1 - v)) * smoothstep(0, 0.04, v + 0.02);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      dc[o] = dc[o + 1] = dc[o + 2] = dc[o + 3] = f;
    }
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.flipY = false;
  t.wrapS = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.userData.shared = true;
  t.needsUpdate = true;
  return t;
}
