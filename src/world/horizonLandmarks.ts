// Procedural landmark silhouettes for the far horizon, 5.5 to 9.5 km from the course centre. They are seen
// from kilometres away through haze, so each one is built for its outline: exaggerated scale, few strong
// shapes, flat-shaded faceted rock. Everything merges into one vertex-coloured geometry (one draw call);
// fire and lava sprites and smoke columns are returned as data for horizon.ts to draw.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { noise2 } from './noise';
import { Builder, box, rod, tr } from './lifeModels';

/** Where a landmark stands: compass bearing (radians, 0 = north/-Z, clockwise toward +X) and distance (m). */
export interface LandmarkSite {
  bearing: number;
  dist: number;
}

/**
 * Fixed sites per landmark. Tatooine's set fans around the course without overlaps: Mos Espa's spires just
 * behind the town skyline to the north, Mushroom Mesa backlit toward the suns (north-east), the krayt
 * skeleton east, the Jundland Wastes south-east, Jabba's palace south-west, the Jawa convoy west.
 */
export const LANDMARK_SITES: Record<string, LandmarkSite> = {
  'mos-espa-spires': { bearing: -0.14, dist: 7400 },
  'mushroom-mesa': { bearing: 0.72, dist: 6300 },
  'krayt-skeleton': { bearing: 1.6, dist: 6000 },
  'jundland-wastes': { bearing: 2.5, dist: 7000 },
  'jabba-palace': { bearing: -2.35, dist: 6700 },
  'sandcrawler-convoy': { bearing: -1.15, dist: 5800 },
  'ice-peaks': { bearing: 0.9, dist: 8200 },
  'frozen-falls': { bearing: -1.6, dist: 6600 },
  'methane-flares': { bearing: 1.9, dist: 6200 },
  'gran-city': { bearing: -0.6, dist: 7000 },
  volcano: { bearing: 2.6, dist: 9500 },
  'jungle-ruins': { bearing: -2.0, dist: 6400 },
};

export type Ground = (x: number, z: number) => number;

/** World position of a site around `center`. */
export function sitePosition(site: LandmarkSite, center: { x: number; z: number }, out: THREE.Vector3): THREE.Vector3 {
  return out.set(center.x + Math.sin(site.bearing) * site.dist, 0, center.z - Math.cos(site.bearing) * site.dist);
}

/** Jitters a primitive into weathered rock, then splits it into flat facets (crisp light/shadow sides). */
function rock(geo: THREE.BufferGeometry, amp: number, freq: number, seed: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Displacement is a function of position only, so duplicated seam vertices move together.
    const a = noise2(x * freq + y * freq * 0.7, z * freq - y * freq * 0.4, seed) - 0.5;
    const b = noise2(z * freq + y * freq * 0.6, x * freq + 3.7, seed + 1) - 0.5;
    const c = noise2(x * freq - 5.1, z * freq + y * freq, seed + 2) - 0.5;
    pos.setXYZ(i, x + a * 2 * amp, y + c * amp, z + b * 2 * amp);
  }
  const flat = geo.toNonIndexed();
  geo.dispose();
  flat.computeVertexNormals();
  return flat;
}

type Paint = (x: number, y: number, z: number, ny: number, out: THREE.Color) => void;

const _w = new THREE.Vector3();
const _n = new THREE.Vector3();
const _full = new THREE.Matrix4();
const _nm = new THREE.Matrix3();

/** Build context for one landmark: a frame on the ground facing the course, plus collected extras. */
class Site {
  readonly b = new Builder();
  readonly painted: THREE.BufferGeometry[] = [];
  readonly glows: number[] = [];
  readonly plumes: number[] = [];
  private readonly frame = new THREE.Matrix4();
  private y0 = 0;

  constructor(
    private readonly ground: Ground,
    readonly rng: Rng,
  ) {}

  /** Origin on the ground at (x, z), local -Z toward the course centre. */
  place(x: number, z: number, yaw: number): void {
    this.y0 = this.ground(x, z);
    this.frame.makeRotationY(yaw).setPosition(x, this.y0, z);
    this.b.setFrame(this.frame);
  }

  /** Ground height at a local point, relative to the site origin (pieces settle on dunes and slopes). */
  groundAt(lx: number, lz: number): number {
    _w.set(lx, 0, lz).applyMatrix4(this.frame);
    return this.ground(_w.x, _w.z) - this.y0;
  }

  glow(lx: number, ly: number, lz: number, r: number, g: number, b: number, size: number, flicker: number): void {
    _w.set(lx, ly, lz).applyMatrix4(this.frame);
    this.glows.push(_w.x, _w.y, _w.z, r, g, b, size, flicker);
  }

  plume(lx: number, ly: number, lz: number, radius: number, height: number): void {
    _w.set(lx, ly, lz).applyMatrix4(this.frame);
    this.plumes.push(_w.x, _w.y, _w.z, radius, height);
  }

  /** Like Builder.add but with a per-vertex colour from `paint` (local position, normal y). */
  paint(src: THREE.BufferGeometry, local: THREE.Matrix4, paint: Paint): void {
    const g = src.index ? src.toNonIndexed() : src;
    if (g !== src) src.dispose();
    g.deleteAttribute('uv');
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    _nm.getNormalMatrix(local);
    for (let i = 0; i < pos.count; i++) {
      _w.fromBufferAttribute(pos, i).applyMatrix4(local);
      _n.fromBufferAttribute(nrm, i).applyMatrix3(_nm).normalize();
      paint(_w.x, _w.y, _w.z, _n.y, c);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.applyMatrix4(_full.multiplyMatrices(this.frame, local));
    g.clearGroups();
    this.painted.push(g);
  }
}

const BONE = 0xe6dac0;
const BONE_DARK = 0xcdbb98;

const BUILDERS: Record<string, (s: Site) => void> = {
  // Jundland Wastes: the rocky badlands east of the Dune Sea; buttes, needle spires and canyon ridges
  // in red-brown sandstone, the backdrop of Beggar's Canyon and Arch Canyon on the Boonta course.
  'jundland-wastes': (s) => {
    const { rng, b } = s;
    const tones = [0xa8764e, 0x9a6a46, 0xb88a5e, 0x8e5e3e];
    for (let i = 0; i < 40; i++) {
      const x = rng.range(-2700, 2700);
      const z = rng.range(-400, 800);
      const gy = s.groundAt(x, z) - 50;
      const kind = rng.float();
      const tone = rng.pick(tones);
      if (kind < 0.55) {
        const r = rng.range(90, 260);
        const h = rng.range(130, 320);
        const top = r * rng.range(0.7, 0.88);
        b.add(rock(new THREE.CylinderGeometry(top, r, h, 8, 3), r * 0.13, 0.02, i), tone, tr(x, gy + h / 2, z, rng.range(0, 6)));
        // Darker caprock: the hard layer that keeps the butte standing.
        const cap = h * 0.14;
        b.add(rock(new THREE.CylinderGeometry(top * 0.97, top * 1.04, cap, 8, 1), top * 0.06, 0.03, i + 50), 0x6e4a32, tr(x, gy + h - cap / 2 + 2, z, rng.range(0, 6)));
      } else if (kind < 0.78) {
        const r = rng.range(30, 65);
        const h = rng.range(170, 340);
        b.add(rock(new THREE.CylinderGeometry(r * 0.25, r, h, 6, 4), r * 0.2, 0.04, i), tone, tr(x, gy + h / 2, z, rng.range(0, 6)));
      } else {
        const len = rng.range(600, 1300);
        const h = rng.range(90, 170);
        b.add(rock(new THREE.BoxGeometry(len, h, rng.range(80, 150), 10, 3, 2), 34, 0.012, i), tone, tr(x, gy + h / 2, z, rng.range(-0.6, 0.6)));
      }
    }
  },

  // Jabba's palace: the former B'omarr monastery on the fringe of the Northern Dune Sea; a tall drum tower,
  // a lesser tower and clustered domes in sand-blasted stone, on a rocky rise reached by a single road.
  'jabba-palace': (s) => {
    const { b } = s;
    const stone = 0xcbb393;
    const shade = 0xb39a78;
    b.add(rock(new THREE.SphereGeometry(1, 22, 10), 0.06, 2.2, 7), 0xa88a68, tr(0, s.groundAt(0, 0) - 40, 0, 0, 950, 160, 420));
    const base = s.groundAt(0, 0) + 100;
    b.add(new THREE.CylinderGeometry(130, 150, 60, 20), shade, tr(0, base - 20, 0));
    // Main tower with its cornice band and flattened dome.
    b.add(new THREE.CylinderGeometry(34, 36, 175, 20), stone, tr(40, base + 87, 10));
    b.add(new THREE.CylinderGeometry(37, 37, 9, 20), shade, tr(40, base + 150, 10));
    b.add(new THREE.SphereGeometry(34, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), stone, tr(40, base + 175, 10, 0, 1, 0.55, 1));
    rod(b, 40, base + 190, 10, 40, base + 225, 10, 1.6, 0x4a4038);
    // Second, slimmer tower.
    b.add(new THREE.CylinderGeometry(23, 25, 125, 18), stone, tr(-58, base + 62, 30));
    b.add(new THREE.SphereGeometry(23, 16, 7, 0, Math.PI * 2, 0, Math.PI / 2), stone, tr(-58, base + 125, 30, 0, 1, 0.6, 1));
    // Great hall drum and dome, then the clutter of lesser domes.
    b.add(new THREE.CylinderGeometry(72, 76, 48, 24), shade, tr(-6, base + 24, -38));
    b.add(new THREE.SphereGeometry(72, 22, 9, 0, Math.PI * 2, 0, Math.PI / 2), stone, tr(-6, base + 48, -38, 0, 1, 0.5, 1));
    for (const [x, z, r] of [
      [70, -60, 24],
      [95, 30, 18],
      [-90, -40, 20],
      [-30, 70, 16],
      [20, 80, 14],
    ]) {
      b.add(new THREE.SphereGeometry(r, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), stone, tr(x, base, z, 0, 1, 0.8, 1));
    }
    // Gate block facing the course, with the dark mouth of the entrance.
    b.add(box(-32, base - 10, -150, 32, base + 42, -100), shade);
    b.add(box(-13, base - 10, -152, 13, base + 26, -149), 0x2a2018);
    // The single road winding down the rise.
    for (let k = 0; k < 6; k++) {
      const z0 = -150 - k * 55;
      const x0 = (k % 2 ? 1 : -1) * 40;
      const y = s.groundAt(x0, z0 - 25) + Math.max(0, 95 - k * 20);
      b.add(box(-50, -1, -4, 50, 1, 4), 0xdcc8a2, tr(x0 * 0.5, y, z0 - 25, (k % 2 ? 1 : -1) * 0.9));
    }
  },

  // Krayt dragon skeleton: the bleached bones of a greater krayt half buried in a Dune Sea drift, ribs arching
  // out of the sand (as C-3PO passes in A New Hope), scaled up so it reads from kilometres away.
  'krayt-skeleton': (s) => {
    const { b } = s;
    b.add(new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0xd8b88c, tr(0, s.groundAt(0, 0) - 12, 0, 0, 600, 66, 320));
    const top = s.groundAt(0, 0) + 40;
    const n = 36;
    // Spine sags into the drift at both ends, arching out of the sand in the middle.
    const spine = Array.from({ length: n + 1 }, (_, k) => top - 50 + 82 * Math.sin(Math.PI * (k / n)));
    for (let k = 0; k <= n; k++) {
      const x = -270 + k * 15;
      const y = spine[k];
      b.add(box(-6, -8, -7, 6, 8, 7), k % 2 ? BONE : BONE_DARK, tr(x, y, 0, 0, 1, 1, 1, 0, 0.2));
      b.add(box(-2, 0, -2, 2, 14, 2), BONE, tr(x, y + 6, 0, 0, 1, 1, 1, 0, -0.3));
    }
    for (let k = 7; k <= 29; k += 2) {
      const x = -270 + k * 15;
      const y = spine[k];
      const size = 0.55 + 0.45 * Math.sin(Math.PI * ((k - 7) / 22));
      for (const side of [-1, 1]) {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(x, y, 0),
          new THREE.Vector3(x + 4, y + 14 * size, side * 48 * size),
          new THREE.Vector3(x + 9, y - 20 * size, side * 82 * size),
          new THREE.Vector3(x + 12, top - 70, side * 78 * size),
        ]);
        b.add(new THREE.TubeGeometry(curve, 12, 3.6 * size + 1.2, 5), BONE);
      }
    }
    // Skull resting on the sand at the head end, horns swept back, jaw ajar.
    const hx = -270 + n * 15 + 38;
    const hy = s.groundAt(hx, 0) + 10;
    b.add(new THREE.SphereGeometry(1, 12, 8), BONE, tr(hx, hy, 0, 0, 46, 20, 26, 0, -0.25));
    b.add(box(-38, -4, -16, 38, 4, 16), BONE_DARK, tr(hx + 8, hy - 14, 0, 0, 1, 1, 1, 0, -0.35));
    for (const side of [-1, 1]) {
      b.add(new THREE.SphereGeometry(7, 8, 6), 0x3a3028, tr(hx + 12, hy + 6, side * 18));
      b.add(new THREE.CylinderGeometry(0.5, 7, 48, 6), BONE, tr(hx - 34, hy + 22, side * 14, 0, 1, 1, 1, side * 0.35, 1.05));
    }
  },

  // Mushroom Mesa: the Boonta course's capped rock stacks; soft sandstone stems eroded under hard caprock.
  'mushroom-mesa': (s) => {
    const { rng, b } = s;
    for (let i = 0; i < 12; i++) {
      const x = rng.range(-950, 950);
      const z = rng.range(-350, 450);
      const gy = s.groundAt(x, z) - 30;
      const h = rng.range(90, 220);
      const rs = rng.range(18, 42);
      b.add(rock(new THREE.CylinderGeometry(rs, rs * 1.45, h, 8, 4), rs * 0.18, 0.05, i), rng.pick([0xc49064, 0xb8845a, 0xcc9c70]), tr(x, gy + h / 2, z, rng.range(0, 6)));
      const rc = rs * rng.range(1.8, 2.7);
      const ch = rng.range(20, 42);
      b.add(rock(new THREE.CylinderGeometry(rc * 0.85, rc, ch, 9, 2), rc * 0.12, 0.04, i + 30), 0x7e5638, tr(x, gy + h + ch / 2 - 4, z, rng.range(0, 6), 1, 1, 1, rng.range(-0.08, 0.08)));
    }
    // Flat-topped mesa behind the stacks (Ben's Mesa sits at the heart of the Mos Espa circuit).
    b.add(rock(new THREE.CylinderGeometry(620, 760, 220, 16, 3), 60, 0.006, 77), 0xb07a52, tr(300, s.groundAt(300, 900) + 60, 900));
  },

  // Mos Espa: the spaceport town of domed adobe blocks, with taller spires and towers behind the arena.
  'mos-espa-spires': (s) => {
    const { rng, b } = s;
    const adobe = [0xd6c09a, 0xcbb08a, 0xbfa27c];
    const trim = 0xe2d3b4;
    for (let i = 0; i < 95; i++) {
      const x = rng.range(-2300, 2300) * (0.35 + 0.65 * rng.float());
      const z = rng.range(-500, 500);
      const gy = s.groundAt(x, z) - 6;
      const kind = rng.float();
      const tone = rng.pick(adobe);
      if (kind < 0.45) {
        const w = rng.range(30, 70);
        const d = rng.range(25, 55);
        const h = rng.range(16, 34);
        b.add(box(-w / 2, 0, -d / 2, w / 2, h, d / 2), tone, tr(x, gy, z, rng.range(0, Math.PI)));
        if (rng.chance(0.6)) b.add(new THREE.SphereGeometry(Math.min(w, d) * 0.38, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2), trim, tr(x, gy + h, z));
      } else if (kind < 0.8) {
        const r = rng.range(16, 34);
        b.add(new THREE.CylinderGeometry(r, r * 1.05, r * 0.6, 14), tone, tr(x, gy + r * 0.3, z));
        b.add(new THREE.SphereGeometry(r, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), trim, tr(x, gy + r * 0.6, z));
      } else {
        // Spires: tapering towers with a bulb and a mast, the tallest marks on the skyline.
        const r = rng.range(7, 13);
        const h = rng.range(90, 210);
        b.add(new THREE.CylinderGeometry(r * 0.6, r * 1.3, h, 10), tone, tr(x, gy + h / 2, z));
        b.add(new THREE.SphereGeometry(r * 1.4, 10, 6), trim, tr(x, gy + h, z, 0, 1, 0.8, 1));
        b.add(new THREE.CylinderGeometry(r * 2.2, r * 2.2, 3, 12), 0xa48a66, tr(x, gy + h * 0.72, z));
        rod(b, x, gy + h, z, x, gy + h + h * 0.25, z, 1, 0x5a5048);
      }
    }
  },

  // Ando Prime: jagged ice peaks, dark rock with snow above the snowline and on every gentle slope.
  'ice-peaks': (s) => {
    const { rng, b } = s;
    // Dark moraine foothills at the feet of the range (also keeps this site's Builder non-empty).
    for (let i = 0; i < 8; i++) {
      const x = rng.range(-3000, 3000);
      const z = rng.range(-600, -200);
      const r = rng.range(160, 320);
      b.add(rock(new THREE.SphereGeometry(1, 10, 6), 0.12, 2, i + 90), 0x4e5866, tr(x, s.groundAt(x, z) - r * 0.3, z, rng.range(0, 6), r, r * 0.45, r * 0.8));
    }
    for (let i = 0; i < 16; i++) {
      const x = rng.range(-3200, 3200);
      const z = rng.range(-300, 1800);
      const r = rng.range(380, 900);
      const h = r * rng.range(1.4, 2.0);
      const gy = s.groundAt(x, z) - 80;
      const snow = h * rng.range(0.35, 0.55);
      s.paint(rock(new THREE.CylinderGeometry(r * 0.02, r, h, 9, 6), r * 0.1, 0.004, i), tr(x, gy + h / 2, z, rng.range(0, 6)), (_x, y, _z, ny, c) => {
        const up = y - gy;
        if (up > snow || (up > snow * 0.5 && ny > 0.55)) c.setHex(ny > 0.3 ? 0xf2f6fb : 0xd8e2ee);
        else c.setHex(ny > 0.4 ? 0x6a7686 : 0x515c6c);
      });
    }
  },

  // Ando Prime: a frozen waterfall spilling over a dark cliff into an ice pool.
  'frozen-falls': (s) => {
    const { rng, b } = s;
    const gy = s.groundAt(0, 0) - 60;
    s.paint(rock(new THREE.BoxGeometry(1700, 440, 240, 18, 6, 2), 34, 0.008, 5), tr(0, gy + 220, 0), (_x, _y, _z, ny, c) => {
      c.setHex(ny > 0.55 ? 0xeef4fa : 0x4a5262);
    });
    for (let k = 0; k < 6; k++) {
      const x = -620 + k * 250 + rng.range(-60, 60);
      const w = rng.range(40, 90);
      // Tiers of downward icicle cones cascading from the lip to the pool.
      for (let t = 0; t < 4; t++) {
        const th = 440 / 4 + 30;
        const y = gy + 440 - t * 110 - th / 2;
        b.add(new THREE.CylinderGeometry(w * (1 + t * 0.15), w * 0.2, th, 8), t % 2 ? 0xcfe8f5 : 0xe6f4fb, tr(x + rng.range(-15, 15), y, -125 - t * 6));
      }
    }
    b.add(new THREE.SphereGeometry(1, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0xd8ecf6, tr(0, s.groundAt(0, -250) - 4, -250, 0, 900, 22, 220));
  },

  // Malastare: a methane refinery with flare stacks burning off gas over the plains.
  'methane-flares': (s) => {
    const { rng, b } = s;
    for (let i = 0; i < 7; i++) {
      const x = -700 + i * 230 + rng.range(-50, 50);
      const z = rng.range(-250, 250);
      const gy = s.groundAt(x, z) - 6;
      const h = rng.range(140, 240);
      b.add(new THREE.CylinderGeometry(5, 8, h, 8), 0x3e3c3a, tr(x, gy + h / 2, z));
      b.add(new THREE.CylinderGeometry(8.6, 8.6, 12, 8), 0xb84030, tr(x, gy + h * 0.72, z));
      b.add(new THREE.CylinderGeometry(8.6, 8.6, 12, 8), 0xd8d4c8, tr(x, gy + h * 0.72 + 12, z));
      // Flame plume: stacked sprites shrinking and cooling as they rise.
      for (let j = 0; j < 7; j++) s.glow(x, gy + h + 6 + j * 9, z, 3.2 - j * 0.3, 1.5 - j * 0.15, 0.45 - j * 0.04, 34 - j * 3.5, 1);
    }
    for (let i = 0; i < 9; i++) {
      const x = rng.range(-800, 800);
      const z = rng.range(-300, 300);
      const gy = s.groundAt(x, z);
      const r = rng.range(22, 40);
      if (i % 3 === 0) b.add(new THREE.CylinderGeometry(r, r, r * 2.6, 14), 0x9a968c, tr(x, gy + r, z, rng.range(0, 3), 1, 1, 1, 0, Math.PI / 2));
      else b.add(new THREE.SphereGeometry(r, 14, 10), 0x8a8a84, tr(x, gy + r * 1.3, z));
    }
    for (let i = 0; i < 6; i++) {
      const x = -700 + i * 260;
      rod(b, x, s.groundAt(x, 0) + 14, 0, x + 260, s.groundAt(x + 260, 0) + 14, 0, 3, 0x5a5650);
    }
  },

  // Malastare: a Gran city of domes and slender towers crowned with saucer decks.
  'gran-city': (s) => {
    const { rng, b } = s;
    const stone = [0x9a9c84, 0x8c9078, 0x7e846e];
    const trim = 0xb8baa2;
    for (let i = 0; i < 64; i++) {
      const x = rng.range(-2000, 2000) * (0.4 + 0.6 * rng.float());
      const z = rng.range(-450, 450);
      const gy = s.groundAt(x, z) - 6;
      const tone = rng.pick(stone);
      if (rng.chance(0.65)) {
        const r = rng.range(25, 60);
        b.add(new THREE.CylinderGeometry(r, r, r * 0.4, 16), tone, tr(x, gy + r * 0.2, z));
        b.add(new THREE.SphereGeometry(r, 16, 7, 0, Math.PI * 2, 0, Math.PI / 2), trim, tr(x, gy + r * 0.4, z, 0, 1, 0.7, 1));
      } else {
        const r = rng.range(6, 11);
        const h = rng.range(120, 260);
        b.add(new THREE.CylinderGeometry(r * 0.8, r * 1.2, h, 10), tone, tr(x, gy + h / 2, z));
        b.add(new THREE.CylinderGeometry(r * 4.2, r * 2, 9, 16), trim, tr(x, gy + h, z));
        s.glow(x, gy + h + 6, z, 1.4, 1.2, 0.7, 9, 0);
      }
    }
  },

  // Baroonda: a smoking volcano with glowing lava runs down its flanks.
  volcano: (s) => {
    const { rng, b } = s;
    // Parasitic cinder cones around the base (also keeps this site's Builder non-empty).
    for (let i = 0; i < 5; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(2700, 3300);
      const cr = rng.range(180, 320);
      b.add(rock(new THREE.CylinderGeometry(cr * 0.25, cr, cr * 0.7, 10, 2), cr * 0.08, 0.01, i + 40), 0x2e2624, tr(Math.cos(a) * d, s.groundAt(Math.cos(a) * d, Math.sin(a) * d) + cr * 0.3, Math.sin(a) * d));
    }
    const r = 2600;
    const h = 1500;
    const gy = s.groundAt(0, 0) - 80;
    const crater = r * 0.14;
    s.paint(rock(new THREE.CylinderGeometry(crater, r, h, 36, 8), 70, 0.0015, 11), tr(0, gy + h / 2, 0), (x, y, z, ny, c) => {
      const a = Math.atan2(z, x);
      const up = (y - gy) / h;
      // Lava runs: narrow angular stripes reaching down from the rim.
      const run = noise2(a * 9, 0.5, 21) > 0.72 && up > 0.35;
      if (run) c.setHex(0x7a2810);
      else c.setHex(ny > 0.75 && up > 0.95 ? 0x2a2220 : up > 0.6 ? 0x3a302c : 0x4a4034);
    });
    for (let k = 0; k < 6; k++) s.glow(rng.range(-crater, crater) * 0.5, gy + h + 10, rng.range(-crater, crater) * 0.5, 3, 0.9, 0.2, 170, 0.6);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      if (noise2(a * 9, 0.5, 21) <= 0.78) continue;
      for (let t = 0; t < 4; t++) {
        const up = 0.95 - t * 0.15;
        const rr = r - (r - crater) * up + 12;
        s.glow(Math.cos(a) * rr, gy + h * up, Math.sin(a) * rr, 2.6, 0.7, 0.12, 70, 0.5);
      }
    }
    s.plume(0, gy + h - 40, 0, 300, 2800);
  },

  // Baroonda: stepped temple ruins rising out of the jungle canopy.
  'jungle-ruins': (s) => {
    const { rng, b } = s;
    for (let i = 0; i < 64; i++) {
      const x = rng.range(-1600, 1600);
      const z = rng.range(-600, 700);
      const rr = rng.range(60, 150);
      s.paint(new THREE.SphereGeometry(1, 10, 6), tr(x, s.groundAt(x, z) + rr * 0.15, z, 0, rr, rr * 0.55, rr), (px, py, pz, ny, c) => {
        const v = noise2(px * 0.02 + py * 0.01, pz * 0.02, 31);
        c.setRGB(0.18 + 0.12 * v, 0.3 + 0.14 * v + 0.05 * ny, 0.12 + 0.06 * v, THREE.SRGBColorSpace);
      });
    }
    for (const [cx, cz, scale] of [
      [0, 0, 1],
      [760, 260, 0.6],
    ]) {
      const gy = s.groundAt(cx, cz) + 20;
      for (let t = 0; t < 6; t++) {
        const w = (260 - t * 38) * scale;
        const y = gy + t * 26 * scale;
        b.add(box(-w / 2, 0, -w / 2, w / 2, 26 * scale, w / 2), t % 2 ? 0x8c8a72 : 0x6e7a56, tr(cx, y, cz, 0.3));
      }
      b.add(box(-22 * scale, 0, -22 * scale, 22 * scale, 40 * scale, 22 * scale), 0x7e7c66, tr(cx, gy + 156 * scale, cz, 0.3));
    }
    b.add(new THREE.CylinderGeometry(16, 20, 150, 10), 0x7e7c66, tr(-600, s.groundAt(-600, -200) + 60, -200, 0, 1, 1, 1, 0, 0.12));
  },
};

export interface Landmarks {
  /** Merged static silhouettes (null when no known landmark was asked for). */
  geometry: THREE.BufferGeometry | null;
  /** Glow sprites: x, y, z, r, g, b, size (m), flicker per entry. */
  glows: number[];
  /** Smoke columns: x, y, z, radius, height per entry. */
  plumes: number[];
}

const _p = new THREE.Vector3();

export function buildLandmarks(ids: readonly string[], center: { x: number; z: number }, ground: Ground): Landmarks {
  const site = new Site(ground, new Rng(0x4a77));
  let any = false;
  for (const id of ids) {
    const build = BUILDERS[id];
    const at = LANDMARK_SITES[id];
    if (!build || !at) continue;
    sitePosition(at, center, _p);
    site.place(_p.x, _p.z, Math.PI - at.bearing);
    build(site);
    any = true;
  }
  if (!any) return { geometry: null, glows: site.glows, plumes: site.plumes };
  const geo = mergeGeometries([site.b.build(), ...site.painted]);
  if (!geo) throw new Error('horizon: incompatible landmark parts');
  for (const p of site.painted) p.dispose();
  return { geometry: geo, glows: site.glows, plumes: site.plumes };
}
