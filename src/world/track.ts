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
  private count: number;

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
    out.dist = bi < 0 ? Infinity : Math.sqrt(best);
    out.floorY = bi < 0 ? 0 : this.pts[bi * 3 + 1];
    out.u = bi < 0 ? 0 : bi / this.count;
    return out;
  }

  /** Centreline point, unit tangent and horizontal right vector at arc parameter u. */
  frame(u: number, pos: THREE.Vector3, tangent: THREE.Vector3, right: THREE.Vector3): void {
    const w = ((u % 1) + 1) % 1;
    this.curve.getPointAt(w, pos);
    this.curve.getTangentAt(w, tangent);
    right.set(-tangent.z, 0, tangent.x).normalize();
  }
}
