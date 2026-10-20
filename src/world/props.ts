// Track-side scenery: the start/finish gate, sandstone arches spanning the course, hoodoo pillars and the
// rubble at their feet. Rock is sculpted geometry (smooth, multi-octave displaced) shaded by the shared
// procedural surface (./surface); hoodoos switch between three detail levels with distance.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng, smoothstep } from '../core/rng';
import { noise3, rockMaterial } from './surface';
import { groundHeight } from './terrain';
import { TRACK_HALF_WIDTH, type Track, type TrackHit } from './track';

/** Solid vertical obstacle footprint, also in track coordinates so the AI can plan around it. */
export interface Collider {
  x: number;
  z: number;
  r: number;
  /** Arc parameter and signed lateral offset (m, + = right of the centreline). */
  u: number;
  lat: number;
}

/** Hard-bed profile over one stratum (f in 0..1): a sharp lip underneath, a long weathered slope above. */
function ledge(f: number): number {
  return smoothstep(0, 0.1, f) * (1 - smoothstep(0.3, 0.95, f));
}

// ---------------------------------------------------------------------------------------------------
// Hoodoos

interface Tier {
  r: number;
  sy: number;
}

/** Everything random about one hoodoo, drawn once so every detail level carves the same rock. */
interface HoodooShape {
  /** Column radius per tier and the height where each tier starts. */
  radius: number[];
  bottom: number[];
  /** Top of the column (base of the caprock). */
  top: number;
  capR: number;
  capT: number;
  ledgeStep: number;
  ledgePhase: number;
  leanX: number;
  leanZ: number;
  seed: number;
}

function hoodooShape(tiers: readonly Tier[], footprint: number, seed: number): HoodooShape {
  const rnd = new Rng(seed * 7919 + 13);
  const radius: number[] = [];
  const bottom: number[] = [];
  let y = 0;
  for (let k = 0; k < tiers.length; k++) {
    // The lowest tier is the footprint the collider describes; upper tiers keep their own (old) radii.
    radius.push(k === 0 ? footprint : tiers[k].r * 0.9);
    bottom.push(y);
    y += tiers[k].r * tiers[k].sy * 1.5;
  }
  const last = radius[radius.length - 1];
  const lean = rnd.range(0, 0.05) * y;
  const dir = rnd.range(0, Math.PI * 2);
  return {
    radius,
    bottom,
    top: y,
    capR: last * rnd.range(1.2, 1.55),
    capT: rnd.range(1.4, 2.6),
    ledgeStep: rnd.range(1.3, 2.2),
    ledgePhase: rnd.range(0, 10),
    leanX: Math.cos(dir) * lean,
    leanZ: Math.sin(dir) * lean,
    seed: rnd.int(0, 1 << 20),
  };
}

/** Column radius at height y: stacked tiers necked at the soft layers, a talus flare at the foot. */
function columnRadius(s: HoodooShape, y: number): number {
  let k = 0;
  while (k < s.radius.length - 1 && y > s.bottom[k + 1]) k++;
  let r = s.radius[k];
  // Blend into the neighbouring tier across its boundary so the radius never jumps.
  const next = k + 1 < s.radius.length ? s.bottom[k + 1] : Infinity;
  const blend = 0.9;
  if (y > next - blend) r += (s.radius[k + 1] - r) * smoothstep(next - blend, next + blend, y) * 0.5;
  if (k > 0 && y < s.bottom[k] + blend) r += (s.radius[k - 1] - r) * (1 - smoothstep(s.bottom[k] - blend, s.bottom[k] + blend, y)) * 0.5;
  // Soft layers between tiers erode into necks; the deepest one sits right under the caprock.
  let neck = 0;
  for (let j = 1; j < s.bottom.length; j++) neck = Math.max(neck, 0.15 * (1 - smoothstep(0, 1.6, Math.abs(y - s.bottom[j]))));
  neck = Math.max(neck, 0.28 * (1 - smoothstep(0, 1.4, s.top - y)));
  return r * (1 - neck) * (1 + 0.05 * (1 - smoothstep(0, 1.5, y)));
}

/**
 * Lathe-style hoodoo surface: rings of `segs` vertices every `step` m, then the caprock (undercut lip,
 * rounded edge, low dome) closed by a single pole vertex. Radial displacement is multi-octave 3D noise
 * (lumps, vertical flutes, fine pitting) plus horizontal strata ledges on the detailed levels.
 */
function hoodooGeometry(s: HoodooShape, segs: number, step: number, detail: boolean): THREE.BufferGeometry {
  // Profile: [radius, y] pairs from the buried foot to the cap's edge, then the dome.
  const prof: number[] = [];
  // Start 4 m under the placement point so the foot stays buried on sloping ground.
  for (let y = -4; y < s.top; y += step) prof.push(columnRadius(s, y), y);
  const neckR = columnRadius(s, s.top);
  const capSteps = Math.max(3, Math.round(s.capT / step));
  for (let i = 0; i <= capSteps; i++) {
    const f = i / capSteps;
    // Undercut lip over the first 15%, straight sides, then a rounded shoulder.
    const out = smoothstep(0, 0.15, f);
    const shoulder = 1 - 0.18 * smoothstep(0.65, 1, f) ** 2;
    prof.push((neckR + (s.capR - neckR) * out) * shoulder * (1 - 0.04 * f), s.top + f * s.capT);
  }
  const edgeR = prof[prof.length - 2];
  const domeH = Math.min(0.6, edgeR * 0.12);
  const domeSteps = Math.max(2, Math.round(capSteps * 0.6));
  for (let i = 1; i < domeSteps; i++) {
    const a = (i / domeSteps) * Math.PI * 0.5;
    prof.push(edgeR * Math.cos(a), s.top + s.capT + domeH * Math.sin(a));
  }
  const rings = prof.length / 2;
  const height = s.top + s.capT;
  const pos = new Float32Array((rings * segs + 1) * 3);
  for (let i = 0; i < rings; i++) {
    const r0 = prof[i * 2];
    const y = prof[i * 2 + 1];
    const t = Math.max(0, y) / height;
    const ox = s.leanX * t * t;
    const oz = s.leanZ * t * t;
    // Keep the foot on the collider: relief grows from about +-4% at pod height to full by 4 m.
    const amp = 0.35 + 0.65 * smoothstep(0, 4, y);
    const strata = detail ? (0.07 * ledge((((y + s.ledgePhase) / s.ledgeStep) % 1 + 1) % 1) - 0.02) * amp : 0;
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      const x = cx * r0;
      const z = cz * r0;
      let d = (noise3(x / 4, y / 4, z / 4, s.seed) - 0.5) * 0.22 + (noise3(x / 1.4, y / 6, z / 1.4, s.seed + 1) - 0.5) * 0.1;
      if (detail) d += (noise3(x / 0.6, y / 0.6, z / 0.6, s.seed + 2) - 0.5) * 0.05;
      const r = r0 * (1 + d * amp + strata);
      pos.set([cx * r + ox, y, cz * r + oz], (i * segs + j) * 3);
    }
  }
  const pole = rings * segs;
  pos.set([s.leanX, height + domeH, s.leanZ], pole * 3);
  const idx: number[] = [];
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * segs + j;
      const b = (i + 1) * segs + j;
      const c = i * segs + ((j + 1) % segs);
      const d = (i + 1) * segs + ((j + 1) % segs);
      // (ring i, ring i+1, next angle) winds outward.
      idx.push(a, b, c, c, b, d);
    }
  }
  for (let j = 0; j < segs; j++) idx.push((rings - 1) * segs + j, pole, (rings - 1) * segs + ((j + 1) % segs));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Three detail levels; the far ones drop the ledges and the fine octave (sub-pixel there anyway). */
function hoodooLod(s: HoodooShape): THREE.LOD {
  const lod = new THREE.LOD();
  const levels: [number, number, boolean, number][] = [
    [40, 0.3, true, 0],
    [20, 0.8, true, 160],
    [10, 2.2, false, 480],
  ];
  for (const [segs, step, detail, dist] of levels) {
    const mesh = new THREE.Mesh(hoodooGeometry(s, segs, step, detail), rockMaterial());
    mesh.castShadow = mesh.receiveShadow = true;
    lod.addLevel(mesh, dist, 0.08);
  }
  return lod;
}

// ---------------------------------------------------------------------------------------------------
// Arches

/**
 * A natural arch as a swept tube in the local XY plane (X across the track): vertical legs from below
 * the ground up to `yc`, a semicircle of radius R over the track, and back down. The cross-section is an
 * ellipse, round and 9.4 m at the feet (the collider footprint) and a thinner, deeper fin at the crown,
 * displaced by 3D noise and strata ledges.
 */
function archGeometry(R: number, yc: number, footL: number, footR: number, seed: number): THREE.BufferGeometry {
  const AROUND = 36;
  const STEP = 1.1;
  const legL = yc - footL;
  const legR = yc - footR;
  const arc = Math.PI * R;
  const total = legL + arc + legR;
  const along = Math.ceil(total / STEP);
  const pos = new Float32Array((along + 1) * AROUND * 3);
  const C = new THREE.Vector3();
  const N = new THREE.Vector3();
  for (let i = 0; i <= along; i++) {
    const s = (i / along) * total;
    let feet = 1; // 1 on the legs, 0 at the crown
    if (s < legL) {
      C.set(-R, footL + s, 0);
      N.set(-1, 0, 0);
    } else if (s < legL + arc) {
      const th = Math.PI - ((s - legL) / arc) * Math.PI;
      C.set(R * Math.cos(th), yc + R * Math.sin(th), 0);
      N.set(Math.cos(th), Math.sin(th), 0);
      feet = Math.abs(Math.cos(th)) ** 1.3;
    } else {
      C.set(R, yc - (s - legL - arc), 0);
      N.set(1, 0, 0);
    }
    // Variable thickness along the span, kept steady near the feet so the footprint stays round.
    const swell = 1 + (noise3(s / 18, 0, 0, seed) - 0.5) * 0.3 * (1 - feet * 0.8);
    const a = (4.9 + 4.1 * feet) * swell;
    const b = (6.8 + 2.2 * feet) * swell;
    for (let j = 0; j < AROUND; j++) {
      const ph = (j / AROUND) * Math.PI * 2;
      const cp = Math.cos(ph);
      const sp = Math.sin(ph);
      let x = C.x + N.x * a * cp;
      let y = C.y + N.y * a * cp;
      let z = b * sp;
      // Displace along the section's outward direction (N cos + Z sin).
      const dx = N.x * cp;
      const dy = N.y * cp;
      const dz = sp;
      const ground = 1 - 0.6 * (1 - smoothstep(yc - 2, yc + 6, y)); // calmer near the ground
      let d = ((noise3(x / 9, y / 9, z / 9, seed + 1) - 0.5) * 2.4 + (noise3(x / 3.5, y / 3.5, z / 3.5, seed + 2) - 0.5) * 1.0) * ground;
      d += (noise3(x / 1.2, y / 1.2, z / 1.2, seed + 3) - 0.5) * 0.36;
      d += 0.5 * ledge((((y + seed) / 1.7) % 1 + 1) % 1) * (1 - Math.abs(dy));
      x += dx * d;
      y += dy * d;
      z += dz * d;
      pos.set([x, y, z], (i * AROUND + j) * 3);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < AROUND; j++) {
      const a = i * AROUND + j;
      const b = (i + 1) * AROUND + j;
      const c = i * AROUND + ((j + 1) % AROUND);
      const d = (i + 1) * AROUND + ((j + 1) % AROUND);
      // (this ring, next angle, next ring) winds outward for this frame (N, T, Z).
      idx.push(a, c, b, c, d, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------------------------------
// Rubble

/** A smooth lumpy boulder (welded icosphere, noise displaced). */
function boulderGeometry(detail: number, seed: number): THREE.BufferGeometry {
  const src = new THREE.IcosahedronGeometry(1, detail);
  src.deleteAttribute('normal');
  src.deleteAttribute('uv');
  // Icosahedron faces come unwelded; weld first so the displacement keeps the surface closed.
  const geo = mergeVertices(src);
  src.dispose();
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Two noise octaves for lumps, and a flat cut underneath so stones rest on the sand.
    const n = 1 + (noise3(x * 1.3, y * 1.3, z * 1.3, seed) - 0.5) * 0.55 + (noise3(x * 3.1, y * 3.1, z * 3.1, seed + 1) - 0.5) * 0.18;
    pos.setXYZ(i, x * n, Math.max(y * n, -0.35), z * n);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------------------------------
// Start / finish gate

/** Checkered banner cloth: crisp squares, a red hem and a faint woven texture so it reads as fabric. */
function checkerTexture(): THREE.CanvasTexture {
  const W = 2048;
  const H = 96;
  const HEM = 5;
  const COLS = 46;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const sq = (H - HEM * 2) / 2;
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? '#141414' : '#ececec';
      g.fillRect(Math.floor((x * W) / COLS), HEM + y * sq, Math.ceil(W / COLS) + 1, sq);
    }
  }
  g.fillStyle = '#8c2414';
  g.fillRect(0, 0, W, HEM);
  g.fillRect(0, H - HEM, W, HEM);
  const img = g.getImageData(0, 0, W, H);
  const rnd = new Rng(5);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const weave = ((x & 1) ^ (y & 1)) * 6 - 3;
      const v = weave + (rnd.float() - 0.5) * 10;
      const i = (y * W + x) * 4;
      img.data[i] += v;
      img.data[i + 1] += v;
      img.data[i + 2] += v;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Banded metal pylon as a lathe: a bevelled plinth, six tapering drums separated by chamfered grooves
 * (alternate drums painted), a collar and a pointed cap. Per-point colours give crisp bands without
 * extra materials.
 */
function pylonGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const cols: THREE.Color[] = [];
  const STEEL = new THREE.Color(0.62, 0.6, 0.56);
  const DARK = new THREE.Color(0.06, 0.06, 0.07);
  const PAINT = new THREE.Color(0.72, 0.24, 0.07);
  const add = (r: number, y: number, col: THREE.Color) => {
    pts.push(new THREE.Vector2(r, y));
    cols.push(col);
  };
  add(2.0, -1, DARK);
  add(2.0, 0.75, DARK);
  add(1.88, 0.95, DARK);
  add(1.7, 1.0, DARK);
  const DRUMS = 6;
  const y0 = 1.0;
  const span = (23.6 - y0) / DRUMS;
  for (let k = 0; k < DRUMS; k++) {
    const a = y0 + k * span;
    const r = THREE.MathUtils.lerp(1.6, 1.15, k / DRUMS);
    const r2 = THREE.MathUtils.lerp(1.6, 1.15, (k + 1) / DRUMS);
    const col = k % 2 ? PAINT : STEEL;
    add(r - 0.1, a + 0.06, col);
    add(r, a + 0.16, col);
    add(r2 + 0.02, a + span - 0.34, col);
    add(r2 - 0.06, a + span - 0.24, DARK);
    add(r2 - 0.16, a + span - 0.2, DARK);
    add(r2 - 0.16, a + span - 0.04, DARK);
  }
  add(1.45, 23.7, STEEL);
  add(1.5, 23.85, STEEL);
  add(1.5, 24.45, STEEL);
  add(1.32, 24.65, STEEL);
  add(0.55, 25.85, PAINT);
  add(0.3, 26.0, DARK);
  add(0, 26.05, DARK);
  const SEGS = 32;
  const geo = new THREE.LatheGeometry(pts, SEGS);
  const color = new Float32Array(geo.getAttribute('position').count * 3);
  // LatheGeometry lays vertices out segment by segment, each with every profile point in order.
  for (let i = 0; i <= SEGS; i++) {
    for (let j = 0; j < pts.length; j++) cols[j].toArray(color, (i * pts.length + j) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return geo;
}

/**
 * The banner: a cloth strip hanging from a sagging top cable between the pylons (parabolic sag, a
 * slightly longer drop in the middle) with a gentle wind billow that grows toward the free bottom edge.
 */
function bannerGeometry(halfSpan: number, top: number, height: number, sag: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(halfSpan * 2, height, 120, 8);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const s = pos.getX(i) / halfSpan;
    const v = 0.5 - pos.getY(i) / height; // 0 at the top edge, 1 at the bottom
    const slack = 1 - s * s;
    const y = top - sag * slack - v * height * (1 + 0.03 * slack);
    // Corners are pinned to the pylons (slack 0) and the top to the cable (v 0); the free middle billows.
    const billow = slack * v * (0.3 * Math.sin(s * 13 + 0.6) + 0.12 * Math.sin(s * 31 + v * 2));
    pos.setXYZ(i, pos.getX(i), y, billow + 0.18 * v * slack);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A cable between the pylons following the banner's sag. */
function cableGeometry(halfSpan: number, y: number, sag: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const s = (i / 24) * 2 - 1;
    pts.push(new THREE.Vector3(s * halfSpan, y - sag * (1 - s * s), 0));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.07, 6);
}

function buildGate(): THREE.Group {
  const gate = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.8, roughness: 0.34 });
  const pylonGeo = pylonGeometry();
  // Warm beacon on each pylon top: meant to glow, so it sits above the bloom threshold.
  const beaconMat = new THREE.MeshStandardMaterial({ color: 0x331100, emissive: new THREE.Color(1, 0.45, 0.12), emissiveIntensity: 2.2 });
  const beaconGeo = new THREE.SphereGeometry(0.42, 16, 10);
  const X = TRACK_HALF_WIDTH + 4;
  for (const s of [-1, 1]) {
    const pylon = new THREE.Mesh(pylonGeo, metal);
    pylon.position.x = s * X;
    pylon.castShadow = pylon.receiveShadow = true;
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    beacon.position.set(s * X, 26.45, 0);
    gate.add(pylon, beacon);
  }
  // The cloth hangs between the pylons' surfaces from a cable tied just under the collars.
  const half = X - 1.35;
  const TOP = 23.4;
  const SAG = 1.3;
  const HEIGHT = 3.2;
  const banner = new THREE.Mesh(
    bannerGeometry(half, TOP, HEIGHT, SAG),
    new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.82, side: THREE.DoubleSide }),
  );
  banner.castShadow = true;
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, metalness: 0.7, roughness: 0.45 });
  const cable = new THREE.Mesh(cableGeometry(X - 1.05, TOP + 0.05, SAG), cableMat);
  cable.castShadow = true;
  gate.add(banner, cable);
  return gate;
}

// ---------------------------------------------------------------------------------------------------

export function buildProps(track: Track): { group: THREE.Group; colliders: Collider[] } {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const p = new THREE.Vector3();
  const tng = new THREE.Vector3();
  const right = new THREE.Vector3();
  const hit: TrackHit = { dist: 0, floorY: 0, u: 0 };
  // `rng` drives placement and must keep its exact draw sequence (collider u/lat are part of the
  // course); everything purely visual draws from `deco`.
  const rng = new Rng(77);
  const deco = new Rng(1977);
  const place = (obj: THREE.Object3D, u: number, lateral: number) => {
    track.frame(u, p, tng, right);
    const x = p.x + right.x * lateral;
    const z = p.z + right.z * lateral;
    obj.position.set(x, groundHeight(track, x, z), z);
    obj.rotation.y = Math.atan2(-tng.x, -tng.z);
    group.add(obj);
  };
  const solid = (u: number, lat: number, r: number) => {
    track.frame(u, p, tng, right);
    colliders.push({ x: p.x + right.x * lat, z: p.z + right.z * lat, r, u: ((u % 1) + 1) % 1, lat });
  };

  // Rubble: collected as world transforms, built into instanced meshes at the end (3 draw calls).
  const big: THREE.Matrix4[] = [];
  const small: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  /** Scatter `count` stones of size [s0, s1] in a ring around (cx, cz), never on the racing bed. */
  const scatter = (list: THREE.Matrix4[], cx: number, cz: number, r0: number, r1: number, count: number, s0: number, s1: number) => {
    for (let i = 0; i < count; i++) {
      const a = deco.range(0, Math.PI * 2);
      const d = deco.range(r0, r1);
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const size = deco.range(s0, s1);
      track.nearest(x, z, hit, 260);
      if (hit.dist < TRACK_HALF_WIDTH + 4 + size) continue;
      e.set(deco.range(-0.4, 0.4), deco.range(0, Math.PI * 2), deco.range(-0.4, 0.4));
      q.setFromEuler(e);
      sc.set(size * deco.range(0.8, 1.25), size * deco.range(0.55, 0.85), size * deco.range(0.8, 1.25));
      // Sunk by a third so stones sit in the sand instead of on it (and never float on slopes).
      v.set(x, groundHeight(track, x, z) - sc.y * 0.35, z);
      list.push(new THREE.Matrix4().compose(v, q, sc));
    }
  };

  // Start / finish gate: two pylons and a checkered banner over the track.
  const gate = buildGate();
  place(gate, 0, 0);
  for (const s of [-1, 1]) solid(0, s * (TRACK_HALF_WIDTH + 4), 2);

  // Natural arches spanning the course.
  for (const u of [0.18, 0.47, 0.71]) {
    const R = TRACK_HALF_WIDTH + 14;
    track.frame(u, p, tng, right);
    const g0 = groundHeight(track, p.x, p.z);
    // Each leg reaches 4 m under its own ground, wherever the bank puts it.
    const feet: number[] = [];
    for (const s of [-1, 1]) {
      const fx = p.x + right.x * s * R;
      const fz = p.z + right.z * s * R;
      feet.push(Math.min(groundHeight(track, fx, fz) - g0 - 4, -5));
      scatter(big, fx, fz, 10, 16, 4, 0.9, 2.2);
      scatter(small, fx, fz, 9.5, 18, 12, 0.25, 0.7);
    }
    const arch = new THREE.Mesh(archGeometry(R, -4, feet[0], feet[1], Math.round(u * 100)), rockMaterial());
    arch.castShadow = arch.receiveShadow = true;
    place(arch, u, 0);
    for (const s of [-1, 1]) solid(u, s * R, 9);
  }

  /** Draws the tiers exactly as the original stacked-lump hoodoos did (same rng sequence). */
  const tiersOf = (minR: number, maxR: number, n: number): Tier[] => {
    const tiers: Tier[] = [];
    for (let k = 0; k < n; k++) {
      const r = rng.range(minR, maxR) * (1 - k * 0.18);
      tiers.push({ r, sy: rng.range(1.2, 1.8) });
    }
    return tiers;
  };
  /** Builds a hoodoo at (u, lat) and returns its collider radius (the visible footprint). */
  const hoodoo = (tiers: Tier[], seed: number, u: number, lat: number): number => {
    const base = Math.max(...tiers.map((t) => t.r));
    const r = base * 0.9;
    const lod = hoodooLod(hoodooShape(tiers, r, seed));
    place(lod, u, lat);
    lod.rotation.y += deco.range(0, Math.PI * 2);
    lod.updateMatrix();
    lod.matrixAutoUpdate = false;
    return r;
  };

  // Hoodoos either side of the track: a slalom for pods that run wide.
  for (let i = 0; i < 70; i++) {
    const tiers = tiersOf(3, 7, rng.int(2, 4));
    const u = rng.float();
    const lat = rng.sign() * rng.range(TRACK_HALF_WIDTH + 30, 200);
    const r = hoodoo(tiers, i, u, lat);
    solid(u, lat, r);
    const c = colliders[colliders.length - 1];
    scatter(big, c.x, c.z, r * 1.15, r * 1.15 + 5, deco.int(1, 3), 0.8, 2.0);
    scatter(small, c.x, c.z, r * 1.05, r * 1.05 + 7, deco.int(5, 10), 0.22, 0.65);
  }
  // Spires standing on the racing surface itself: the near-miss moments. Kept clear of the start
  // straight and the arches so the grid launch and the arch fly-throughs stay clean. No rubble here:
  // the bed stays clean apart from the spire itself.
  for (let i = 0; i < 14; i++) {
    let u = 0;
    do u = rng.range(0.04, 0.97);
    while ([0.18, 0.47, 0.71].some((a) => Math.abs(a - u) < 0.015));
    const tiers = tiersOf(2.2, 3.4, rng.int(3, 5));
    const lat = rng.sign() * rng.range(6, TRACK_HALF_WIDTH - 8);
    solid(u, lat, hoodoo(tiers, 100 + i, u, lat));
  }

  // Loose desert stones along the corridor margins, between the hoodoos.
  for (let i = 0; i < 160; i++) {
    const u = deco.float();
    const lat = deco.sign() * deco.range(TRACK_HALF_WIDTH + 8, 200);
    track.frame(u, p, tng, right);
    scatter(i % 4 ? small : big, p.x + right.x * lat, p.z + right.z * lat, 0, 4, i % 4 ? 3 : 1, 0.3, 1.6);
  }

  const mat = rockMaterial();
  const instanced = (geo: THREE.BufferGeometry, list: THREE.Matrix4[], shadows: boolean) => {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.computeBoundingSphere();
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  // Two big boulder shapes (alternating) so neighbouring stones do not repeat.
  instanced(boulderGeometry(2, 11), big.filter((_, i) => i % 2 === 0), true);
  instanced(boulderGeometry(2, 23), big.filter((_, i) => i % 2 === 1), true);
  instanced(boulderGeometry(1, 37), small, false);
  return { group, colliders };
}
