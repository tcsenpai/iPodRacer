// The living world around the course. Tatooine (venue 'mos-espa'): Mos Espa grandstands packed with
// fans at the start/finish, hangars and workshops by the grid, pennant lines over the track, moisture
// farms, a Jawa sandcrawler on a dune, Tusken camps on the canyon rims, bantha herds that scatter from
// passing pods and a distant Mos Espa skyline. Other planets ('paddock'): a smaller start area of
// grandstands in the planet's stone, crowd, towers, flags and pennant lines. Everything is code
// geometry merged per material (about 13 draw calls in total); motion (wind, cheering, walking) lives
// in vertex shaders, only the banthas keep a little CPU state.
import * as THREE from 'three';
import { Rng, clamp, damp, smoothstep } from '../core/rng';
import type { Collider } from './props';
import { groundHeight } from './terrain';
import type { Track, TrackHit } from './track';
import {
  ATLAS,
  Builder,
  adobeMaterial,
  banthaGeometry,
  banthaMaterial,
  box,
  boxUV,
  clothAtlas,
  clothMaterial,
  clothQuad,
  crowdMaterial,
  hullMaterial,
  metalMaterial,
  pennant,
  remapUV,
  rod,
  sandcrawler,
  spectatorGeometry,
  tr,
  vaporatorGeometry,
  type LifeUniforms,
} from './lifeModels';

export interface Life {
  group: THREE.Group;
  colliders: Collider[];
  /** Per frame: wind/crowd clock, crowd surge from nearby pods, bantha herds near the camera. */
  update(dt: number, camera: THREE.Camera, pods: readonly { pos: THREE.Vector3; speed: number }[]): void;
}

/** Nothing solid closer to the centreline than this (only cloth strung high above the track). */
const CLEAR = 60;
/** Prevailing wind (the dunes in terrain.ts run across the same axis): every flag streams this way. */
const WIND = new THREE.Vector3(0.8, 0, 0.6).normalize();
const WIND_YAW = Math.atan2(-WIND.z, WIND.x);

// Grandstands: tiers of seats stepping up and away from the track.
const TIERS = 10;
const TIER_DEPTH = 2.4;
const TIER_RISE = 1.5;
const SECTION = 24; // m of stand per section (sections follow the track's curve)
const STAND_FRONT = 64; // lateral offset of the front parapet
const STAND_DEPTH = 0.8 + TIERS * TIER_DEPTH + 1.2;
const ROYAL_SIDE = -1; // the Hutt's box sits on the left of the start line

const DARK = 0x1c1611;
const IRON = 0x5c5650;
const WOOD = 0x5a4632;
const CLOTHES = [0x8a5a3c, 0xc8b48e, 0x6b4a32, 0xa33a26, 0x3f5a78, 0xd6c8a8, 0x5d6b3a, 0x7a3f5e, 0xb88a3a, 0x4a4440, 0xe0d8c4, 0x2f3a4a];

/** Bantha herd: CPU state in flat arrays, rendered by one instanced mesh. */
interface Herd {
  mesh: THREE.InstancedMesh;
  anim: THREE.InstancedBufferAttribute;
  rng: Rng;
  n: number;
  /** Herd home and the track point it was placed from, with the outward (away from track) unit vector. */
  hx: number;
  hz: number;
  tx: number;
  tz: number;
  ox: number;
  oz: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  gy: Float32Array;
  vx: Float32Array;
  vz: Float32Array;
  yaw: Float32Array;
  phase: Float32Array;
  gait: Float32Array;
  graze: Float32Array;
  fear: Float32Array;
  fleeX: Float32Array;
  fleeZ: Float32Array;
  wx: Float32Array;
  wz: Float32Array;
  timer: Float32Array;
  scale: Float32Array;
  probe: number;
  acc: number;
}

const HERD_LEASH = 260; // m a bantha may stray from its herd's home
const HERD_WAKE = 1600; // m: herds farther from the camera are not simulated
const THREAT = 150; // m: a pod closer than this scares a bantha
const _mat = new THREE.Matrix4();

interface Spot {
  x: number;
  z: number;
  /** Outward unit vector (away from the track) and its yaw: structure local +Z points along it. */
  ox: number;
  oz: number;
  yaw: number;
  floor: number;
}

export function buildLife(track: Track): Life {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const uniforms: LifeUniforms = { uTime: { value: 0 }, uSurge: { value: 0 } };
  const L = track.length;
  const rng = new Rng(1977);
  const p = new THREE.Vector3();
  const tg = new THREE.Vector3();
  const rt = new THREE.Vector3();
  const hit: TrackHit = { dist: 0, floorY: 0, u: 0 };

  /** Frame of a structure at arc distance s (m), `lat` metres out on `side` (+1 right, -1 left). */
  const spot = (s: number, lat: number, side: number): Spot => {
    track.frame(s / L, p, tg, rt);
    const ox = rt.x * side;
    const oz = rt.z * side;
    return { x: p.x + ox * lat, z: p.z + oz * lat, ox, oz, yaw: Math.atan2(ox, oz), floor: p.y };
  };
  // Structure local (x along the track, z outward) to world x / z.
  const wx = (sp: Spot, lx: number, lz: number) => sp.x + sp.oz * lx + sp.ox * lz;
  const wz = (sp: Spot, lx: number, lz: number) => sp.z - sp.ox * lx + sp.oz * lz;
  /** Lowest and highest ground over a footprint (3 x 3 samples). */
  const seat = (sp: Spot, x0: number, x1: number, z0: number, z1: number): { lo: number; hi: number } => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= 2; i++) {
      for (let j = 0; j <= 2; j++) {
        const lx = x0 + ((x1 - x0) * i) / 2;
        const lz = z0 + ((z1 - z0) * j) / 2;
        const h = groundHeight(track, wx(sp, lx, lz), wz(sp, lx, lz));
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    return { lo, hi };
  };
  /** Circle collider for a solid footprint, recorded in track coordinates when near the course. */
  const solid = (x: number, z: number, r: number) => {
    track.nearest(x, z, hit, 400);
    if (hit.dist - r >= 160) return;
    track.frame(hit.u, p, tg, rt);
    colliders.push({ x, z, r, u: hit.u, lat: (x - p.x) * rt.x + (z - p.z) * rt.z });
  };
  const inCanyon = (x: number, z: number, k: number) => track.canyons.some((c) => Math.hypot(x - c.x, z - c.z) < c.r * k);
  const theme = track.def.theme;
  // Tatooine dresses the full Mos Espa venue and its desert life; other planets get the paddock.
  const mosEspa = theme.venue.kind === 'mos-espa';
  const ADOBE = theme.venue.tones;
  const TRIM = theme.venue.trim;
  const WALL = theme.venue.wall;
  const SECTIONS = mosEspa ? 8 : 5;
  const STAND_HALF = (SECTIONS * SECTION) / 2;

  const clothTex = clothAtlas();
  const cloth = clothMaterial(uniforms, clothTex);
  const adobe = adobeMaterial();

  // -------------------------------------------------------------------------------------------------
  // Start / finish: grandstands, the Hutt's box, towers, hangars, workshops, pennant lines.
  track.frame(0, p, tg, rt);
  const ax = p.x;
  const az = p.z;
  const ay = p.y;
  const walls = new Builder();
  const metal = new Builder();
  const cloths = new Builder({ aCloth: 3, aFlow: 3 }, true);
  const fans: number[] = []; // x, y, z, yaw, scale per fan (cluster-relative)
  const frameAt = (sp: Spot, y: number) => {
    const m = tr(sp.x - ax, y - ay, sp.z - az, sp.yaw);
    walls.setFrame(m);
    metal.setFrame(m);
    cloths.setFrame(m);
  };
  /** Flag on a pole whose foot is at local (x, y, z), streaming downwind whatever the frame's yaw. */
  const flag = (sp: Spot, x: number, y: number, z: number, pole: number, design: number) => {
    metal.add(new THREE.CylinderGeometry(0.1, 0.14, pole, 6), IRON, tr(x, y + pole / 2, z));
    cloths.add(clothQuad(3.4, 2.1, 6, 3, ATLAS.flags[design % 4], 'left', 0.35), 0xffffff, tr(x, y + pole - 0.1, z, WIND_YAW - sp.yaw));
  };
  const tower = (s: number, lat: number, side: number, r: number, h: number) => {
    const sp = spot(s, lat, side);
    const g = seat(sp, -r, r, -r, r);
    const F = g.hi - g.lo + 2;
    frameAt(sp, g.lo + 1);
    walls.add(new THREE.CylinderGeometry(r, r * 1.06, h + F, 20), WALL, tr(0, (h - F) / 2, 0));
    walls.add(new THREE.CylinderGeometry(r + 0.6, r + 0.6, 1.1, 20), TRIM, tr(0, h, 0));
    walls.add(new THREE.SphereGeometry(r * 0.95, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), TRIM, tr(0, h + 0.5, 0));
    for (const fy of [0.45, 0.65, 0.82]) walls.add(box(-0.45, h * fy, -r - 0.05, 0.45, h * fy + 1.7, -r + 0.4), DARK);
    flag(sp, 0, h + r * 0.9, 0, 6, rng.int(0, 3));
    solid(sp.x, sp.z, r + 0.3);
  };

  for (const side of [-1, 1]) {
    for (let sec = 0; sec < SECTIONS; sec++) {
      const s = -STAND_HALF + SECTION / 2 + sec * SECTION;
      const sp = spot(s, STAND_FRONT, side);
      const g = seat(sp, -SECTION / 2, SECTION / 2, 0, STAND_DEPTH);
      const base = (g.lo + g.hi) / 2;
      const F = base - g.lo + 2.5;
      frameAt(sp, base);
      const half = SECTION / 2;
      walls.add(box(-half, -F, 0, half, 1.9, 0.8), TRIM);
      for (let k = 0; k < TIERS; k++) {
        const z0 = 0.8 + k * TIER_DEPTH;
        const top = 1.4 + k * TIER_RISE;
        walls.add(box(-half, -F, z0, half, top, z0 + TIER_DEPTH), ADOBE[(k + sec) % 2]);
        // Stepped buttress walls between sections: they also hide the small gaps a curved stand opens.
        for (const dx of sec === 0 ? [-half, half] : [half]) walls.add(box(dx - 0.8, -F, z0, dx + 0.8, top + 1.4, z0 + TIER_DEPTH), WALL);
        // Fans on this tier, facing the track (the model faces local +Z, the track is local -Z).
        for (let x = -half + 1.2; x <= half - 1.2; x += 0.82) {
          if (rng.chance(0.13)) continue;
          if (mosEspa && side === ROYAL_SIDE && k >= 4 && Math.abs(s + side * x) < 11.5) continue;
          const fx = x + rng.range(-0.12, 0.12);
          const fz = z0 + 0.95 + rng.range(-0.1, 0.1);
          fans.push(wx(sp, fx, fz) - ax, base + top - ay, wz(sp, fx, fz) - az, sp.yaw + Math.PI + rng.range(-0.25, 0.25), rng.range(0.9, 1.12));
        }
      }
      const backZ = 0.8 + TIERS * TIER_DEPTH;
      const wallTop = 1.4 + (TIERS - 1) * TIER_RISE + 3.6;
      walls.add(box(-half, -F, backZ, half, wallTop, backZ + 1.2), WALL);
      for (let i = 0; i < 8; i++) walls.add(box(-half + i * 3 + 0.5, wallTop, backZ + 0.1, -half + i * 3 + 2, wallTop + 1.1, backZ + 1.1), WALL);
      // Striped canopy from the back wall over the upper tiers, on iron posts, with a valance and banners.
      const zf = 0.8 + 5 * TIER_DEPTH;
      const yb = wallTop - 0.3;
      const yf = yb - 2.4;
      const post = 1.4 + 5 * TIER_RISE;
      for (const px of [-half + 1, half - 1]) metal.add(new THREE.CylinderGeometry(0.12, 0.12, yf - post, 6), IRON, tr(px, (yf + post) / 2, zf + 0.2));
      cloths.add(clothQuad(SECTION, Math.hypot(backZ - zf, yb - yf), 8, 4, ATLAS.stripes, 'edges', 0.2), 0xffffff, tr(0, yb, backZ, 0, 1, 1, 1, Math.atan2(backZ - zf, yb - yf)));
      cloths.add(clothQuad(SECTION, 0.9, 8, 1, ATLAS.stripes, 'top', 0.1), 0xffffff, tr(0, yf, zf));
      for (const bx of [-6, 6]) cloths.add(clothQuad(2.4, 6.3, 2, 6, ATLAS.banners[(sec + (bx > 0 ? 1 : 0) + (side > 0 ? 2 : 0)) % 5], 'top', 0.25), 0xffffff, tr(bx, yf - 0.1, zf - 0.15));
      flag(sp, half, wallTop, backZ + 0.6, 6.5, sec + side + 1);
      // Two rows of three circles: the front row hugs the parapet so pods cannot clip into the seats.
      for (let c = 0; c < 6; c++) {
        const lx = -8 + (c % 3) * 8;
        const lz = c < 3 ? 9.5 : 16.5;
        solid(wx(sp, lx, lz), wz(sp, lx, lz), 9.5);
      }
    }
    // Round towers closing the stand ends, two more rising behind it.
    for (const s of [-STAND_HALF - 8, STAND_HALF + 8]) tower(s, STAND_FRONT + 7, side, 5.5, 24);
    for (const s of [-48, 48]) tower(s, STAND_FRONT + STAND_DEPTH + 6, side, 4.5, 27);
  }

  // The Hutt's box: a raised block over the upper tiers with a dark viewing gallery, canopy and banners.
  if (mosEspa) {
    const sp = spot(0, STAND_FRONT, ROYAL_SIDE);
    const g = seat(sp, -11, 11, 10, 30);
    const base = (g.lo + g.hi) / 2;
    const F = base - g.lo + 2.5;
    frameAt(sp, base);
    walls.add(box(-10.5, -F, 10.4, 10.5, 24, 30), WALL);
    walls.add(box(-8, 13, 10.2, 8, 19, 10.5), DARK);
    walls.add(box(-9, 12.4, 8.4, 9, 13, 10.4), TRIM);
    walls.add(box(-9, 13, 8.4, 9, 13.9, 8.9), TRIM);
    walls.add(box(-11, 23.6, 9.8, 11, 24.7, 30.6), TRIM);
    walls.add(new THREE.SphereGeometry(7.5, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2), TRIM, tr(0, 24.5, 20));
    cloths.add(clothQuad(17, 3.4, 8, 3, ATLAS.stripes, 'edges', 0.15), 0xffffff, tr(0, 21.2, 10.4, 0, 1, 1, 1, 1.0));
    for (const bx of [-9.6, 9.6]) cloths.add(clothQuad(2.2, 9, 2, 8, ATLAS.banners[bx > 0 ? 4 : 0], 'top', 0.2), 0xffffff, tr(bx, 22.8, 10.25));
    flag(sp, 0, 31.5, 20, 7, 2);
  }

  // Hangars and workshops behind the grid (Mos Espa only; the grid runs to about s = -110).
  for (const side of mosEspa ? [-1, 1] : []) {
    for (const s of [-175, -245, -315]) {
      const sp = spot(s, 72, side);
      const g = seat(sp, -18, 18, 0, 28);
      const F = g.hi - g.lo + 1.5;
      frameAt(sp, g.hi);
      const tone = ADOBE[rng.int(0, 3)];
      walls.add(box(-18, -F, 0, -12, 10, 1.5), tone);
      walls.add(box(12, -F, 0, 18, 10, 1.5), tone);
      walls.add(box(-12, 8, 0, 12, 10, 1.5), tone);
      walls.add(box(-18, -F, 1.5, -16.5, 10, 28), tone);
      walls.add(box(16.5, -F, 1.5, 18, 10, 28), tone);
      walls.add(box(-16.5, -F, 26.5, 16.5, 10, 28), tone);
      walls.add(box(-16.5, -F, 10, 16.5, 9.5, 26.5), DARK);
      // Flattened barrel vault: half cylinder turned onto the depth axis, capped at both ends. The scale
      // acts before the turn, so squashing the cylinder's z flattens the vault's height.
      walls.add(new THREE.CylinderGeometry(18.4, 18.4, 28, 24, 1, false, Math.PI / 2, Math.PI), TRIM, tr(0, 10, 14, 0, 1, 1, 0.42, Math.PI / 2));
      for (const fx of [-12.2, 11.8]) metal.add(box(0, 0, -0.1, 0.4, 8, 0.3), IRON, tr(fx, 0, 0));
      metal.add(box(-12.2, 7.7, -0.1, 12.2, 8.1, 0.3), IRON);
      metal.add(new THREE.CylinderGeometry(0.15, 0.2, 9, 6), IRON, tr(14, 14, 20));
      metal.add(new THREE.SphereGeometry(0.9, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), 0x8a8580, tr(14, 18.6, 20, 0, 1, 1, 1, -0.7));
      for (const cx of [-9, 9]) solid(wx(sp, cx, 14), wz(sp, cx, 14), 16);
      // Crates stacked by the door and a pod engine on trestles awaiting its pilot.
      frameAt(sp, groundHeight(track, wx(sp, -15, -4), wz(sp, -15, -4)));
      for (let c = 0; c < 4; c++) {
        const cs = rng.range(1.1, 1.7);
        walls.add(box(-cs / 2, 0, -cs / 2, cs / 2, cs, cs / 2), 0x7a6650, tr(-15 + (c % 2) * 1.8, Math.floor(c / 2) * 1.5, -4 + rng.range(-0.3, 0.3), rng.range(-0.3, 0.3)));
      }
      solid(wx(sp, -14, -4), wz(sp, -14, -4), 2.2);
      frameAt(sp, groundHeight(track, wx(sp, 6, -5), wz(sp, 6, -5)));
      metal.add(new THREE.CylinderGeometry(1.1, 1.3, 7, 12), 0x9a948a, tr(6, 2.2, -5, 0, 1, 1, 1, 0, Math.PI / 2));
      metal.add(new THREE.CylinderGeometry(0.9, 1.1, 1.2, 12), 0x3a3632, tr(9.9, 2.2, -5, 0, 1, 1, 1, 0, Math.PI / 2));
      for (const tx of [3.5, 8.5]) metal.add(box(-0.2, 0, -0.9, 0.2, 1.3, 0.9), IRON, tr(tx, 0, -5));
      solid(wx(sp, 6, -5), wz(sp, 6, -5), 4);
    }
    // Domed workshops between the hangars.
    for (const s of [-210, -280, -345]) {
      const sp = spot(s, 84, side);
      const g = seat(sp, -4.5, 4.5, -4.5, 4.5);
      frameAt(sp, g.lo);
      const h = g.hi - g.lo + 3.5;
      walls.add(new THREE.CylinderGeometry(4.2, 4.4, h, 18), ADOBE[3], tr(0, h / 2, 0));
      walls.add(new THREE.SphereGeometry(4.3, 18, 7, 0, Math.PI * 2, 0, Math.PI / 2), TRIM, tr(0, h, 0));
      walls.add(box(-1, g.hi - g.lo, -4.5, 1, g.hi - g.lo + 2.4, -3.6), DARK);
      metal.add(new THREE.CylinderGeometry(0.08, 0.1, 5, 5), IRON, tr(1.5, h + 5, 1));
      solid(sp.x, sp.z, 4.5);
    }
  }

  // Pennant lines strung over the track (the only things above the racing bed: lowest point > 20 m).
  for (const s of [125, -140]) {
    const spL = spot(s, CLEAR + 4, -1);
    const spR = spot(s, CLEAR + 4, 1);
    const gl = groundHeight(track, spL.x, spL.z);
    const gr = groundHeight(track, spR.x, spR.z);
    const top = Math.max(gl, gr, spL.floor + 8) + 26;
    const sag = 5;
    metal.resetFrame();
    cloths.resetFrame();
    for (const [sp, gy] of [
      [spL, gl],
      [spR, gr],
    ] as const) {
      metal.add(new THREE.CylinderGeometry(0.35, 0.55, top - gy + 2, 8), IRON, tr(sp.x - ax, (top + gy - 2) / 2 - ay, sp.z - az));
      solid(sp.x, sp.z, 0.8);
    }
    const x0 = spL.x - ax;
    const z0 = spL.z - az;
    const dx = spR.x - spL.x;
    const dz = spR.z - spL.z;
    const span = Math.hypot(dx, dz);
    const cable = (f: number) => top - ay - sag * 4 * f * (1 - f);
    const SEGS = 24;
    for (let i = 0; i < SEGS; i++) {
      const f0 = i / SEGS;
      const f1 = (i + 1) / SEGS;
      rod(metal, x0 + dx * f0, cable(f0), z0 + dz * f0, x0 + dx * f1, cable(f1), z0 + dz * f1, 0.05, 0x2a2622);
    }
    const wide = s < 0;
    for (let d = 1.2; d + 1.4 < span; d += 2.3) {
      if (wide && Math.abs(d - span / 2) < 9.5) continue;
      const f0 = d / span;
      const f1 = (d + 1.4) / span;
      const design = ATLAS.flags[Math.floor(d / 2.3) % 4];
      cloths.add(pennant(x0 + dx * f0, cable(f0), z0 + dz * f0, x0 + dx * f1, cable(f1), z0 + dz * f1, 2.2, design, 0.35), 0xffffff);
    }
    if (wide) cloths.add(clothQuad(16, 4.5, 10, 4, ATLAS.wide, 'top', 0.3), 0xffffff, tr(x0 + dx / 2, cable(0.5), z0 + dz / 2, Math.atan2(-dz, dx)));
  }

  const startGeo = walls.build();
  boxUV(startGeo, 4);
  const startWalls = new THREE.Mesh(startGeo, adobe);
  const startMetal = new THREE.Mesh(metal.build(), metalMaterial());
  const startCloth = new THREE.Mesh(cloths.build(), cloth);
  for (const m of [startWalls, startMetal, startCloth]) {
    m.position.set(ax, ay, az);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }

  // Crowd: every fan in one instanced mesh.
  const fanCount = fans.length / 5;
  const crowdGeo = spectatorGeometry();
  const seeds = new Float32Array(fanCount);
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMaterial(uniforms), fanCount);
  const col = new THREE.Color();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < fanCount; i++) {
    const k = i * 5;
    q.setFromAxisAngle(up, fans[k + 3]);
    const s = fans[k + 4];
    _mat.compose(p.set(fans[k], fans[k + 1], fans[k + 2]), q, sc.set(s * rng.range(0.92, 1.08), s, s));
    crowd.setMatrixAt(i, _mat);
    crowd.setColorAt(i, col.set(rng.pick(CLOTHES)).multiplyScalar(rng.range(0.75, 1.15)));
    seeds[i] = rng.float();
  }
  crowdGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  crowd.position.set(ax, ay, az);
  crowd.computeBoundingSphere();
  // Jumps and raised arms reach a little past the rest pose the sphere was computed from.
  if (crowd.boundingSphere) crowd.boundingSphere.radius += 3;
  crowd.receiveShadow = true;
  group.add(crowd);

  // -------------------------------------------------------------------------------------------------
  // Moisture vaporators: small farms dotted along the course (Tatooine).
  if (mosEspa) {
    const vaps: number[] = [];
    const vapAt = (x: number, z: number) => {
      vaps.push(x, groundHeight(track, x, z) - 0.15, z, rng.range(0, Math.PI * 2), rng.range(0.85, 1.2));
      solid(x, z, 0.9);
    };
    for (let n = 0; n < 60; ) {
      const u = rng.float();
      const lat = rng.sign() * rng.range(CLEAR + 15, 280);
      const sp = spot(u * L, lat, 1);
      // Keep the farms clear of the start complex (hangars at s = -360 up to the pennants at s = +125).
      if (inCanyon(sp.x, sp.z, 0.9) || Math.abs(((u + 0.5) % 1) - 0.5) * L < 450) continue;
      const k = rng.int(1, 3);
      for (let j = 0; j < k; j++) {
        const a = rng.range(0, Math.PI * 2);
        const d = j === 0 ? 0 : rng.range(7, 14);
        const x = sp.x + Math.cos(a) * d;
        const z = sp.z + Math.sin(a) * d;
        track.nearest(x, z, hit, 120);
        if (hit.dist > CLEAR + 5) vapAt(x, z);
      }
      n++;
    }
    for (const side of [-1, 1]) {
      for (const s of [-200, -260, -330, 170]) {
        const sp = spot(s, rng.range(115, 140), side);
        vapAt(sp.x, sp.z);
      }
    }
    const vapCount = vaps.length / 5;
    const vapMesh = new THREE.InstancedMesh(vaporatorGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.55 }), vapCount);
    for (let i = 0; i < vapCount; i++) {
      const k = i * 5;
      q.setFromAxisAngle(up, vaps[k + 3]);
      _mat.compose(p.set(vaps[k], vaps[k + 1], vaps[k + 2]), q, sc.setScalar(vaps[k + 4]));
      vapMesh.setMatrixAt(i, _mat);
    }
    vapMesh.computeBoundingSphere();
    vapMesh.castShadow = vapMesh.receiveShadow = true;
    group.add(vapMesh);
  }

  // -------------------------------------------------------------------------------------------------
  // Jawa sandcrawler parked on the highest dune crest overlooking the opening straight (Tatooine).
  if (mosEspa) {
    let best = -Infinity;
    let bx = 0;
    let bz = 0;
    let bsp = spot(0, 0, 1);
    for (let s = 260; s <= 900; s += 80) {
      for (const lat of [-460, -380, -300, 300, 380, 460]) {
        const sp = spot(s, lat, 1);
        if (inCanyon(sp.x, sp.z, 1)) continue;
        const h = groundHeight(track, sp.x, sp.z);
        if (h > best) {
          best = h;
          bx = sp.x;
          bz = sp.z;
          bsp = sp;
        }
      }
    }
    // Three-quarter view from the track: face it, then turn away a little.
    const yaw = Math.atan2(-bsp.ox, -bsp.oz) + 0.7;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const corner = (lx: number, lz: number) => groundHeight(track, bx + fz * lx + fx * lz, bz - fx * lx + fz * lz);
    const fl = corner(-10, 26);
    const fr = corner(10, 26);
    const bl = corner(-10, -26);
    const br = corner(10, -26);
    const hb = new Builder();
    sandcrawler(hb);
    const geo = hb.build();
    boxUV(geo, 6);
    const crawler = new THREE.Mesh(geo, hullMaterial());
    crawler.position.set(bx, (fl + fr + bl + br) / 4 - 0.8, bz);
    crawler.rotation.set(-Math.atan2((fl + fr - bl - br) / 2, 52), yaw, Math.atan2((fr + br - fl - bl) / 2, 20), 'YXZ');
    crawler.castShadow = crawler.receiveShadow = true;
    group.add(crawler);
    for (const lz of [-18, 0, 18]) solid(bx + fx * lz, bz + fz * lz, 12);
  }

  // -------------------------------------------------------------------------------------------------
  // Tusken camps on the canyon rims, overlooking the track below.
  for (const c of theme.tuskens ? track.canyons : []) {
    let bu = 0;
    let bd = Infinity;
    for (let i = 0; i < 512; i++) {
      track.frame(i / 512, p, tg, rt);
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d < bd) {
        bd = d;
        bu = i / 512;
      }
    }
    const s = bu * L + 60;
    const a = spot(s, 92, 1);
    const b = spot(s, 92, -1);
    const sp = groundHeight(track, a.x, a.z) > groundHeight(track, b.x, b.z) ? a : b;
    const cy = groundHeight(track, sp.x, sp.z);
    const camp = new Builder({ aCloth: 3, aFlow: 3 }, true);
    camp.setFrame(tr(0, 0, 0, sp.yaw));
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const lx = Math.cos(ang) * 13;
      const lz = Math.sin(ang) * 13;
      const r = rng.range(2.8, 3.6);
      const h = rng.range(3.2, 4.2);
      const gy = groundHeight(track, wx(sp, lx, lz), wz(sp, lx, lz)) - cy;
      const tent = new THREE.ConeGeometry(r, h, 9, 3, true);
      remapUV(tent, ATLAS.rag);
      // Ragged hides: jitter the cone, then let the hem flutter (pinned at the apex).
      const pos = tent.getAttribute('position');
      const clothA = new Float32Array(pos.count * 3);
      const flow = new Float32Array(pos.count * 3);
      // Seeded by angle (whole multiples of the turn), so the duplicated uv-seam vertices move together.
      const ph = rng.range(0, 6);
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const j = 1 + Math.sin(Math.atan2(pos.getZ(i), pos.getX(i)) * 3 + ph) * 0.09 * (0.5 - y / h);
        pos.setXYZ(i, pos.getX(i) * j, y, pos.getZ(i) * j);
        clothA.set([clamp(0.5 - y / h, 0, 1), h, 0.12], i * 3);
        flow.set([0, -1, 0], i * 3);
      }
      tent.computeVertexNormals();
      tent.setAttribute('aCloth', new THREE.BufferAttribute(clothA, 3));
      tent.setAttribute('aFlow', new THREE.BufferAttribute(flow, 3));
      camp.add(tent, 0xffffff, tr(lx, gy + h / 2 - 0.3, lz, rng.range(0, 6)));
      for (let pole = 0; pole < 3; pole++) {
        camp.add(remapUV(new THREE.CylinderGeometry(0.06, 0.08, 1.6, 4), ATLAS.plain), WOOD, tr(lx, gy + h - 0.1, lz, pole * 2.1, 1, 1, 1, 0.35));
      }
      solid(wx(sp, lx, lz), wz(sp, lx, lz), r);
    }
    // Fire ring, a hide windbreak and a rag standard.
    for (let k = 0; k < 9; k++) {
      const ang = (k / 9) * Math.PI * 2;
      camp.add(remapUV(new THREE.DodecahedronGeometry(0.42, 0), ATLAS.plain), 0x6e6458, tr(Math.cos(ang) * 1.6, 0.1, Math.sin(ang) * 1.6, ang));
    }
    camp.add(remapUV(new THREE.CylinderGeometry(1.3, 1.3, 0.1, 9), ATLAS.plain), 0x1e1814, tr(0, 0.02, 0));
    for (const px of [-3, 3]) camp.add(remapUV(new THREE.CylinderGeometry(0.08, 0.1, 2.6, 5), ATLAS.plain), WOOD, tr(px, 1.3, 6));
    camp.add(clothQuad(6, 2.2, 5, 2, ATLAS.rag, 'top', 0.18), 0xffffff, tr(0, 2.5, 6));
    camp.add(remapUV(new THREE.CylinderGeometry(0.07, 0.1, 7, 5), ATLAS.plain), WOOD, tr(-5, 3.5, -4));
    camp.add(clothQuad(1.2, 3.6, 2, 5, ATLAS.rag, 'top', 0.35), 0xffffff, tr(-4.4, 6.8, -4, WIND_YAW - sp.yaw));
    const mesh = new THREE.Mesh(camp.build(), cloth);
    mesh.position.set(sp.x, cy, sp.z);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }

  // -------------------------------------------------------------------------------------------------
  // Bantha herds grazing in the open desert, a little way off the course.
  const herds: Herd[] = [];
  const banthaGeo = banthaGeometry();
  const banthaMat = banthaMaterial(uniforms);
  const herdSpots = mosEspa
    ? ([
        [0.13, 1],
        [0.31, -1],
        [0.57, 1],
        [0.83, -1],
      ] as const)
    : [];
  for (const [u0, side] of herdSpots) {
    let u = u0;
    let sp = spot(u * L, 175, side);
    for (let tries = 0; tries < 12 && inCanyon(sp.x, sp.z, 1.1); tries++) {
      u += 0.03;
      sp = spot(u * L, 175, side);
    }
    const n = rng.int(8, 12);
    const geo = banthaGeo.clone();
    const anim = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    anim.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAnim', anim);
    const mesh = new THREE.InstancedMesh(geo, banthaMat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    track.frame(u, p, tg, rt);
    const h: Herd = {
      mesh,
      anim,
      rng: new Rng(500 + herds.length),
      n,
      hx: sp.x,
      hz: sp.z,
      tx: p.x,
      tz: p.z,
      ox: sp.ox,
      oz: sp.oz,
      x: new Float32Array(n),
      y: new Float32Array(n),
      z: new Float32Array(n),
      gy: new Float32Array(n),
      vx: new Float32Array(n),
      vz: new Float32Array(n),
      yaw: new Float32Array(n),
      phase: new Float32Array(n),
      gait: new Float32Array(n),
      graze: new Float32Array(n),
      fear: new Float32Array(n),
      fleeX: new Float32Array(n),
      fleeZ: new Float32Array(n),
      wx: new Float32Array(n),
      wz: new Float32Array(n),
      timer: new Float32Array(n),
      scale: new Float32Array(n),
      probe: 0,
      acc: 0,
    };
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0, 28);
      h.x[i] = h.wx[i] = sp.x + Math.cos(a) * d;
      h.z[i] = h.wz[i] = sp.z + Math.sin(a) * d;
      h.y[i] = h.gy[i] = groundHeight(track, h.x[i], h.z[i]) - 0.1;
      h.yaw[i] = rng.range(0, Math.PI * 2);
      h.phase[i] = rng.range(0, 6);
      h.graze[i] = 1;
      h.timer[i] = rng.range(0, 8);
      h.scale[i] = rng.range(0.85, 1.15);
      mesh.setColorAt(i, col.setRGB(0.42, 0.31, 0.22).multiplyScalar(rng.range(0.6, 1.2)));
      writeBantha(h, i);
    }
    // The herd never leaves its leash, so a fixed sphere bounds every pose it can take.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(sp.x, h.y[0], sp.z), HERD_LEASH + 40);
    mesh.castShadow = mesh.receiveShadow = true;
    herds.push(h);
    group.add(mesh);
  }
  banthaGeo.dispose();

  // -------------------------------------------------------------------------------------------------
  // Mos Espa on the northern horizon: low-detail domes, blocks and towers that read as a silhouette.
  if (mosEspa) {
    const city = new Builder();
    const cx = 700;
    const cz = -4600;
    for (let i = 0; i < 140; i++) {
      const x = cx + rng.range(-2300, 2300) * (0.4 + 0.6 * rng.float());
      const z = cz + rng.range(-450, 450);
      const gy = groundHeight(track, x, z) - 4;
      const tone = ADOBE[rng.int(0, 3)];
      const kind = rng.float();
      city.setFrame(tr(x - cx, gy, z - cz, rng.range(0, Math.PI)));
      if (kind < 0.5) {
        const w = rng.range(14, 40);
        const d = rng.range(12, 30);
        const hgt = rng.range(8, 20);
        city.add(box(-w / 2, 0, -d / 2, w / 2, hgt, d / 2), tone);
        if (rng.chance(0.5)) city.add(new THREE.SphereGeometry(Math.min(w, d) * 0.35, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2), TRIM, tr(0, hgt, 0));
      } else if (kind < 0.85) {
        const r = rng.range(8, 16);
        city.add(new THREE.CylinderGeometry(r, r * 1.05, r * 0.6, 14), tone, tr(0, r * 0.3, 0));
        city.add(new THREE.SphereGeometry(r, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), TRIM, tr(0, r * 0.6, 0));
      } else {
        const r = rng.range(4, 7);
        const hgt = rng.range(26, 50);
        city.add(new THREE.CylinderGeometry(r * 0.8, r, hgt, 12), tone, tr(0, hgt / 2, 0));
        city.add(new THREE.SphereGeometry(r, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2), TRIM, tr(0, hgt, 0));
      }
    }
    const geo = city.build();
    boxUV(geo, 12);
    const skyline = new THREE.Mesh(geo, adobe);
    skyline.position.set(cx, 0, cz);
    group.add(skyline);
  }

  // -------------------------------------------------------------------------------------------------
  let time = 0;
  const THREAT2 = THREAT * THREAT;

  /** Advance one herd by `dt` (fleeing, wandering, grazing) and upload its instances. */
  const simulate = (h: Herd, dt: number, pods: readonly { pos: THREE.Vector3; speed: number }[]) => {
    let alarmed = false;
    for (let i = 0; i < h.n; i++) {
      const x = h.x[i];
      const z = h.z[i];
      let fx = 0;
      let fz = 0;
      let threat = 0;
      for (let k = 0; k < pods.length; k++) {
        const pod = pods[k];
        const dx = x - pod.pos.x;
        const dz = z - pod.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > THREAT2 || d2 < 1 || pod.speed < 8) continue;
        const d = Math.sqrt(d2);
        const w = 1 - d / THREAT;
        fx += (dx / d) * w;
        fz += (dz / d) * w;
        threat = Math.max(threat, w);
      }
      if (threat > 0) {
        const fl = Math.hypot(fx, fz);
        h.fleeX[i] = fx / fl;
        h.fleeZ[i] = fz / fl;
        h.fear[i] = Math.min(1, Math.max(h.fear[i], 0.6 + threat));
      }
      h.fear[i] = Math.max(0, h.fear[i] - dt * 0.12);
      const fear = h.fear[i];
      let dvx = 0;
      let dvz = 0;
      if (fear > 0.05) {
        dvx = h.fleeX[i] * fear * 11;
        dvz = h.fleeZ[i] * fear * 11;
        alarmed = true;
      } else {
        h.timer[i] -= dt;
        if (h.timer[i] < 0) {
          // Either graze where it stands or amble to a new spot near the herd's home.
          h.timer[i] = h.rng.range(5, 14);
          if (h.rng.chance(0.45)) {
            const a = h.rng.range(0, Math.PI * 2);
            const d = h.rng.range(0, 34);
            h.wx[i] = h.hx + Math.cos(a) * d;
            h.wz[i] = h.hz + Math.sin(a) * d;
          } else {
            h.wx[i] = x;
            h.wz[i] = z;
          }
        }
        const ex = h.wx[i] - x;
        const ez = h.wz[i] - z;
        const ed = Math.hypot(ex, ez);
        if (ed > 2) {
          const sp = Math.min(1.3, ed * 0.3);
          dvx = (ex / ed) * sp;
          dvz = (ez / ed) * sp;
        }
      }
      // Keep a little personal space.
      for (let j = 0; j < h.n; j++) {
        if (j === i) continue;
        const sx = x - h.x[j];
        const sz = z - h.z[j];
        const s2 = sx * sx + sz * sz;
        if (s2 < 36 && s2 > 0.01) {
          const s = (6 - Math.sqrt(s2)) * 0.5;
          dvx += sx * s;
          dvz += sz * s;
        }
      }
      // Never stampede onto the course, never wander off for good.
      const lat = (x - h.tx) * h.ox + (z - h.tz) * h.oz;
      if (lat < 110) {
        dvx += h.ox * (110 - lat) * 0.15;
        dvz += h.oz * (110 - lat) * 0.15;
      }
      const hx = h.hx - x;
      const hz = h.hz - z;
      const hd = Math.hypot(hx, hz);
      if (hd > HERD_LEASH - 40) {
        const pull = (hd - HERD_LEASH + 40) * 0.2;
        dvx += (hx / hd) * pull;
        dvz += (hz / hd) * pull;
      }
      const k = damp(fear > 0.05 ? 2.2 : 1.2, dt);
      h.vx[i] += (dvx - h.vx[i]) * k;
      h.vz[i] += (dvz - h.vz[i]) * k;
      let nx = x + h.vx[i] * dt;
      let nz = z + h.vz[i] * dt;
      const nd = Math.hypot(nx - h.hx, nz - h.hz);
      if (nd > HERD_LEASH) {
        nx = h.hx + ((nx - h.hx) / nd) * HERD_LEASH;
        nz = h.hz + ((nz - h.hz) / nd) * HERD_LEASH;
      }
      h.x[i] = nx;
      h.z[i] = nz;
      const speed = Math.hypot(h.vx[i], h.vz[i]);
      if (speed > 0.25) {
        let dy = Math.atan2(h.vx[i], h.vz[i]) - h.yaw[i];
        dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
        h.yaw[i] += dy * damp(3, dt);
      }
      h.gait[i] = clamp(speed / 7, 0, 1);
      h.phase[i] += dt * (speed * 2.1 + (speed > 0.25 ? 0.6 : 0));
      h.graze[i] += ((speed < 0.3 && fear < 0.05 ? 1 : 0) - h.graze[i]) * damp(1.5, dt);
      h.y[i] += (h.gy[i] - h.y[i]) * damp(6, dt);
    }
    // groundHeight is costly: re-sample a few animals per step, more while the herd is running.
    const probes = alarmed ? 3 : 1;
    for (let k = 0; k < probes; k++) {
      const i = h.probe;
      h.probe = (h.probe + 1) % h.n;
      h.gy[i] = groundHeight(track, h.x[i], h.z[i]) - 0.1;
    }
    for (let i = 0; i < h.n; i++) writeBantha(h, i);
    h.mesh.instanceMatrix.needsUpdate = true;
    h.anim.needsUpdate = true;
  };

  return {
    group,
    colliders,
    update(dt, camera, pods) {
      const step = Math.min(dt, 0.1);
      time += step;
      uniforms.uTime.value = time;
      const e = camera.matrixWorld.elements;
      const camX = e[12];
      const camZ = e[14];

      // Crowd surge: the closer and faster a pod passes the stands, the louder the stands go.
      let target = 0;
      for (let k = 0; k < pods.length; k++) {
        const pod = pods[k];
        const d = Math.hypot(pod.pos.x - ax, pod.pos.z - az);
        target = Math.max(target, smoothstep(320, 80, d) * clamp(pod.speed / 100, 0.2, 1));
      }
      const surge = uniforms.uSurge.value;
      uniforms.uSurge.value = surge + (target - surge) * damp(target > surge ? 5 : 0.7, step);
      // Fans are a metre tall: past a few kilometres they are sub-pixel, skip the 300k triangles.
      crowd.visible = Math.hypot(camX - ax, camZ - az) < 3500;

      for (let n = 0; n < herds.length; n++) {
        const h = herds[n];
        const camD = Math.hypot(camX - h.hx, camZ - h.hz);
        if (camD > HERD_WAKE) continue;
        h.acc += step;
        // Calm herds far from the camera tick at 15 Hz: nobody can tell from there.
        let calm = true;
        for (let i = 0; i < h.n && calm; i++) calm = h.fear[i] <= 0.05;
        if (calm && camD > 500 && h.acc < 1 / 15) continue;
        simulate(h, h.acc, pods);
        h.acc = 0;
      }
    },
  };
}

/** Upload one bantha's transform and animation state (no allocations: shared scratch matrix). */
function writeBantha(h: Herd, i: number): void {
  const s = h.scale[i];
  const c = Math.cos(h.yaw[i]) * s;
  const sn = Math.sin(h.yaw[i]) * s;
  const te = _mat.elements;
  te[0] = c;
  te[1] = 0;
  te[2] = -sn;
  te[3] = 0;
  te[4] = 0;
  te[5] = s;
  te[6] = 0;
  te[7] = 0;
  te[8] = sn;
  te[9] = 0;
  te[10] = c;
  te[11] = 0;
  te[12] = h.x[i];
  te[13] = h.y[i];
  te[14] = h.z[i];
  te[15] = 1;
  h.mesh.setMatrixAt(i, _mat);
  h.anim.setXYZ(i, h.phase[i], h.gait[i], h.graze[i]);
}
