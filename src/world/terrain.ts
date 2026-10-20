// Planet ground: one height function per course (relief picked by the TrackDef's terrain theme), shared
// by two meshes.
// - Corridor: a fine strip that follows the track, where the camera actually is. Rings every 2.5 m;
//   a dense band of columns (2.5 m) covers the bed, banks and canyon walls, and coarser columns on every
//   other ring reach out to the backdrop seam. Split into chunks along the track so frustum culling
//   drops what is behind the camera.
// - Backdrop: a coarse 14 km grid for the relief on the horizon; under the corridor its triangles
//   are dropped (or sunk) so the fine strip shows.
// All colour and small-scale relief come from the shared procedural surface shader (./surface); the
// meshes only carry positions, normals and a per-vertex track-bed mask. Liquids (frozen lakes, methane,
// sea) are separate flat meshes (./world); the solid ground under them is what these meshes show.
import * as THREE from 'three';
import { smoothstep } from '../core/rng';
import { fbm2, noise2, ridge2 } from './noise';
import { noise3, terrainMaterial } from './surface';
import type { Canyon } from './theme';
import { TRACK_HALF_WIDTH, type Track, type TrackHit } from './track';

const _hit: TrackHit = { dist: 0, floorY: 0, u: 0 };

/** 0 in open country, 1 deep inside a canyon section. */
function rockiness(canyons: readonly Canyon[], x: number, z: number): number {
  let rocky = 0;
  for (const c of canyons) rocky = Math.max(rocky, smoothstep(c.r, c.r * 0.6, Math.hypot(x - c.x, z - c.z)));
  return rocky;
}

/** Gorge plateaus raised around the canyon centres (the track bed is carved through them later). */
function canyonPlateau(canyons: readonly Canyon[], x: number, z: number, plateau: number): number {
  for (const c of canyons) {
    const d = Math.hypot(x - c.x, z - c.z);
    plateau = Math.max(plateau, smoothstep(c.r, c.r * 0.7, d) * c.height * (0.85 + 0.3 * noise2(x / 90, z / 90, 31)));
  }
  return plateau;
}

/** Tatooine: dunes across the prevailing wind, terraced mesas. */
function dunes(canyons: readonly Canyon[], x: number, z: number): number {
  const broad = fbm2(x / 2600, z / 2600, 4, 3) * 34;
  // Dunes: ridges across the prevailing wind (rotated frame), stronger away from the rocky areas.
  const wx = x * 0.8 + z * 0.6;
  const wz = -x * 0.6 + z * 0.8;
  const duneMask = smoothstep(0.35, 0.65, fbm2(x / 1400, z / 1400, 2, 9));
  const dunes = (ridge2(wx / 170, wz / 640, 5) * 0.75 + ridge2(wx / 60, wz / 220, 6) * 0.25) * 14 * duneMask;
  // Mesas: terraced plateaus with steep cliffs.
  const m = fbm2(x / 1900 + 4.1, z / 1900 - 2.3, 4, 21);
  const plateau = smoothstep(0.58, 0.61, m) * 60 + smoothstep(0.68, 0.7, m) * 45;
  return broad + dunes + canyonPlateau(canyons, x, z, plateau);
}

/** Ando Prime: snowfields between sharp alpine ridges, wind-packed drifts. */
function alpine(canyons: readonly Canyon[], x: number, z: number): number {
  const broad = 22 + fbm2(x / 3000, z / 3000, 4, 103) * 44;
  // Squared ridged noise gives knife-edge crests with broad flanks; the mask keeps wide valleys open.
  const mask = smoothstep(0.5, 0.72, fbm2(x / 2400 + 1.7, z / 2400 - 3.1, 3, 105));
  const r1 = ridge2(x / 520, z / 760, 107);
  const r2 = ridge2(x / 190, z / 240, 109);
  const ridges = (r1 * r1 * 0.75 + r2 * r2 * 0.25) * 150 * mask;
  const wx = x * 0.8 + z * 0.6;
  const wz = -x * 0.6 + z * 0.8;
  const drifts = ridge2(wx / 90, wz / 300, 111) * 3;
  return broad + drifts + canyonPlateau(canyons, x, z, ridges);
}

/** Malastare: flat grass plains with gentle swells and flat-topped table mountains. */
function plains(canyons: readonly Canyon[], x: number, z: number): number {
  const broad = 10 + fbm2(x / 2800, z / 2800, 4, 203) * 18;
  const swells = fbm2(x / 400, z / 400, 3, 205) * 5;
  const m = fbm2(x / 1700 + 2.3, z / 1700 - 1.1, 4, 207);
  const mesas = smoothstep(0.6, 0.62, m) * 70 + smoothstep(0.69, 0.71, m) * 40;
  return broad + swells + canyonPlateau(canyons, x, z, mesas);
}

/** Baroonda: jungle lowland mounds, black lava ridges breaking through. */
function coast(canyons: readonly Canyon[], x: number, z: number): number {
  const broad = 8 + fbm2(x / 2400, z / 2400, 4, 303) * 22;
  const mounds = fbm2(x / 220, z / 220, 3, 305) * 7;
  const lr = ridge2(x / 600, z / 600, 307);
  const lava = lr * lr * lr * 40 * smoothstep(0.5, 0.7, fbm2(x / 1800, z / 1800, 2, 309));
  return broad + mounds + canyonPlateau(canyons, x, z, lava);
}

/** Natural ground height before the track is carved in. */
function natural(track: Track, x: number, z: number): number {
  const t = track.def.theme.terrain;
  const canyons = track.canyons;
  if (t.kind === 'dunes') return dunes(canyons, x, z);
  let h = t.kind === 'alpine' ? alpine(canyons, x, z) : t.kind === 'plains' ? plains(canyons, x, z) : coast(canyons, x, z);
  if (t.rim > 0) {
    // Mountain wall closing the valley: starts 400 m past the farthest centreline point.
    const dc = Math.hypot(x - track.center.x, z - track.center.z);
    const w = smoothstep(track.radius + 400, track.radius + 2900, dc);
    if (w > 0) h += t.rim * w * (0.55 + 0.45 * ridge2(x / 900, z / 900, 401));
  }
  const v = t.volcano;
  if (v) {
    const d = Math.hypot(x - v.x, z - v.z);
    if (d < v.r) {
      // Concave cone with lava gullies; the crater (a tenth of the base radius) sinks the summit by
      // 12% of the height, a bowl below the rim the cone reaches there.
      const rc = v.r * 0.1;
      // Gullies fade out toward the summit so the crater rim stays level (the lava lake sits inside it).
      const gully = 1 + (noise2(x / 140, z / 140, 311) - 0.5) * 0.2 * smoothstep(rc * 1.5, rc * 3, d);
      const k = Math.max(d, rc) / v.r;
      const top = v.height * (1 - k) ** 1.6 - (d < rc ? v.height * 0.12 * (1 - (d / rc) ** 2) : 0);
      h = Math.max(h, 8 + top * gully);
    }
  }
  const c = t.coast;
  if (c) h += (-30 - h) * smoothstep(-150, 650, c.nx * x + c.nz * z - c.d);
  for (const b of t.basins) {
    const d = Math.hypot(x - b.x, z - b.z);
    if (d < b.r) h += (b.floor - h) * smoothstep(b.r, b.r * 0.45, d);
  }
  return h;
}

/** Solid ground with the track bed and its banks carved in (what the terrain meshes show). */
export function terrainHeight(track: Track, x: number, z: number): number {
  const h = natural(track, x, z);
  track.nearest(x, z, _hit, 160);
  if (_hit.dist === Infinity) return h;
  // Inside canyons the banks are steep walls; in the open the bed blends into the natural ground.
  const bank = THREE.MathUtils.lerp(70, 18, rockiness(track.canyons, x, z));
  const t = smoothstep(TRACK_HALF_WIDTH, TRACK_HALF_WIDTH + bank, _hit.dist);
  // Gentle ruts and bumps on the bed itself.
  const bed = _hit.floorY + (noise2(x / 25, z / 25, 41) - 0.5) * 0.8;
  return bed + (h - bed) * t;
}

/** What pods, cameras and props stand on: the carved ground, or the liquid surface where it is higher. */
export function groundHeight(track: Track, x: number, z: number): number {
  const h = terrainHeight(track, x, z);
  const liquid = track.def.theme.liquid;
  return liquid && h < liquid.level ? liquid.level : h;
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
    const fine = THREE.MathUtils.lerp(80, 104, rockiness(track.canyons, p.x, p.z));
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
    for (let k = first; k < last; k++) hgt[k] = terrainHeight(track, p.x + right.x * lat[k], p.z + right.z * lat[k]);
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
      const x = (i / segs - 0.5) * size + track.center.x;
      const z = (j / segs - 0.5) * size + track.center.z;
      track.nearest(x, z, hit, corridorWidth + 100);
      const k = j * n + i;
      inside[k] = hit.dist < corridorWidth * 0.8 ? 1 : 0;
      const sink = hit.dist < corridorWidth * 0.95 ? 6 : 0;
      pos.set([x, terrainHeight(track, x, z) - sink, z], k * 3);
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
  const mat = terrainMaterial(track.def.theme.surface);
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
