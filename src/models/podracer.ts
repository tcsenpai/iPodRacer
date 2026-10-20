// Procedural podracer in the style of Anakin's: two long turbine engines out front joined by a crackling
// energy binder, towing a small cockpit pod on control cables. Engines and cockpit are separate objects
// so gameplay can let them sway independently; update() re-fits the binder and cables every frame.
// Local frame: -Z forward, +Y up; the root origin sits between the engines.
//
// Geometry, textures and most materials are built once and shared by every pod (flagged
// `userData.shared` so scene disposal keeps them). Livery colours are shader uniforms over shared paint
// masks, so each pod only owns a handful of small materials: per engine, because damage is per engine.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothstep } from '../core/rng';
import { paintSurfaces, plumeTexture, type PodTextureSet, type SurfaceRecipe } from './podTextures';

export interface PodracerModel {
  readonly root: THREE.Group;
  readonly engineL: THREE.Group;
  readonly engineR: THREE.Group;
  readonly cockpit: THREE.Group;
  /** Chase-camera anchor (behind and above the cockpit) and pilot-eye anchor. */
  readonly chaseAnchor: THREE.Object3D;
  readonly eyeAnchor: THREE.Object3D;
  /**
   * throttle 0..1 drives exhaust glow, fan and air brakes; boost 0..1 the overdrive flame; health[i] 0..1 per
   * engine (0 left, 1 right; 1 = pristine) drives scorching, misfires, droop and binder flicker. Call every
   * frame after moving the parts.
   */
  update(dt: number, throttle: number, boost: number, health: readonly [number, number]): void;
}

/** Paint scheme and proportions: rivals share the model, each with its own colours. */
export interface PodLivery {
  /** Lacquer tint over the silver panels (white = bare metal look). */
  skin: string;
  band: string;
  trim: string;
  cockpit: string;
  /** Uniform engine scale (Sebulba's split-X engines are huge). */
  engineScale: number;
}

export const ANAKIN_LIVERY: PodLivery = { skin: '#ffffff', band: '#1f4f9e', trim: '#e0b030', cockpit: '#2257a8', engineScale: 1 };
const ENGINE_LEN = 7.2;
const ENGINE_GAP = 1.75; // centre offset of each engine from the root
const COCKPIT_Z = 9.5; // cockpit trails this far behind the engines' rear
const TAU = Math.PI * 2;
const _X = new THREE.Vector3(1, 0, 0);

// Attachment points in engine-local space (shared geometry places greebles at the same spots).
const EMIT_ANGLE = (50 * Math.PI) / 180; // binder emitters sit 50 degrees above the engine's equator
const EMIT_R = 1.04;
const EMIT_X = Math.cos(EMIT_ANGLE) * EMIT_R;
const EMIT_Y = Math.sin(EMIT_ANGLE) * EMIT_R;
const EMIT_Z = 1.25;
const LUG_Y = -0.9; // cable lug under the engine tail
const LUG_Z = 5.6;
const COCKPIT_LUG_X = 0.5; // cable lugs either side of the cockpit nose
const COCKPIT_LUG_Z = -1.25;
const FLAP_HINGE_X = 0.86;
const FLAP_Z0 = 0.62;
const FLAP_Z1 = 1.46;
const PIVOT_Z = ENGINE_LEN / 2; // engines droop about their middle
const PLUME_Z = 6.85;

type P = readonly [number, number]; // lathe profile point: (radius, axial z)

// ---------------------------------------------------------------------------------------------------------
// Engine profile and texture layout. The body's v coordinate follows the axis (not three's per-point index)
// so painted bands land where the geometry has them; the intake throat gets its own strip at v < 0.03.

const vOf = (z: number): number => 0.03 + 0.97 * Math.min(1, Math.max(0, (z + 0.08) / 7.34));

/** Throat, from deep inside forward to the lip (running backwards along the axis faces it inward). */
const INTAKE: readonly P[] = [
  [0.5, 0.7],
  [0.505, 0.4],
  [0.52, 0.15],
  [0.55, 0.03],
  [0.59, -0.04],
];

/** Raised panel band: duplicated base corners give crisp creases, the chamfered top stays soft. */
function band(out: P[], r0: number, r1: number, z0: number, z1: number): void {
  out.push([r0, z0], [r0, z0], [r1 - 0.008, z0], [r1, z0 + 0.012], [r1, z1 - 0.012], [r1 - 0.008, z1], [r0, z1], [r0, z1]);
}

/** Outer skin front to back: rolled intake lip, pinched neck, flared cowling, raised bands, nozzle collar. */
function engineOuter(): P[] {
  const o: P[] = [
    [0.64, -0.075],
    [0.7, -0.07],
    [0.745, -0.035],
    [0.775, 0.03],
    [0.79, 0.12],
    [0.79, 0.2],
    [0.775, 0.32],
    [0.77, 0.42],
    [0.785, 0.55],
    [0.81, 0.75],
    [0.83, 1.0],
    [0.84, 1.3],
    [0.842, 1.55],
  ];
  band(o, 0.842, 0.872, 1.6, 1.9);
  o.push([0.846, 2.2], [0.848, 2.8], [0.847, 3.25]);
  band(o, 0.847, 0.868, 3.3, 3.45);
  o.push([0.842, 3.9], [0.832, 4.5], [0.818, 4.95]);
  band(o, 0.818, 0.852, 5.0, 5.2);
  o.push([0.795, 5.5], [0.76, 5.85], [0.725, 6.12], [0.7, 6.3]);
  band(o, 0.7, 0.722, 6.33, 6.55);
  // Collar lip, rear face, then the nozzle liner running forward (faces inward, seen from behind).
  o.push([0.69, 6.575], [0.66, 6.585], [0.66, 6.585], [0.62, 6.585], [0.62, 6.585], [0.605, 6.4]);
  return o;
}

/** Radius of a front-to-back profile at z (first rising segment that spans it). */
function radiusAt(prof: readonly P[], z: number): number {
  for (let k = 1; k < prof.length; k++) {
    const [r0, z0] = prof[k - 1];
    const [r1, z1] = prof[k];
    if (z1 > z0 && z >= z0 && z <= z1) return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
  }
  return prof[prof.length - 1][0];
}

function engineRecipe(): SurfaceRecipe {
  const lipEnd = vOf(0.2);
  const lacquerEnd = vOf(6.3);
  const bandA = vOf(1.9);
  const bandB = vOf(3.3);
  const pin0 = vOf(1.94);
  const pin1 = vOf(1.98);
  const pin2 = vOf(3.22);
  const pin3 = vOf(3.26);
  const ringC0 = vOf(5.0);
  const ringC1 = vOf(5.2);
  const sootStart = vOf(5.3);
  const dust0 = vOf(0.3);
  const dust1 = vOf(2.2);
  const heat0 = vOf(6.0);
  const heat1 = vOf(7.15);
  return {
    seed: 1999,
    rows: [0, 0.03, lipEnd, vOf(0.62), vOf(1.6), bandA, vOf(2.6), bandB, vOf(3.45), vOf(4.2), ringC0, ringC1, vOf(5.85), vOf(6.33), vOf(6.58), 1],
    columns: 8,
    interior: 0.03,
    layout(u, v, out) {
      const trim = (v >= 0.03 && v < lipEnd) || (v > pin0 && v < pin1) || (v > pin2 && v < pin3) || (v > ringC0 && v < ringC1);
      out[0] = v > lipEnd && v < lacquerEnd ? 1 : 0;
      out[1] = !trim && v > bandA && v < bandB ? 1 : 0;
      out[2] = trim ? 1 : 0;
      // Exhaust soot toward the tail, road grime underneath, intake dust streaking back from the lip.
      const exhaust = smoothstep(sootStart, 1, v);
      out[3] = exhaust * 0.45;
      out[4] = exhaust * 0.5 + Math.pow(Math.max(0, Math.cos(u * TAU)), 4) * 0.25 + 0.12 * (1 - smoothstep(dust0, dust1, v));
      out[5] = smoothstep(heat0, heat1, v);
    },
  };
}

const COCKPIT_RECIPE: SurfaceRecipe = {
  seed: 1138,
  rows: [0, 0.07, 0.2, 0.36, 0.52, 0.68, 0.84, 0.94, 1],
  columns: 6,
  interior: 0,
  layout(u, v, out) {
    const stripe = (Math.abs(u - 0.25) < 0.018 || Math.abs(u - 0.75) < 0.018) && v > 0.12 && v < 0.9;
    out[0] = 0;
    out[2] = stripe || v < 0.07 ? 1 : 0;
    out[1] = 1 - out[2];
    // Grime on the underside, a little exhaust wash at the rear.
    const under = Math.pow(Math.max(0, Math.cos(u * TAU)), 3);
    out[3] = under * 0.14;
    out[4] = under * 0.35 + smoothstep(0.9, 1, v) * 0.3;
    out[5] = 0;
  },
};

// ---------------------------------------------------------------------------------------------------------
// Shaders.

// Livery paint over shared masks, plus per-material damage: char blotches grow from a noise threshold as
// health falls (rough, non-metallic), with a browned halo whose rim glows like embers on a dying engine.
const PAINT_PARS = /* glsl */ `
uniform sampler2D uPaint;
uniform vec3 uPaintR;
uniform vec3 uPaintG;
uniform vec3 uPaintB;
uniform float uScorch;
uniform float uEmber;
`;
const PAINT_MAP = /* glsl */ `
float podChar = 0.0;
float podEdge = 0.0;
#ifdef USE_MAP
{
  vec3 metal = texture2D(map, vMapUv).rgb;
  vec4 pm = texture2D(uPaint, vMapUv);
  float tone = clamp(dot(metal, vec3(0.3333)) * 2.0, 0.5, 1.2);
  vec3 c = mix(metal, metal * uPaintR, pm.r);
  c = mix(c, uPaintG * tone, pm.g);
  c = mix(c, uPaintB * tone, pm.b);
  c *= pm.a;
  float th = 1.0 - uScorch * 1.15;
  float sn = texture2D(roughnessMap, vMapUv).r;
  podChar = smoothstep(th, th + 0.12, sn);
  podEdge = smoothstep(th - 0.12, th, sn) * (1.0 - podChar) * step(0.02, uScorch);
  c *= 1.0 - 0.45 * podEdge;
  c = mix(c, vec3(0.022, 0.019, 0.017), podChar * 0.94);
  diffuseColor.rgb *= c;
}
#endif
`;

function patchPaint(fs: string): string {
  return fs
    .replace('#include <common>', `#include <common>\n${PAINT_PARS}`)
    .replace('#include <map_fragment>', PAINT_MAP)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.92, podChar);')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.04, podChar);')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.3, 0.05) * uEmber * podEdge;');
}

interface PaintHandle {
  readonly mat: THREE.MeshStandardMaterial;
  readonly scorch: { value: number };
  readonly ember: { value: number };
}

/** Per-pod paint material over a shared texture set: r = lacquer tint, g = primary paint, b = trim. */
function paintMaterial(tex: PodTextureSet, r: string, g: string, b: string): PaintHandle {
  const scorch = { value: 0 };
  const ember = { value: 0 };
  const uniforms = {
    uPaint: { value: tex.paint },
    uPaintR: { value: new THREE.Color(r) },
    uPaintG: { value: new THREE.Color(g) },
    uPaintB: { value: new THREE.Color(b) },
    uScorch: scorch,
    uEmber: ember,
  };
  const mat = new THREE.MeshStandardMaterial({ map: tex.map, normalMap: tex.normal, roughnessMap: tex.orm, metalnessMap: tex.orm, roughness: 1, metalness: 1 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = patchPaint(shader.fragmentShader);
  };
  // Every pod's paint compiles to the same program; only the uniform values differ.
  mat.customProgramCacheKey = () => 'podPaint';
  return { mat, scorch, ember };
}

// Energy binder: additive arc with flickering filaments. Includes three's log-depth chunks (the engine
// uses a logarithmic depth buffer; custom shaders without them sort wrongly against other geometry).
const BINDER_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const BINDER_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uPower;
varying vec2 vUv;
float h(float n) { return fract(sin(n) * 43758.5453); }
float n1(float x) { float i = floor(x); float f = fract(x); return mix(h(i), h(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  #include <logdepthbuf_fragment>
  float x = vUv.x;
  float y = vUv.y * 2.0 - 1.0;
  float glow = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float off = (n1(x * 7.0 + uTime * (9.0 + fk * 3.0) + fk * 13.0) - 0.5) * 0.9 * sin(x * 3.14159);
    float d = abs(y - off);
    glow += 0.012 / (d * d + 0.004) * (0.6 + 0.4 * n1(uTime * 30.0 + fk * 7.0));
  }
  glow *= smoothstep(0.0, 0.08, x) * smoothstep(1.0, 0.92, x) * uPower;
  vec3 col = mix(vec3(0.35, 0.45, 1.0), vec3(0.85, 0.75, 1.0), clamp(glow * 0.15, 0.0, 1.0));
  gl_FragColor = vec4(col * glow * 0.35, 1.0);
}`;

// ---------------------------------------------------------------------------------------------------------
// Geometry helpers (build time only).

/** Lathe around +Z (three lathes around +Y); u = angle / 2PI from the underside, v from `v(pointIndex)`. */
function lathe(profile: readonly P[], segs: number, v: (j: number) => number, phiStart = 0, phiLength = TAU): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, z]) => new THREE.Vector2(r, z)),
    segs,
    phiStart,
    phiLength,
  );
  const uv = g.getAttribute('uv');
  const n = profile.length;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, (phiStart + uv.getX(k) * phiLength) / TAU, v(k % n));
  g.rotateX(Math.PI / 2); // lathe axis Y -> +Z, angle 0 at -Y
  return g;
}

/** Grey or RGB vertex colour over a whole primitive (merged greebles share one vertex-coloured material). */
function tint(g: THREE.BufferGeometry, r: number, gg = r, b = r): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    c[k * 3] = r;
    c[k * 3 + 1] = gg;
    c[k * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Cylinder from a to b, radius tapering slightly toward b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r * 0.85, r, d.length(), 10);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

function shared<T extends THREE.BufferGeometry | THREE.Material>(x: T): T {
  x.userData.shared = true;
  return x;
}

// ---------------------------------------------------------------------------------------------------------
// Engine parts.

function engineBody(): THREE.BufferGeometry {
  const prof = [...INTAKE, ...engineOuter()];
  const nI = INTAKE.length;
  const body = lathe(prof, 72, (j) => (j < nI ? (0.028 * j) / (nI - 1) : vOf(prof[j][1])));
  // Exhaust petals: twelve curved plates converging behind the collar, small gaps between them.
  const petal: P[] = [
    [0.668, 6.57],
    [0.64, 6.9],
    [0.6, 7.22],
    [0.6, 7.22],
    [0.578, 7.22],
    [0.578, 7.22],
    [0.615, 6.9],
    [0.645, 6.57],
    [0.645, 6.57],
    [0.668, 6.57],
  ];
  const parts = [body];
  const step = TAU / 12;
  for (let k = 0; k < 12; k++) parts.push(lathe(petal, 4, (j) => vOf(petal[j][1]), k * step + step * 0.05, step * 0.9));
  return shared(mergeGeometries(parts));
}

/** Curved air-brake plate on one side (s = +1 / -1), with its hinge (front edge) at the origin. */
function flapGeometry(s: number): THREE.BufferGeometry {
  const prof: P[] = [
    [0.872, FLAP_Z0],
    [0.872, FLAP_Z1],
    [0.872, FLAP_Z1],
    [0.852, FLAP_Z1],
    [0.852, FLAP_Z1],
    [0.852, FLAP_Z0],
    [0.852, FLAP_Z0],
    [0.872, FLAP_Z0],
  ];
  const g = lathe(prof, 14, (j) => vOf(prof[j][1]), (s > 0 ? Math.PI / 2 : Math.PI * 1.5) - 0.45, 0.9);
  g.translate(-s * FLAP_HINGE_X, 0, -FLAP_Z0);
  return shared(g);
}

function fanGeometry(): THREE.BufferGeometry {
  const hub: P[] = [
    [0.001, 0.14],
    [0.05, 0.16],
    [0.1, 0.24],
    [0.13, 0.36],
    [0.135, 0.5],
  ];
  const parts = [lathe(hub, 24, (j) => j / 4)];
  for (let k = 0; k < 13; k++) {
    parts.push(
      new THREE.BoxGeometry(0.36, 0.012, 0.11)
        .translate(0.31, 0, 0)
        .rotateX(0.55)
        .rotateZ((k * TAU) / 13)
        .translate(0, 0, 0.4),
    );
  }
  return shared(mergeGeometries(parts));
}

/** Everything unpainted and static on an engine, vertex-tinted: throat, stator, nozzle, conduit, rivets. */
function engineMetal(): THREE.BufferGeometry {
  const outer = engineOuter();
  const parts: THREE.BufferGeometry[] = [];
  // Intake: dark back wall behind the fan, stator hub and vanes.
  parts.push(tint(new THREE.CircleGeometry(0.51, 48).rotateY(Math.PI).translate(0, 0, 0.7), 0.22));
  parts.push(tint(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 24).rotateX(Math.PI / 2).translate(0, 0, 0.58), 0.6));
  for (let k = 0; k < 9; k++) {
    parts.push(tint(new THREE.BoxGeometry(0.38, 0.02, 0.08).translate(0.31, 0, 0).rotateX(0.25).rotateZ((k * TAU) / 9 + 0.17).translate(0, 0, 0.58), 0.45));
  }
  // Nozzle: centre plug, straightening vanes and the liner behind the petal gaps.
  const plug: P[] = [
    [0.355, 6.25],
    [0.35, 6.6],
    [0.32, 6.9],
    [0.24, 7.2],
    [0.12, 7.42],
    [0.001, 7.5],
  ];
  parts.push(tint(lathe(plug, 32, (j) => j / 5), 0.42));
  for (let k = 0; k < 8; k++) parts.push(tint(new THREE.BoxGeometry(0.27, 0.02, 0.22).translate(0.46, 0, 0).rotateZ((k * TAU) / 8).translate(0, 0, 6.95), 0.35));
  const liner: P[] = [
    [0.585, 7.18],
    [0.605, 6.6],
  ];
  parts.push(tint(lathe(liner, 48, (j) => j), 0.28));
  // Fuel conduit along the top, with clamps down to the skin.
  const conduit = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.93, 0.9),
    new THREE.Vector3(0, 0.935, 2.0),
    new THREE.Vector3(0, 0.93, 3.5),
    new THREE.Vector3(0, 0.915, 4.6),
    new THREE.Vector3(0, 0.9, 5.2),
    new THREE.Vector3(0, 0.84, 5.8),
    new THREE.Vector3(0, 0.76, 6.15),
  ]);
  parts.push(tint(new THREE.TubeGeometry(conduit, 64, 0.03, 8, false), 0.9));
  for (const z of [1.2, 2.4, 3.8, 5.0]) {
    const r = radiusAt(outer, z);
    const top = 0.93;
    parts.push(tint(new THREE.BoxGeometry(0.09, top - r + 0.02, 0.06).translate(0, (top + r) / 2 - 0.01, z), 0.75));
  }
  // Binder emitters on both upper flanks (symmetric so one geometry serves left and right engines).
  for (const s of [-1, 1]) {
    const cx = Math.cos(EMIT_ANGLE) * 0.9 * s;
    const cy = Math.sin(EMIT_ANGLE) * 0.9;
    parts.push(tint(new THREE.CylinderGeometry(0.055, 0.075, 0.26, 16).rotateZ(-s * (Math.PI / 2 - EMIT_ANGLE)).translate(cx, cy, EMIT_Z), 0.95));
    parts.push(tint(new THREE.SphereGeometry(0.07, 14, 10).translate(Math.cos(EMIT_ANGLE) * 1.02 * s, Math.sin(EMIT_ANGLE) * 1.02, EMIT_Z), 1));
    // Air-brake hinge pins.
    parts.push(tint(new THREE.CylinderGeometry(0.025, 0.025, 0.8, 10).translate(s * FLAP_HINGE_X, 0, FLAP_Z0), 0.8));
  }
  // Cable lug under the tail and two sensor blisters underneath.
  const lugR = radiusAt(outer, LUG_Z);
  parts.push(tint(new THREE.BoxGeometry(0.07, 0.12, 0.3).translate(0, -(lugR + 0.03), LUG_Z), 0.8));
  parts.push(tint(new THREE.TorusGeometry(0.04, 0.013, 8, 16).rotateY(Math.PI / 2).translate(0, LUG_Y, LUG_Z), 0.85));
  for (const z of [2.5, 3.0]) {
    parts.push(tint(new THREE.SphereGeometry(0.09, 12, 6, 0, TAU, 0, Math.PI / 2).rotateX(Math.PI).translate(0, -(radiusAt(outer, z) - 0.03), z), 0.55));
  }
  // Rivet rings either side of every raised band, on band tops and around the cowling. Open-ended domed
  // frustums: the 4 mm hole on top is invisible and skipping both caps halves their triangles.
  const rivet = new THREE.CylinderGeometry(0.004, 0.014, 0.012, 6, 1, true).translate(0, 0.004, 0);
  const m = new THREE.Matrix4();
  for (const z of [0.5, 1.56, 1.75, 1.94, 3.26, 3.49, 4.96, 5.24, 6.29]) {
    const r = radiusAt(outer, z) + 0.002;
    for (let k = 0; k < 48; k++) {
      const a = ((k + 0.5) * TAU) / 48;
      m.makeRotationZ(a - Math.PI / 2).setPosition(Math.cos(a) * r, Math.sin(a) * r, z);
      parts.push(tint(rivet.clone().applyMatrix4(m), 0.85));
    }
  }
  return shared(mergeGeometries(parts));
}

function plumeGeometry(): THREE.BufferGeometry {
  // Outer flame plus a brighter, shorter core; base at the nozzle (uv.y = 0), apex trailing behind (+Z).
  const outer = tint(new THREE.ConeGeometry(0.46, 3.2, 24, 1, true).translate(0, 1.6, 0), 0.6);
  const core = tint(new THREE.ConeGeometry(0.24, 1.7, 16, 1, true).translate(0, 0.85, 0), 1.4);
  return shared(mergeGeometries([outer, core]).rotateX(Math.PI / 2));
}

// ---------------------------------------------------------------------------------------------------------
// Cockpit parts.

const HULL_CTRL: readonly P[] = [
  [0.001, -1.78],
  [0.1, -1.74],
  [0.22, -1.62],
  [0.36, -1.4],
  [0.5, -1.12],
  [0.61, -0.8],
  [0.69, -0.45],
  [0.74, -0.1],
  [0.765, 0.25],
  [0.765, 0.6],
  [0.74, 0.9],
  [0.69, 1.12],
  [0.62, 1.24],
  [0.5, 1.32],
  [0.3, 1.37],
  [0.001, 1.39],
];
const HULL_SX = 1.08;
const HULL_SY = 0.62;
const HULL_Z0 = -1.78;
const HULL_Z1 = 1.39;
// Open cockpit well: angular half-width (from the top) as a function of z, rounded at both ends.
const OPEN_ZC = 0.18;
const OPEN_HZ = 0.68;
const OPEN_MAX = 0.95;

function openAngle(z: number): number {
  const t = (z - OPEN_ZC) / OPEN_HZ;
  return t <= -1 || t >= 1 ? 0 : OPEN_MAX * Math.pow(1 - t * t, 0.35);
}

function hullProfile(): P[] {
  const pts = new THREE.SplineCurve(HULL_CTRL.map(([r, z]) => new THREE.Vector2(r, z))).getPoints(60);
  return pts.map((p): P => [Math.max(0.001, p.x), p.y]);
}

/** Drops the triangles inside the cockpit opening so the well is a real hole in the tub. */
function cutOpening(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  if (!idx) return;
  const keep: number[] = [];
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t);
    const b = idx.getX(t + 1);
    const c = idx.getX(t + 2);
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    if (y > 0 && Math.abs(Math.atan2(x / HULL_SX, y / HULL_SY)) < openAngle(z)) continue;
    keep.push(a, b, c);
  }
  g.setIndex(keep);
}

/** Inside-out copy (reversed winding and normals) for the tub's interior walls. */
function flipped(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const f = g.clone();
  const idx = f.getIndex();
  if (idx) {
    for (let t = 0; t < idx.count; t += 3) {
      const b = idx.getX(t + 1);
      idx.setX(t + 1, idx.getX(t + 2));
      idx.setX(t + 2, b);
    }
  }
  const n = f.getAttribute('normal');
  for (let k = 0; k < n.count; k++) n.setXYZ(k, -n.getX(k), -n.getY(k), -n.getZ(k));
  return f;
}

function tubShell(prof: readonly P[]): THREE.BufferGeometry {
  const g = lathe(prof, 80, (j) => (prof[j][1] - HULL_Z0) / (HULL_Z1 - HULL_Z0));
  g.scale(HULL_SX, HULL_SY, 1);
  cutOpening(g);
  return g;
}

/** Painted tub: sculpted lathe hull with the cockpit well cut out, plus swept side stabilisers. */
function tubGeometry(prof: readonly P[]): THREE.BufferGeometry {
  const parts = [tubShell(prof).toNonIndexed()];
  for (const s of [-1, 1]) {
    const sh = new THREE.Shape();
    sh.moveTo(0, -0.5);
    sh.lineTo(s * 0.5, -0.12);
    sh.lineTo(s * 0.56, 0.32);
    sh.lineTo(0, 0.5);
    const fin = new THREE.ExtrudeGeometry(sh, { depth: 0.035, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 1 });
    fin.rotateX(Math.PI / 2); // shape y -> z (chord), extrusion -> -y (thickness)
    fin.rotateZ(s * 0.12); // slight dihedral
    fin.translate(s * 0.74, 0.02, 0.3);
    // Extrude UVs are in shape units; remap onto a plain primary-paint area of the cockpit texture.
    const pos = fin.getAttribute('position');
    const uv = fin.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, 0.12 + Math.abs(pos.getX(k)) * 0.04, 0.42 + pos.getZ(k) * 0.4);
    parts.push(fin);
  }
  return shared(mergeGeometries(parts));
}

/** Unpainted cockpit parts, vertex-tinted: interior walls, coaming, screen frame, seat, controls, scoops. */
function tubMetal(prof: readonly P[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const inner = flipped(tubShell(prof));
  inner.scale(0.965, 0.965, 0.985);
  parts.push(tint(inner, 0.28));
  // Coaming: padded rim around the opening (also hides the gap between the outer skin and the interior).
  const rim: THREE.Vector3[] = [];
  const N = 40;
  for (const s of [1, -1]) {
    for (let k = s > 0 ? 0 : N - 1; s > 0 ? k <= N : k >= 1; k += s > 0 ? 1 : -1) {
      const z = OPEN_ZC + OPEN_HZ * Math.sin(-Math.PI / 2 + (Math.PI * k) / N);
      const a = openAngle(z) * s;
      const r = radiusAt(prof, z);
      rim.push(new THREE.Vector3(HULL_SX * r * Math.sin(a), HULL_SY * r * Math.cos(a) + 0.01, z));
    }
  }
  parts.push(tint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rim, true), 180, 0.04, 8, true), 0.7));
  // Windscreen frame: posts and top bow, plus the sill.
  const scr = (phi: number, theta: number): THREE.Vector3 =>
    new THREE.Vector3(-Math.cos(phi) * Math.sin(theta) * SCREEN_SX, Math.cos(theta) * SCREEN_SY + SCREEN_Y, Math.sin(phi) * Math.sin(theta) * SCREEN_SZ);
  const p0 = SCREEN_PHI0;
  const p1 = SCREEN_PHI0 + SCREEN_PHIL;
  const t0 = SCREEN_THETA0;
  const t1 = SCREEN_THETA0 + SCREEN_THETAL;
  const frame: THREE.Vector3[] = [scr(p0, t1), scr(p0, (t0 + t1) / 2), scr(p0, t0)];
  for (let k = 1; k < 12; k++) frame.push(scr(p0 + ((p1 - p0) * k) / 12, t0));
  frame.push(scr(p1, t0), scr(p1, (t0 + t1) / 2), scr(p1, t1));
  parts.push(tint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(frame), 72, 0.016, 6, false), 0.85));
  const sill: THREE.Vector3[] = [];
  for (let k = 0; k <= 12; k++) sill.push(scr(p0 + ((p1 - p0) * k) / 12, t1));
  parts.push(tint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sill), 36, 0.022, 6, false), 0.7));
  // Seat back, dash, and the two control handles the pilot grips.
  parts.push(tint(new THREE.BoxGeometry(0.46, 0.5, 0.07).rotateX(0.18).translate(0, 0.12, 0.58), 0.45));
  parts.push(tint(new THREE.BoxGeometry(0.62, 0.1, 0.18).translate(0, 0.28, -0.42), 0.4));
  for (const s of [-1, 1]) {
    parts.push(tint(limb(new THREE.Vector3(s * 0.22, 0.05, -0.24), new THREE.Vector3(s * 0.22, 0.38, -0.28), 0.018), 0.9));
    parts.push(tint(new THREE.CylinderGeometry(0.024, 0.024, 0.13, 10).rotateZ(Math.PI / 2).translate(s * 0.22, 0.4, -0.28), 0.3));
    // Rear air scoops and their dark mouths.
    parts.push(tint(new THREE.CylinderGeometry(0.1, 0.12, 0.45, 18).rotateX(Math.PI / 2).translate(s * 0.42, 0.06, 1.25), 0.75));
    parts.push(tint(new THREE.CircleGeometry(0.1, 18).translate(s * 0.42, 0.06, 1.476), 0.12));
    // Cable lugs either side of the nose.
    parts.push(tint(new THREE.TorusGeometry(0.035, 0.011, 8, 16).rotateX(Math.PI / 2).translate(s * 0.47, 0, COCKPIT_LUG_Z), 0.85));
  }
  parts.push(tint(new THREE.CylinderGeometry(0.006, 0.01, 0.45, 6).translate(0.3, 0.55, 1.0), 0.8));
  return shared(mergeGeometries(parts));
}

// Windscreen: front slice of an ellipsoid shell wrapping the leading edge of the well.
const SCREEN_SX = 0.52;
const SCREEN_SY = 0.46;
const SCREEN_SZ = 0.62;
const SCREEN_Y = 0.23;
const SCREEN_PHI0 = Math.PI + 0.5;
const SCREEN_PHIL = Math.PI - 1;
const SCREEN_THETA0 = 0.38;
const SCREEN_THETAL = 0.95;

function screenGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 28, 10, SCREEN_PHI0, SCREEN_PHIL, SCREEN_THETA0, SCREEN_THETAL);
  g.scale(SCREEN_SX, SCREEN_SY, SCREEN_SZ).translate(0, SCREEN_Y, 0);
  return shared(g);
}

/** Seated pilot in flight suit, leather helmet and goggles, hands on the handles. */
function pilotGeometry(): THREE.BufferGeometry {
  const suit = [0.6, 0.5, 0.36] as const;
  const leather = [0.45, 0.32, 0.2] as const;
  const dark = [0.05, 0.055, 0.06] as const;
  const glove = [0.3, 0.22, 0.15] as const;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tint(new THREE.CapsuleGeometry(0.16, 0.26, 6, 14).scale(1.15, 1, 0.8).rotateX(0.18).translate(0, 0.2, 0.34), ...suit));
  parts.push(tint(new THREE.SphereGeometry(0.12, 20, 14).translate(0, 0.62, 0.36), ...leather));
  parts.push(tint(new THREE.TorusGeometry(0.122, 0.012, 6, 28).rotateX(Math.PI / 2).translate(0, 0.64, 0.36), ...dark));
  for (const s of [-1, 1]) {
    parts.push(tint(new THREE.CylinderGeometry(0.042, 0.042, 0.04, 12).rotateX(Math.PI / 2).translate(s * 0.048, 0.64, 0.245), ...dark));
    const shoulder = new THREE.Vector3(s * 0.19, 0.42, 0.36);
    const elbow = new THREE.Vector3(s * 0.25, 0.26, 0.1);
    const hand = new THREE.Vector3(s * 0.22, 0.4, -0.27);
    parts.push(tint(limb(shoulder, elbow, 0.05), ...suit));
    parts.push(tint(limb(elbow, hand, 0.042), ...suit));
    parts.push(tint(new THREE.SphereGeometry(0.045, 10, 8).translate(hand.x, hand.y, hand.z), ...glove));
  }
  return shared(mergeGeometries(parts));
}

// ---------------------------------------------------------------------------------------------------------
// Shared assets, built on first use.

interface Shared {
  engineTex: PodTextureSet;
  cockpitTex: PodTextureSet;
  plumeTex: THREE.DataTexture;
  body: THREE.BufferGeometry;
  flaps: readonly [THREE.BufferGeometry, THREE.BufferGeometry];
  fan: THREE.BufferGeometry;
  metal: THREE.BufferGeometry;
  glowRing: THREE.BufferGeometry;
  plume: THREE.BufferGeometry;
  tub: THREE.BufferGeometry;
  tubMetal: THREE.BufferGeometry;
  screen: THREE.BufferGeometry;
  pilot: THREE.BufferGeometry;
  binder: THREE.BufferGeometry;
  cable: THREE.BufferGeometry;
  gunmetal: THREE.MeshStandardMaterial;
  fanMat: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  pilotMat: THREE.MeshStandardMaterial;
  cableMat: THREE.MeshStandardMaterial;
}

let sharedAssets: Shared | null = null;

function buildShared(): Shared {
  const hull = hullProfile();
  const binderA = new THREE.PlaneGeometry(1, 0.9).translate(0.5, 0, 0); // spans x 0..1, scaled to the gap
  const binderB = binderA.clone().rotateX(Math.PI / 2); // crossed so it reads from any angle
  // Tapered cable, unit length along +Z (thick at the engine, thin at the cockpit).
  const cable = new THREE.CylinderGeometry(0.028, 0.05, 1, 8, 16, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x2a2b30, metalness: 0.8, roughness: 0.35 });
  // Cables hang a little under their own weight: bend the unit tube in the vertex shader (stretched along z
  // each frame, local y stays roughly world up after lookAt).
  cableMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y -= 0.88 * position.z * (1.0 - position.z);');
  };
  cableMat.customProgramCacheKey = () => 'podCable';
  const [engineTex, cockpitTex] = paintSurfaces([engineRecipe(), COCKPIT_RECIPE]);
  return {
    engineTex,
    cockpitTex,
    plumeTex: plumeTexture(),
    body: engineBody(),
    flaps: [flapGeometry(-1), flapGeometry(1)],
    fan: fanGeometry(),
    metal: engineMetal(),
    glowRing: shared(new THREE.RingGeometry(0.2, 0.6, 48).translate(0, 0, 6.75)),
    plume: plumeGeometry(),
    tub: tubGeometry(hull),
    tubMetal: tubMetal(hull),
    screen: screenGeometry(),
    pilot: pilotGeometry(),
    binder: shared(mergeGeometries([binderA, binderB])),
    cable: shared(cable),
    gunmetal: shared(new THREE.MeshStandardMaterial({ color: 0x5a5d64, metalness: 0.85, roughness: 0.42, vertexColors: true })),
    fanMat: shared(new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 1, roughness: 0.3 })),
    glass: shared(
      new THREE.MeshPhysicalMaterial({
        color: 0x9fb8c8,
        metalness: 0,
        roughness: 0.04,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    ),
    pilotMat: shared(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.72 })),
    cableMat: shared(cableMat),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Assembly.

interface EngineRig {
  readonly group: THREE.Group;
  /** Inner pivot for damage droop, so gameplay keeps full control of the outer group's transform. */
  readonly pivot: THREE.Group;
  readonly fan: THREE.Mesh;
  /** Air-brake hinges: [-x side, +x side]. */
  readonly flaps: readonly [THREE.Group, THREE.Group];
  readonly glow: THREE.MeshBasicMaterial;
  readonly plume: THREE.Mesh;
  readonly plumeMat: THREE.MeshBasicMaterial;
  readonly paint: PaintHandle;
}

function buildEngine(a: Shared, livery: PodLivery): EngineRig {
  const paint = paintMaterial(a.engineTex, livery.skin, livery.band, livery.trim);
  const group = new THREE.Group();
  const pivot = new THREE.Group();
  group.add(pivot);
  const body = new THREE.Mesh(a.body, paint.mat);
  body.castShadow = true;
  const fan = new THREE.Mesh(a.fan, a.fanMat);
  const hinge = (k: 0 | 1): THREE.Group => {
    const h = new THREE.Group();
    h.position.set((k ? 1 : -1) * FLAP_HINGE_X, 0, FLAP_Z0);
    h.add(new THREE.Mesh(a.flaps[k], paint.mat));
    return h;
  };
  const flaps = [hinge(0), hinge(1)] as const;
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.6, 0.6), toneMapped: true });
  const plumeMat = new THREE.MeshBasicMaterial({
    map: a.plumeTex,
    color: new THREE.Color(1, 0.5, 0.28),
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const plume = new THREE.Mesh(a.plume, plumeMat);
  plume.position.z = PLUME_Z;
  pivot.add(body, new THREE.Mesh(a.metal, a.gunmetal), fan, flaps[0], flaps[1], new THREE.Mesh(a.glowRing, glow), plume);
  return { group, pivot, fan, flaps, glow, plume, plumeMat, paint };
}

/** Smooth 1D value noise in [0, 1] (misfire and flicker gates; allocation-free). */
function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h0 = Math.sin(i * 127.1) * 43758.5453;
  const h1 = Math.sin((i + 1) * 127.1) * 43758.5453;
  const a = h0 - Math.floor(h0);
  const b = h1 - Math.floor(h1);
  return a + (b - a) * f * f * (3 - 2 * f);
}

export function createPodracer(livery: PodLivery = ANAKIN_LIVERY): PodracerModel {
  const A = (sharedAssets ??= buildShared());
  const root = new THREE.Group();

  // Engines: their own groups so gameplay can sway them; the origin of each is at its intake lip.
  const rigs = [buildEngine(A, livery), buildEngine(A, livery)] as const;
  const engineL = rigs[0].group;
  const engineR = rigs[1].group;
  const es = livery.engineScale;
  engineL.scale.setScalar(es);
  engineR.scale.setScalar(es);
  engineL.position.set(-ENGINE_GAP * es, 0, (-ENGINE_LEN / 2) * es);
  engineR.position.set(ENGINE_GAP * es, 0, (-ENGINE_LEN / 2) * es);
  root.add(engineL, engineR);

  // Cockpit tub with the pilot, windscreen and controls.
  const cockpit = new THREE.Group();
  const cockpitPaint = paintMaterial(A.cockpitTex, '#ffffff', livery.cockpit, livery.trim);
  const tub = new THREE.Mesh(A.tub, cockpitPaint.mat);
  tub.castShadow = true;
  cockpit.add(tub, new THREE.Mesh(A.tubMetal, A.gunmetal), new THREE.Mesh(A.pilot, A.pilotMat), new THREE.Mesh(A.screen, A.glass));
  cockpit.position.set(0, -0.15, ENGINE_LEN / 2 + COCKPIT_Z);
  root.add(cockpit);

  const chaseAnchor = new THREE.Object3D();
  chaseAnchor.position.set(0, 3.4, 7.5);
  cockpit.add(chaseAnchor);
  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.position.set(0, 0.95, 0.05);
  cockpit.add(eyeAnchor);

  // Energy binder between the emitters.
  const binderMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 1 } },
    vertexShader: BINDER_VERT,
    fragmentShader: BINDER_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const binder = new THREE.Mesh(A.binder, binderMat);
  root.add(binder);

  // Control cables: unit tubes stretched between the lugs each frame.
  const cables = [0, 1].map(() => {
    const m = new THREE.Mesh(A.cable, A.cableMat);
    m.castShadow = true;
    root.add(m);
    return m;
  });

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const droop = [0, 0];
  const flap = [0.2, 0.2];
  const fanAngle = [0, 1.3];
  let time = 0;
  return {
    root,
    engineL,
    engineR,
    cockpit,
    chaseAnchor,
    eyeAnchor,
    update(dt, throttle, boost, health) {
      time += dt;
      const kFlap = Math.min(1, dt * 6);
      const kDroop = Math.min(1, dt * 2);
      let weakest = 1;
      for (let i = 0; i < 2; i++) {
        const e = rigs[i];
        const h = Math.min(1, Math.max(0, health[i]));
        const dmg = 1 - h;
        weakest = Math.min(weakest, h);
        // A battered engine sags nose-down and leans outward about its middle, wobbling when nearly dead.
        droop[i] += (dmg * dmg * 0.075 - droop[i]) * kDroop;
        const wobble = h < 0.35 ? Math.sin(time * (5.3 + i * 1.7)) * (0.35 - h) * 0.04 : 0;
        const pitch = -(droop[i] + wobble);
        e.pivot.rotation.set(pitch, 0, (i ? -1 : 1) * droop[i] * 0.5);
        e.pivot.position.set(0, PIVOT_Z * Math.sin(pitch), PIVOT_Z - PIVOT_Z * Math.cos(pitch));
        // Misfires: below 60% health a noise gate cuts the flame, more often the lower it gets.
        let fire = 1;
        if (h < 0.6) fire = noise1(time * 9 + i * 17.3) < (0.6 - h) * 1.2 ? 0.12 : 0.85 + 0.15 * noise1(time * 41 + i * 5.1);
        fanAngle[i] += dt * (2.5 + throttle * 9 + boost * 5) * (0.4 + 0.6 * h) * (fire > 0.5 ? 1 : 0.6);
        e.fan.rotation.z = (i ? 1 : -1) * fanAngle[i]; // counter-rotating pair
        // Air brakes crack open as the throttle comes off, shut under boost.
        flap[i] += (0.04 + (1 - throttle) * 0.3 * (1 - boost) - flap[i]) * kFlap;
        e.flaps[0].rotation.y = -flap[i];
        e.flaps[1].rotation.y = flap[i];
        e.paint.scorch.value = dmg;
        e.paint.ember.value = dmg > 0.55 ? (dmg - 0.55) * 3.5 * (0.55 + 0.45 * noise1(time * 13 + i * 7.7)) : 0;
        // Overdrive: a longer, white-blue flame (above the bloom threshold so it flares).
        const k = (0.35 + throttle * 0.9 + boost * 1.6 + Math.sin(time * 60 + i * 1.7) * (0.05 + boost * 0.15)) * fire;
        const w = (1 + boost * 0.25) * (0.75 + 0.25 * fire);
        e.plume.scale.set(w, w, Math.max(0.05, k));
        e.plumeMat.color.setRGB(1 + boost * 0.4, 0.5 + boost * 0.6, 0.28 + boost * 1.2);
        e.plumeMat.opacity = 0.5 * (0.35 + 0.65 * fire);
        const g = 0.3 + 0.7 * fire;
        e.glow.color.setRGB((1.2 + throttle * 1.8 + boost * 2) * g, (0.6 + throttle * 0.7 + boost * 2) * g, (0.3 + throttle * 0.25 + boost * 3) * g);
      }
      cockpitPaint.scorch.value = (1 - weakest) * 0.45;
      // The binder weakens with the worst engine and drops out in stutters when one is nearly gone.
      let power = (0.6 + throttle * 0.6) * (0.5 + 0.5 * smoothstep(0, 0.5, weakest));
      if (weakest < 0.4 && noise1(time * 23) < (0.4 - weakest) * 1.8) power *= 0.1;
      binderMat.uniforms.uTime.value = time;
      binderMat.uniforms.uPower.value = power;

      // Gameplay may have moved the parts since the last render: refresh the local matrices first.
      root.updateMatrixWorld();
      const pl = rigs[0].pivot.matrix;
      const pr = rigs[1].pivot.matrix;
      // Binder: from the inner emitter of the left engine to the right one.
      a.set(EMIT_X, EMIT_Y, EMIT_Z).applyMatrix4(pl).applyMatrix4(engineL.matrix);
      b.set(-EMIT_X, EMIT_Y, EMIT_Z).applyMatrix4(pr).applyMatrix4(engineR.matrix);
      binder.position.copy(a);
      binder.scale.set(a.distanceTo(b), 1, 1);
      binder.quaternion.setFromUnitVectors(_X, b.sub(a).normalize());
      // Cables: lug under each engine tail -> lug beside the cockpit nose.
      for (let i = 0; i < 2; i++) {
        a.set(0, LUG_Y, LUG_Z)
          .applyMatrix4(i ? pr : pl)
          .applyMatrix4(i ? engineR.matrix : engineL.matrix);
        b.set(i ? COCKPIT_LUG_X : -COCKPIT_LUG_X, 0, COCKPIT_LUG_Z).applyMatrix4(cockpit.matrix);
        cables[i].position.copy(a);
        cables[i].scale.set(1, 1, a.distanceTo(b));
        cables[i].lookAt(b.applyMatrix4(root.matrixWorld));
      }
    },
  };
}
