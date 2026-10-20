// Tatooine dune sea: one height function shared by two meshes.
// - Corridor: a fine strip that follows the track, where the camera actually is. Rings every 2.5 m;
//   a dense band of columns (2.5 m) covers the bed, banks and canyon walls, and coarser columns on every
//   other ring reach out to the backdrop seam. Split into chunks along the track so frustum culling
//   drops what is behind the camera.
// - Backdrop: a coarse 14 km grid for dunes and mesas on the horizon; under the corridor its triangles
//   are dropped (or sunk) so the fine strip shows.
// All colour and small-scale relief come from the shared procedural surface shader (./surface); the
// meshes only carry positions, normals and a per-vertex track-bed mask.
import * as THREE from 'three';
import { smoothstep } from '../core/rng';
import { fbm2, noise2, ridge2 } from './noise';
import { noise3, terrainMaterial } from './surface';
import { CANYONS, TRACK_HALF_WIDTH, type Track, type TrackHit } from './track';

const _hit: TrackHit = { dist: 0, floorY: 0, u: 0 };

/** 0 in open desert, 1 deep inside a canyon section. */
function rockiness(x: number, z: number): number {
  let rocky = 0;
  for (const c of CANYONS) rocky = Math.max(rocky, smoothstep(c.r, c.r * 0.6, Math.hypot(x - c.x, z - c.z)));
  return rocky;
}

/** Natural ground height before the track is carved in. */
function natural(x: number, z: number): number {
  const broad = fbm2(x / 2600, z / 2600, 4, 3) * 34;
  // Dunes: ridges across the prevailing wind (rotated frame), stronger away from the rocky areas.
  const wx = x * 0.8 + z * 0.6;
  const wz = -x * 0.6 + z * 0.8;
  const duneMask = smoothstep(0.35, 0.65, fbm2(x / 1400, z / 1400, 2, 9));
  const dunes = (ridge2(wx / 170, wz / 640, 5) * 0.75 + ridge2(wx / 60, wz / 220, 6) * 0.25) * 14 * duneMask;
  // Mesas: terraced plateaus with steep cliffs.
  const m = fbm2(x / 1900 + 4.1, z / 1900 - 2.3, 4, 21);
  let plateau = smoothstep(0.58, 0.61, m) * 60 + smoothstep(0.68, 0.7, m) * 45;
  for (const c of CANYONS) {
    const d = Math.hypot(x - c.x, z - c.z);
    plateau = Math.max(plateau, smoothstep(c.r, c.r * 0.7, d) * c.height * (0.85 + 0.3 * noise2(x / 90, z / 90, 31)));
  }
  return broad + dunes + plateau;
}

/** Final ground height: the natural terrain with the track bed and its banks carved in. */
export function groundHeight(track: Track, x: number, z: number): number {
  const h = natural(x, z);
  track.nearest(x, z, _hit, 160);
  if (_hit.dist === Infinity) return h;
  // Inside canyons the banks are steep walls; in the open the bed blends into the dunes.
  const bank = THREE.MathUtils.lerp(70, 18, rockiness(x, z));
  const t = smoothstep(TRACK_HALF_WIDTH, TRACK_HALF_WIDTH + bank, _hit.dist);
  // Gentle ruts and bumps on the bed itself.
  const bed = _hit.floorY + (noise2(x / 25, z / 25, 41) - 0.5) * 0.8;
  return bed + (h - bed) * t;
}

const RING_STEP = 2.5; // m between corridor rings
const FINE_SIDE = 32; // dense columns per side of the centreline
const FINE = FINE_SIDE * 2 + 1;
const OUTER_SIDE = 10; // coarse columns per side, present on even rings only
const FULL = FINE + OUTER_SIDE * 2;
const CHUNK_RINGS = 160; // 400 m of track per mesh (even, so coarse quads never straddle chunks)
// Triangles per ring strip: the fine band, plus on even rings the coarse quads and the two 3-triangle
// transitions that stitch one coarse edge to two fine ones without T-junction cracks.
const TRIS_FINE = (FINE - 1) * 2;
const TRIS_EVEN = TRIS_FINE + (OUTER_SIDE - 1) * 4 + 6;
// Canyon walls get mesh-only crags: pushed horizontally away from the track, never toward it, so the
// visible rock only ever recedes behind the physical wall (groundHeight) by at most this much.
const WALL_CRAG = 1.4;

/**
 * Fine strip along the track as chunked geometries. Rows are indexed by ring; ring `rings` duplicates
 * ring 0 so every chunk owns a contiguous vertex range (the duplicate's normals are merged with ring 0
 * afterwards, so the start line shows no seam).
 */
function corridor(track: Track, halfWidth: number): THREE.BufferGeometry[] {
  const rings = 2 * Math.ceil(track.length / (2 * RING_STEP));
  const start = new Uint32Array(rings + 2);
  for (let r = 0; r <= rings; r++) start[r + 1] = start[r] + (r % 2 === 0 ? FULL : FINE);
  const total = start[rings + 1];
  const pos = new Float32Array(total * 3);
  const bed = new Float32Array(total);

  const p = new THREE.Vector3();
  const tng = new THREE.Vector3();
  const right = new THREE.Vector3();
  const lat = new Float32Array(FULL);
  const hgt = new Float32Array(FULL);
  for (let r = 0; r <= rings; r++) {
    track.frame((r % rings) / rings, p, tng, right);
    // The dense band widens inside canyons so it spans the whole wall, not just the bank.
    const fine = THREE.MathUtils.lerp(80, 104, rockiness(p.x, p.z));
    const even = r % 2 === 0;
    const first = even ? 0 : OUTER_SIDE; // row slot of this ring's first vertex
    const last = even ? FULL : OUTER_SIDE + FINE;
    for (let k = 0; k < FULL; k++) {
      const c = k - OUTER_SIDE - FINE_SIDE; // column relative to the centre
      if (Math.abs(c) <= FINE_SIDE) lat[k] = (c / FINE_SIDE) * fine;
      else {
        // Coarse columns: spacing grows from ~4 m to ~25 m toward the backdrop seam.
        const s = (Math.abs(c) - FINE_SIDE) / OUTER_SIDE;
        lat[k] = Math.sign(c) * (fine + (halfWidth - fine) * s ** 1.6);
      }
    }
    for (let k = first; k < last; k++) hgt[k] = groundHeight(track, p.x + right.x * lat[k], p.z + right.z * lat[k]);
    const spacing = fine / FINE_SIDE;
    for (let k = first; k < last; k++) {
      let x = p.x + right.x * lat[k];
      let z = p.z + right.z * lat[k];
      const y = hgt[k];
      const fineCol = Math.abs(k - OUTER_SIDE - FINE_SIDE) < FINE_SIDE;
      if (fineCol) {
        const slope = Math.abs(hgt[k + 1] - hgt[k - 1]) / (2 * spacing);
        const wall = smoothstep(0.9, 2.2, slope) * smoothstep(TRACK_HALF_WIDTH + 4, TRACK_HALF_WIDTH + 10, Math.abs(lat[k]));
        if (wall > 0) {
          // Flattened noise (wider than tall) reads as horizontal crags that follow the strata.
          const n = noise3(x / 8, y / 4.5, z / 8, 71) * 0.65 + noise3(x / 3.5, y / 2, z / 3.5, 72) * 0.35;
          const d = Math.sign(lat[k]) * wall * WALL_CRAG * n;
          x += right.x * d;
          z += right.z * d;
        }
      }
      const i = start[r] + k - first;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      // Packed-bed mask: 1 on the racing surface, fading out over the banks.
      bed[i] = smoothstep(TRACK_HALF_WIDTH + 6, TRACK_HALF_WIDTH - 4, Math.abs(lat[k]));
    }
  }

  // Index: one strip per ring, in ring order, so a chunk's triangles are a contiguous slice.
  const triStart = new Uint32Array(rings + 1);
  for (let r = 0; r < rings; r++) triStart[r + 1] = triStart[r] + (r % 2 === 0 ? TRIS_EVEN : TRIS_FINE);
  const idx = new Uint32Array(triStart[rings] * 3);
  let n = 0;
  // Rings run forward, columns run right: (a, a+1, b) winds counter-clockwise seen from above.
  const quad = (a: number, b: number, a2: number, b2: number) => {
    idx[n++] = a;
    idx[n++] = b;
    idx[n++] = a2;
    idx[n++] = b;
    idx[n++] = b2;
    idx[n++] = a2;
  };
  const fineAt = (r: number, c: number) => start[r] + (r % 2 === 0 ? OUTER_SIDE : 0) + c + FINE_SIDE;
  for (let r = 0; r < rings; r++) {
    for (let c = -FINE_SIDE; c < FINE_SIDE; c++) quad(fineAt(r, c), fineAt(r, c + 1), fineAt(r + 1, c), fineAt(r + 1, c + 1));
    if (r % 2 !== 0) continue;
    const a = start[r];
    const b = start[r + 2];
    for (let k = 0; k < OUTER_SIDE - 1; k++) quad(a + k, a + k + 1, b + k, b + k + 1);
    const o = OUTER_SIDE + FINE;
    for (let k = o; k < FULL - 1; k++) quad(a + k, a + k + 1, b + k, b + k + 1);
    // Left seam: coarse column (left) to the fine edge (right) over rings r, r+1, r+2.
    let c0 = a + OUTER_SIDE - 1;
    let c2 = b + OUTER_SIDE - 1;
    let f0 = fineAt(r, -FINE_SIDE);
    let f1 = fineAt(r + 1, -FINE_SIDE);
    let f2 = fineAt(r + 2, -FINE_SIDE);
    idx.set([c0, f0, f1, c0, f1, c2, c2, f1, f2], n);
    n += 9;
    // Right seam: fine edge (left) to the coarse column (right).
    c0 = a + o;
    c2 = b + o;
    f0 = fineAt(r, FINE_SIDE);
    f1 = fineAt(r + 1, FINE_SIDE);
    f2 = fineAt(r + 2, FINE_SIDE);
    idx.set([f0, c0, f1, f1, c0, c2, f1, c2, f2], n);
    n += 9;
  }

  // Area-weighted vertex normals over the whole loop, then fold the duplicate ring onto ring 0.
  const nrm = new Float32Array(total * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3;
    const i1 = idx[t + 1] * 3;
    const i2 = idx[t + 2] * 3;
    const ux = pos[i1] - pos[i0];
    const uy = pos[i1 + 1] - pos[i0 + 1];
    const uz = pos[i1 + 2] - pos[i0 + 2];
    const vx = pos[i2] - pos[i0];
    const vy = pos[i2 + 1] - pos[i0 + 1];
    const vz = pos[i2 + 2] - pos[i0 + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    // Unrolled on purpose: this runs for ~900k triangles at load.
    nrm[i0] += cx;
    nrm[i0 + 1] += cy;
    nrm[i0 + 2] += cz;
    nrm[i1] += cx;
    nrm[i1 + 1] += cy;
    nrm[i1 + 2] += cz;
    nrm[i2] += cx;
    nrm[i2 + 1] += cy;
    nrm[i2 + 2] += cz;
  }
  for (let k = 0; k < FULL * 3; k++) {
    const s = nrm[k] + nrm[start[rings] * 3 + k];
    nrm[k] = nrm[start[rings] * 3 + k] = s;
  }
  for (let i = 0; i < total * 3; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l;
    nrm[i + 1] /= l;
    nrm[i + 2] /= l;
  }

  const chunks: THREE.BufferGeometry[] = [];
  for (let r0 = 0; r0 < rings; r0 += CHUNK_RINGS) {
    const r1 = Math.min(r0 + CHUNK_RINGS, rings);
    const v0 = start[r0];
    const v1 = start[r1 + 1];
    const tris = idx.subarray(triStart[r0] * 3, triStart[r1] * 3);
    const local = v1 - v0 > 65535 ? new Uint32Array(tris.length) : new Uint16Array(tris.length);
    for (let t = 0; t < tris.length; t++) local[t] = tris[t] - v0;
    const geo = new THREE.BufferGeometry();
    // Views into the shared arrays: no copies, and WebGL uploads only each view's range.
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(v0 * 3, v1 * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(v0 * 3, v1 * 3), 3));
    geo.setAttribute('aBed', new THREE.BufferAttribute(bed.subarray(v0, v1), 1));
    geo.setIndex(new THREE.BufferAttribute(local, 1));
    geo.computeBoundingSphere();
    chunks.push(geo);
  }
  return chunks;
}

/** Coarse horizon terrain; triangles fully inside the corridor are dropped, edge vertices sunk. */
function backdrop(track: Track, size: number, segs: number, corridorWidth: number): THREE.BufferGeometry {
  const n = segs + 1;
  const pos = new Float32Array(n * n * 3);
  const inside = new Uint8Array(n * n);
  const hit: TrackHit = { dist: 0, floorY: 0, u: 0 };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i / segs - 0.5) * size + 250;
      const z = (j / segs - 0.5) * size + 1100;
      track.nearest(x, z, hit, corridorWidth + 100);
      const k = j * n + i;
      inside[k] = hit.dist < corridorWidth * 0.8 ? 1 : 0;
      const sink = hit.dist < corridorWidth * 0.95 ? 6 : 0;
      pos.set([x, groundHeight(track, x, z) - sink, z], k * 3);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * n + i;
      const b = a + n;
      if (!(inside[a] && inside[b] && inside[a + 1])) idx.push(a, b, a + 1);
      if (!(inside[a + 1] && inside[b] && inside[b + 1])) idx.push(a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // The bed never reaches the backdrop's visible part (it is dropped or sunk under the corridor).
  geo.setAttribute('aBed', new THREE.BufferAttribute(new Float32Array(n * n), 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function buildTerrain(track: Track): THREE.Group {
  const mat = terrainMaterial();
  const CORRIDOR = 240;
  const group = new THREE.Group();
  for (const geo of [...corridor(track, CORRIDOR), backdrop(track, 14000, 256, CORRIDOR)]) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; // static at the origin
    group.add(mesh);
  }
  return group;
}
