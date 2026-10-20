// The race course: a closed spline over the dune sea, with a fast nearest-point query used by the
// terrain (to carve the track bed and canyons) and later by gameplay (progress, off-track, laps).
import * as THREE from 'three';

/** Control points [x, z, floor height] of the Boonta-style loop (metres). */
const CONTROL: [number, number, number][] = [
  [0, 0, 8],
  [900, -300, 10],
  [1900, -200, 14],
  [2700, 500, 20],
  [2900, 1500, 18],
  [2400, 2400, 12],
  [1500, 2800, 10],
  [700, 2300, 6],
  [400, 1500, 4],
  [-500, 1200, 6],
  [-1300, 1800, 10],
  [-2200, 1300, 14],
  [-2400, 300, 12],
  [-1700, -600, 9],
  [-800, -500, 8],
];

/** Half width of the flattened track bed (m). */
export const TRACK_HALF_WIDTH = 34;
/** Centres of the canyon sections: the plateau is raised here so the track cuts through rock. */
export const CANYONS: { x: number; z: number; r: number; height: number }[] = [
  { x: 2850, z: 1000, r: 650, height: 95 },
  { x: -1850, z: 1550, r: 600, height: 80 },
];

const SAMPLE = 4; // metres between polyline samples
const CELL = 100; // spatial hash cell size (m)

export interface TrackHit {
  /** Horizontal distance to the centreline (m). */
  dist: number;
  /** Floor height of the track at the nearest point. */
  floorY: number;
  /** Arc-length parameter of the nearest point in [0,1). */
  u: number;
}

export class Track {
  readonly curve: THREE.CatmullRomCurve3;
  readonly length: number;
  private pts: Float32Array; // x, y, z per sample
  private grid = new Map<number, number[]>();
  readonly count: number;
  /** Signed horizontal curvature per sample (1/m, + = bending right), smoothed over ~40 m. */
  readonly curvature: Float32Array;

  constructor() {
    this.curve = new THREE.CatmullRomCurve3(
      CONTROL.map(([x, z, y]) => new THREE.Vector3(x, y, z)),
      true,
      'centripetal',
    );
    this.length = this.curve.getLength();
    this.count = Math.ceil(this.length / SAMPLE);
    this.pts = new Float32Array(this.count * 3);
    const p = new THREE.Vector3();
    for (let i = 0; i < this.count; i++) {
      this.curve.getPointAt(i / this.count, p);
      this.pts.set([p.x, p.y, p.z], i * 3);
      const key = this.cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
      const list = this.grid.get(key);
      if (list) list.push(i);
      else this.grid.set(key, [i]);
    }
    // Heading change across ±5 samples, divided by the arc between them.
    this.curvature = new Float32Array(this.count);
    const n = this.count;
    const P = this.pts;
    for (let i = 0; i < n; i++) {
      const a = ((i - 5 + n) % n) * 3;
      const b = i * 3;
      const c = ((i + 5) % n) * 3;
      const h1 = Math.atan2(P[b + 2] - P[a + 2], P[b] - P[a]);
      const h2 = Math.atan2(P[c + 2] - P[b + 2], P[c] - P[b]);
      let d = h2 - h1;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      // atan2(z, x) grows clockwise seen from above (+Y up, +Z toward the viewer): that is a right turn.
      this.curvature[i] = d / (5 * SAMPLE);
    }
  }

  /** Curvature at u (nearest sample). */
  curvatureAt(u: number): number {
    const w = ((u % 1) + 1) % 1;
    return this.curvature[Math.floor(w * this.count) % this.count];
  }

  /** Centreline x, z pairs (for the minimap). */
  centerXZ(step = 10): Float32Array {
    const n = Math.floor(this.count / step);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      out[i * 2] = this.pts[i * step * 3];
      out[i * 2 + 1] = this.pts[i * step * 3 + 2];
    }
    return out;
  }

  private cellKey(cx: number, cz: number): number {
    return (cx + 1000) * 4096 + (cz + 1000);
  }

  /** Nearest centreline point within `maxDist` (m); dist = Infinity when farther. */
  nearest(x: number, z: number, out: TrackHit, maxDist = 300): TrackHit {
    const r = Math.ceil(maxDist / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = Infinity;
    let bi = -1;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = this.grid.get(this.cellKey(cx + dx, cz + dz));
        if (!list) continue;
        for (const i of list) {
          const ex = this.pts[i * 3] - x;
          const ez = this.pts[i * 3 + 2] - z;
          const d2 = ex * ex + ez * ez;
          if (d2 < best) {
            best = d2;
            bi = i;
          }
        }
      }
    }
    if (bi < 0) {
      out.dist = Infinity;
      out.floorY = 0;
      out.u = 0;
      return out;
    }
    // Refine onto the polyline segment toward the closer neighbour: smooth u and distance instead of
    // 4 m steps (gameplay reads lateral offsets from this every frame).
    const n = this.count;
    const P = this.pts;
    const ia = ((bi - 1 + n) % n) * 3;
    const ib = ((bi + 1) % n) * 3;
    const dA = (P[ia] - x) ** 2 + (P[ia + 2] - z) ** 2;
    const dB = (P[ib] - x) ** 2 + (P[ib + 2] - z) ** 2;
    const i0 = dA < dB ? (bi - 1 + n) % n : bi;
    const i1 = (i0 + 1) % n;
    const ax = P[i0 * 3];
    const az = P[i0 * 3 + 2];
    const sx = P[i1 * 3] - ax;
    const sz = P[i1 * 3 + 2] - az;
    const f = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / (sx * sx + sz * sz)));
    const qx = ax + sx * f - x;
    const qz = az + sz * f - z;
    out.dist = Math.sqrt(qx * qx + qz * qz);
    out.floorY = P[i0 * 3 + 1] + (P[i1 * 3 + 1] - P[i0 * 3 + 1]) * f;
    out.u = ((i0 + f) / n) % 1;
    return out;
  }

  /**
   * Centreline point, unit tangent and horizontal right vector at arc parameter u. Interpolates the
   * 4 m samples (cheap enough for every pod every frame, unlike the curve's arc-length lookup).
   */
  frame(u: number, pos: THREE.Vector3, tangent: THREE.Vector3, right: THREE.Vector3): void {
    const n = this.count;
    const P = this.pts;
    const s = (((u % 1) + 1) % 1) * n;
    const i0 = Math.floor(s) % n;
    const i1 = (i0 + 1) % n;
    const f = s - Math.floor(s);
    const a = i0 * 3;
    const b = i1 * 3;
    pos.set(P[a] + (P[b] - P[a]) * f, P[a + 1] + (P[b + 1] - P[a + 1]) * f, P[a + 2] + (P[b + 2] - P[a + 2]) * f);
    // Tangent: blend of the two neighbouring segment directions, so it turns smoothly through samples.
    const p = ((i0 - 1 + n) % n) * 3;
    const c = ((i1 + 1) % n) * 3;
    tangent.set(P[b] - P[p] + (P[c] - P[a] - (P[b] - P[p])) * f, P[b + 1] - P[p + 1] + (P[c + 1] - P[a + 1] - (P[b + 1] - P[p + 1])) * f, P[b + 2] - P[p + 2] + (P[c + 2] - P[a + 2] - (P[b + 2] - P[p + 2])) * f).normalize();
    right.set(-tangent.z, 0, tangent.x).normalize();
  }
}
