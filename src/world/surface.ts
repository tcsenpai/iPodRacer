// Shared procedural surface for the ground and every rock: a MeshStandardMaterial patched with
// onBeforeCompile, so three's lighting, shadows, fog and logarithmic depth chunks stay untouched and
// only the albedo, roughness and normal are replaced by world-space procedural detail.
// - Rock: strata (world-Y bands warped by noise), vertical joint cracks, chunky + fine bumps.
// - Loose ground (sand, snow, grass, ash): wind ripples at two scales (fbm-warped), grain speckle,
//   glints, patches of cover (grass, moss, ice crust) on flat open ground.
// - Terrain: slope blend ground -> rock (30 to 40 degrees) and a packed track bed from a per-vertex mask.
// Colours and knobs come from the planet's SurfaceTheme (uniforms per material, one shared program).
// All noise is 3D or world-planar, so there is no UV stretching on cliffs (no triplanar seams either),
// and every octave fades out once a pixel covers it, which keeps distant ground from shimmering.
// Also exports a small CPU 3D value noise used to sculpt rock geometry consistently.
import * as THREE from 'three';
import { SUN_DIRECTION } from './sky';
import type { SurfaceTheme } from './theme';

// ---------------------------------------------------------------------------------------------------
// CPU side: 3D value noise for mesh displacement (deterministic, matches nothing on the GPU on purpose:
// geometry noise is coarse, shader noise is the fine layer on top).

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1440670441) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [0,1). */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash3(ix, iy, iz, seed);
  const b = hash3(ix + 1, iy, iz, seed);
  const c = hash3(ix, iy + 1, iz, seed);
  const d = hash3(ix + 1, iy + 1, iz, seed);
  const e = hash3(ix, iy, iz + 1, seed);
  const f = hash3(ix + 1, iy, iz + 1, seed);
  const g = hash3(ix, iy + 1, iz + 1, seed);
  const h = hash3(ix + 1, iy + 1, iz + 1, seed);
  const x0 = a + (b - a) * u;
  const x1 = c + (d - c) * u;
  const x2 = e + (f - e) * u;
  const x3 = g + (h - g) * u;
  const y0 = x0 + (x1 - x0) * v;
  const y1 = x2 + (x3 - x2) * v;
  return y0 + (y1 - y0) * w;
}

// ---------------------------------------------------------------------------------------------------
// GPU side.

/**
 * Hash-based value noise (Dave Hoskins style hashes, no sin: stable on every GPU at world-scale
 * coordinates) plus a variant returning its analytic gradient, used for bump normals without extra taps.
 */
export const SURFACE_NOISE_GLSL = /* glsl */ `
float sfHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float sfHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float sfHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 sfHash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float sfNoise2(vec2 x) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = sfHash12(i);
  float b = sfHash12(i + vec2(1.0, 0.0));
  float c = sfHash12(i + vec2(0.0, 1.0));
  float d = sfHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float sfNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(sfHash13(i), sfHash13(i + vec3(1.0, 0.0, 0.0)), u.x),
        mix(sfHash13(i + vec3(0.0, 1.0, 0.0)), sfHash13(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(sfHash13(i + vec3(0.0, 0.0, 1.0)), sfHash13(i + vec3(1.0, 0.0, 1.0)), u.x),
        mix(sfHash13(i + vec3(0.0, 1.0, 1.0)), sfHash13(i + vec3(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}
// x = value in [0,1), yzw = gradient (per unit of the input coordinate).
vec4 sfNoised(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = sfHash13(i);
  float b = sfHash13(i + vec3(1.0, 0.0, 0.0));
  float c = sfHash13(i + vec3(0.0, 1.0, 0.0));
  float d = sfHash13(i + vec3(1.0, 1.0, 0.0));
  float e = sfHash13(i + vec3(0.0, 0.0, 1.0));
  float f1 = sfHash13(i + vec3(1.0, 0.0, 1.0));
  float g = sfHash13(i + vec3(0.0, 1.0, 1.0));
  float h = sfHash13(i + vec3(1.0, 1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k3 = e - a;
  float k4 = a - b - c + d;
  float k5 = a - c - e + g;
  float k6 = a - b - e + f1;
  float k7 = -a + b + c - d + e - f1 - g + h;
  return vec4(
    a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
    du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
              k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
              k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}
`;

/**
 * The surface model. Albedos are linear and sit around the old vertex-colour x detail-map values, so
 * exposure and the grade did not need retuning. Bump gradients are in world units (m/m) and are applied
 * as a surface gradient: n' = normalize(n - (g - n * dot(n, g))).
 */
const SURFACE_GLSL = /* glsl */ `
uniform vec3 uSfSun;
uniform vec3 uSfRock0;
uniform vec3 uSfRock1;
uniform vec3 uSfRock2;
uniform vec3 uSfSand;
uniform vec3 uSfSandDark;
uniform vec3 uSfBed;
uniform vec3 uSfCover;
uniform float uSfCoverAmount;
uniform float uSfRipple;
uniform float uSfGlint;
uniform vec3 uSfGlintColor;
uniform float uSfStrata;
varying vec3 vSfPos;
varying vec3 vSfNormal;
#ifdef SURFACE_TERRAIN
varying float vSfBed;
#endif

${SURFACE_NOISE_GLSL}

struct SfSample {
  vec3 albedo;
  float rough;
  vec3 grad;
  float glint;
};

// 1 while the feature is several pixels wide, 0 once one pixel covers about half a wavelength.
float sfFade(float fp, float wavelength) {
  return 1.0 - smoothstep(0.15, 0.5, fp / wavelength);
}

// Ridged noise groove: returns the crack mask and adds the groove's slope to g.
float sfCrack(vec3 p, vec3 scale, float depth, float fade, inout vec3 g) {
  vec4 c = sfNoised(p * scale);
  float s = c.x * 2.0 - 1.0;
  float r = 1.0 - abs(s);
  float t = clamp((r - 0.955) / 0.04, 0.0, 1.0);
  float dt = 6.0 * t * (1.0 - t) / 0.04;
  g += depth * dt * 2.0 * sign(s) * c.yzw * scale * fade;
  return t * t * (3.0 - 2.0 * t) * fade;
}

// Sparse sun glints from individual grains: a jittered dot per 4.5 cm cell with a random facet normal.
float sfGlint(vec3 p, vec3 n, vec3 v, float fp) {
  float fade = 1.0 - smoothstep(0.012, 0.03, fp);
  if (fade <= 0.0) return 0.0;
  vec3 gp = p * 22.0;
  vec3 cell = floor(gp);
  vec3 h = sfHash33(cell);
  if (h.z < 0.55) return 0.0;
  float dotMask = 1.0 - smoothstep(0.12, 0.2, length(gp - cell - (0.25 + 0.5 * h)));
  vec3 m = normalize(n + (sfHash33(cell + 19.19) - 0.5) * 1.5);
  return smoothstep(0.975, 0.995, dot(m, normalize(v + uSfSun))) * dotMask * fade;
}

SfSample sfSurface(vec3 p, vec3 n, vec3 v, float fp, float bed) {
  SfSample s;
  // Broad variation (about 60 m and 12 m) shared by both materials: breaks up tiling at a distance.
  float big = sfNoise(p * 0.016) * 0.65 + sfNoise(p * 0.08 + 7.3) * 0.35;
  float jitter = (big - 0.5) * 0.12;
#ifdef SURFACE_TERRAIN
  // Sand slides off above roughly 35 degrees (cos 30 = 0.87, cos 40 = 0.77); the bed is always sand.
  float rockW = smoothstep(0.87, 0.76, n.y + jitter) * (1.0 - bed);
#else
  // Props are rock; only near-flat tops and ledges hold wind-blown sand.
  float rockW = 1.0 - 0.85 * smoothstep(0.86, 0.96, n.y + jitter);
#endif

  vec3 rockCol = vec3(0.0);
  vec3 rockGrad = vec3(0.0);
  float rockRough = 0.0;
  if (rockW > 0.002) {
    // Bedding planes: world-Y bands, folded by noise and dipping slightly, so they line up across
    // neighbouring rocks and canyon walls like real strata.
    vec4 w = sfNoised(p * vec3(0.014, 0.03, 0.014));
    float y = p.y + (w.x - 0.5) * 10.0 + p.x * 0.021 - p.z * 0.013;
    float yA = y * (1.0 / 6.5);
    float iA = floor(yA);
    float tA = mix(sfHash11(iA), sfHash11(iA + 1.0), smoothstep(0.8, 1.0, yA - iA));
    rockCol = mix(mix(uSfRock0, uSfRock1, smoothstep(0.0, 0.5, tA)), uSfRock2, smoothstep(0.55, 1.0, tA));
    float yB = y * (1.0 / 1.4) + w.x * 1.7;
    float iB = floor(yB);
    float hB = mix(sfHash11(iB + 41.0), sfHash11(iB + 42.0), smoothstep(0.78, 1.0, yB - iB));
    // Band contrast scales with uSfStrata: full on sandstone, faint on granite and basalt.
    rockCol *= 1.0 + (0.34 * hB - 0.2) * uSfStrata;
    rockCol *= 1.0 + sfFade(fp, 0.35) * 0.07 * uSfStrata * sin(y * 19.0 + w.x * 9.0);
    // Desert varnish: dark streaks running down the faces.
    rockCol *= 1.0 - 0.22 * smoothstep(0.55, 0.85, sfNoise(p * vec3(0.22, 0.03, 0.22)));

    // Bumps: chunky (2.2 m), medium (0.8 m), fine (0.25 m, 0.08 m) octaves, faded with distance.
    vec4 n1 = sfNoised(p * 0.45 + 3.1);
    rockGrad = n1.yzw * (0.4 * 0.45);
    float f2 = sfFade(fp, 0.8);
    if (f2 > 0.0) rockGrad += sfNoised(p * 1.25 + 9.7).yzw * (0.16 * 1.25 * f2);
    float f3 = sfFade(fp, 0.25);
    if (f3 > 0.0) {
      rockGrad += sfNoised(p * 4.0 + 1.3).yzw * (0.045 * 4.0 * f3);
      float f4 = sfFade(fp, 0.08);
      if (f4 > 0.0) rockGrad += sfNoised(p * 12.5 + 5.1).yzw * (0.014 * 12.5 * f4);
    }
    // Harder beds stand out as ledges: a groove at every thin band boundary.
    rockGrad.y += sfFade(fp, 1.4) * (0.25 + 0.35 * hB) * (0.3 + 0.7 * uSfStrata) * cos(6.2831853 * yB);

    // Joint cracks, stretched vertically like weathered sandstone joints.
    float crack = 0.0;
    float fc = sfFade(fp, 0.5);
    if (fc > 0.0) {
      crack = sfCrack(p + 17.0, vec3(0.3, 0.05, 0.3), 0.04, fc, rockGrad);
      float fc2 = sfFade(fp, 0.18);
      if (fc2 > 0.0) crack = max(crack, 0.7 * sfCrack(p - 5.0, vec3(0.9, 0.35, 0.9), 0.025, fc2, rockGrad));
    }
    // Subtle: big dark joints read as scribbles on a 90 m canyon wall.
    rockCol *= 1.0 - 0.32 * crack;
    rockRough = 0.86 + (n1.x - 0.5) * 0.12 + crack * 0.1;
  }

  vec3 sandCol = vec3(0.0);
  vec3 sandGrad = vec3(0.0);
  float sandRough = 0.0;
  float glint = 0.0;
  if (rockW < 0.998) {
    sandCol = mix(uSfSand, uSfSandDark, big * 0.85);
    // Wind ripples across the prevailing wind (same frame as the dune ridges), warped by fbm. The
    // profile is asymmetric (gentle stoss, steep lee) and the gradient is analytic.
    vec2 q = p.xz;
    float warp = sfNoise2(q * 0.11) * 0.65 + sfNoise2(q * 0.31 + 5.0) * 0.35;
    float ripple = (1.0 - bed * 0.85) * uSfRipple;
    const vec2 WD1 = vec2(0.8, 0.6);
    const vec2 WD2 = vec2(0.55, 0.835);
    float r1 = sfFade(fp, 0.6) * ripple;
    float ph1 = dot(q, WD1) * (6.2831853 / 0.6) + warp * 9.0;
    float h1 = sin(ph1) + 0.3 * sin(2.0 * ph1);
    vec2 gs = WD1 * (cos(ph1) + 0.6 * cos(2.0 * ph1)) * (0.022 * 6.2831853 / 0.6) * r1;
    float r2 = sfFade(fp, 0.14) * ripple;
    float h2 = 0.0;
    if (r2 > 0.0) {
      float ph2 = dot(q, WD2) * (6.2831853 / 0.14) + warp * 14.0 + sfNoise2(q * 1.7) * 2.5;
      h2 = sin(ph2) + 0.3 * sin(2.0 * ph2);
      gs += WD2 * (cos(ph2) + 0.6 * cos(2.0 * ph2)) * (0.006 * 6.2831853 / 0.14) * r2;
    }
    sandCol *= 1.0 + 0.05 * h1 * r1 + 0.035 * h2 * r2;
    // Soft undulations (3 m) under the ripples, stronger on the packed bed (ruts and pod wash).
    vec4 u1 = sfNoised(p * 0.33 + 11.0);
    sandGrad = vec3(gs.x, 0.0, gs.y) + u1.yzw * (0.33 * (0.05 + 0.08 * bed));
    // Grain speckle up close.
    float fg = sfFade(fp, 0.05);
    if (fg > 0.0) sandCol *= 1.0 + (sfNoise(p * 28.0) - 0.5) * 0.2 * fg;
    // Patches on open flat ground (grass, moss, ice crust): two noise scales, never on the bed.
    float cover = smoothstep(0.45, 0.6, sfNoise(p * 0.05) * 0.6 + sfNoise(p * 0.23) * 0.4) * uSfCoverAmount * (1.0 - bed) * smoothstep(0.85, 0.95, n.y);
    sandCol = mix(sandCol, uSfCover * (0.8 + 0.4 * sfNoise(p * 1.7)), cover);
    // Packed bed: darker, compacted, smoother to the touch (lower roughness).
    sandCol = mix(sandCol, uSfBed * (0.88 + 0.24 * big), bed * 0.85);
    sandRough = 0.95 - bed * 0.13 + (u1.x - 0.5) * 0.08;
    vec3 nb = normalize(n - (sandGrad - n * dot(n, sandGrad)));
    glint = sfGlint(p, nb, v, fp) * (1.0 - bed * 0.7) * (1.0 - cover) * uSfGlint;
  }

  s.albedo = mix(sandCol, rockCol, rockW);
  s.grad = mix(sandGrad, rockGrad, rockW);
  s.rough = mix(sandRough, rockRough, rockW);
  s.glint = glint * (1.0 - rockW);
  return s;
}
`;

const SURFACE_VERTEX_PARS = /* glsl */ `
varying vec3 vSfPos;
varying vec3 vSfNormal;
#ifdef SURFACE_TERRAIN
attribute float aBed;
varying float vSfBed;
#endif
`;

// World position and geometric normal for the fragment stage (three only computes worldPosition under
// some defines, and never passes it on), including the instancing transform for rubble.
const SURFACE_VERTEX = /* glsl */ `
{
  vec4 sfP = vec4(transformed, 1.0);
  vec3 sfN = objectNormal;
  #ifdef USE_INSTANCING
  sfP = instanceMatrix * sfP;
  mat3 sfIm = mat3(instanceMatrix);
  sfN = sfIm * (sfN / vec3(dot(sfIm[0], sfIm[0]), dot(sfIm[1], sfIm[1]), dot(sfIm[2], sfIm[2])));
  #endif
  vSfPos = (modelMatrix * sfP).xyz;
  vSfNormal = normalize(mat3(modelMatrix) * sfN);
  #ifdef SURFACE_TERRAIN
  vSfBed = aBed;
  #endif
}
`;

// Derivatives are taken here, in uniform control flow, before any branch in sfSurface.
const SURFACE_SAMPLE = /* glsl */ `
vec3 sfGeoN = normalize(vSfNormal);
float sfFp = max(length(dFdx(vSfPos)), length(dFdy(vSfPos)));
#ifdef SURFACE_TERRAIN
SfSample sf = sfSurface(vSfPos, sfGeoN, normalize(cameraPosition - vSfPos), sfFp, vSfBed);
#else
SfSample sf = sfSurface(vSfPos, sfGeoN, normalize(cameraPosition - vSfPos), sfFp, 0.0);
#endif
diffuseColor.rgb *= sf.albedo;
`;

const SURFACE_NORMAL = /* glsl */ `
{
  vec3 sfG = (viewMatrix * vec4(sf.grad, 0.0)).xyz;
  normal = normalize(normal - (sfG - normal * dot(normal, sfG)));
}
`;

// Glints ride on the direct diffuse term, so they vanish in shadow and at grazing sun like real ones.
// Peak add is about 1.0 linear: a pinprick above the bloom threshold, never a flare.
const SURFACE_GLINT = /* glsl */ `
{
  float sfLit = dot(reflectedLight.directDiffuse, vec3(0.3333)) / max(dot(diffuseColor.rgb, vec3(0.3333)), 0.05);
  reflectedLight.directSpecular += uSfGlintColor * min(sf.glint * sfLit * 1.6, 1.0);
}
`;

const SUN_UNIFORM = { value: SUN_DIRECTION };

/** Insert `code` after (or before) one of three's `#include <chunk>` lines; throws if the chunk is gone. */
export function inject(src: string, chunk: string, code: string, before = false): string {
  const token = `#include <${chunk}>`;
  // Fail loudly on a three upgrade that renames a chunk instead of silently losing the surface.
  if (!src.includes(token)) throw new Error(`surface shader: missing ${token}`);
  return src.replace(token, before ? `${code}\n${token}` : `${token}\n${code}`);
}

function surfaceMaterial(terrain: boolean, theme: SurfaceTheme): THREE.MeshStandardMaterial {
  // Colour, roughness and normal all come from the shader; the material keeps white / 1 as neutral
  // multipliers so lights, IBL, shadows and fog run through three's standard path.
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  if (terrain) mat.defines = { SURFACE_TERRAIN: '' };
  // One program for every planet (same cache key); the palette lives in this material's own uniforms.
  const palette = {
    uSfSun: SUN_UNIFORM,
    uSfRock0: { value: new THREE.Color().setRGB(...theme.rock[0]) },
    uSfRock1: { value: new THREE.Color().setRGB(...theme.rock[1]) },
    uSfRock2: { value: new THREE.Color().setRGB(...theme.rock[2]) },
    uSfSand: { value: new THREE.Color().setRGB(...theme.ground) },
    uSfSandDark: { value: new THREE.Color().setRGB(...theme.groundDark) },
    uSfBed: { value: new THREE.Color().setRGB(...theme.bed) },
    uSfCover: { value: new THREE.Color().setRGB(...theme.cover) },
    uSfCoverAmount: { value: theme.coverAmount },
    uSfRipple: { value: theme.ripple },
    uSfGlint: { value: theme.glint },
    uSfGlintColor: { value: new THREE.Color().setRGB(...theme.glintColor) },
    uSfStrata: { value: theme.strata },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, palette);
    let vs = shader.vertexShader;
    vs = inject(vs, 'common', SURFACE_VERTEX_PARS);
    vs = inject(vs, 'worldpos_vertex', SURFACE_VERTEX);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = inject(fs, 'common', SURFACE_GLSL);
    fs = inject(fs, 'color_fragment', SURFACE_SAMPLE);
    fs = inject(fs, 'roughnessmap_fragment', 'roughnessFactor *= sf.rough;');
    fs = inject(fs, 'normal_fragment_maps', SURFACE_NORMAL);
    fs = inject(fs, 'lights_fragment_end', SURFACE_GLINT);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => (terrain ? 'surface-terrain' : 'surface-rock');
  // Cached across worlds: Engine.setScene must not dispose it with the old scene.
  mat.userData.shared = true;
  return mat;
}

// Keyed by the theme's palette object: every TrackDef owns one, built once per session.
const terrainMats = new Map<SurfaceTheme, THREE.MeshStandardMaterial>();
const rockMats = new Map<SurfaceTheme, THREE.MeshStandardMaterial>();

/** Ground material. Geometry must carry an `aBed` float attribute (1 on the packed track bed). */
export function terrainMaterial(theme: SurfaceTheme): THREE.MeshStandardMaterial {
  let mat = terrainMats.get(theme);
  if (!mat) terrainMats.set(theme, (mat = surfaceMaterial(true, theme)));
  return mat;
}

/** Rock material for props, rubble (works with InstancedMesh) and anything sculpted from the planet's rock. */
export function rockMaterial(theme: SurfaceTheme): THREE.MeshStandardMaterial {
  let mat = rockMats.get(theme);
  if (!mat) rockMats.set(theme, (mat = surfaceMaterial(false, theme)));
  return mat;
}
