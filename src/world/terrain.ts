// Tatooine dune sea: one height function shared by two meshes.
// - Corridor: a fine strip that follows the track (2 to 30 m spacing), where the camera actually is.
// - Backdrop: a coarse 14 km grid for dunes and mesas on the horizon; under the corridor its triangles
//   are dropped (or sunk) so the fine strip shows.
// Colour comes from vertex colours (sand, packed track bed, layered rock on steep faces) times a tiled
// procedural detail texture for close-up grain.
import * as THREE from 'three';
import { clamp, smoothstep } from '../core/rng';
import { fbm2, noise2, ridge2 } from './noise';
import { CANYONS, TRACK_HALF_WIDTH, type Track, type TrackHit } from './track';

const _hit: TrackHit = { dist: 0, floorY: 0, u: 0 };

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
  let rocky = 0;
  for (const c of CANYONS) rocky = Math.max(rocky, smoothstep(c.r, c.r * 0.6, Math.hypot(x - c.x, z - c.z)));
  const bank = THREE.MathUtils.lerp(70, 18, rocky);
  const t = smoothstep(TRACK_HALF_WIDTH, TRACK_HALF_WIDTH + bank, _hit.dist);
  // Gentle ruts and bumps on the bed itself.
  const bed = _hit.floorY + (noise2(x / 25, z / 25, 41) - 0.5) * 0.8;
  return bed + (h - bed) * t;
}

const SAND = new THREE.Color(0.86, 0.66, 0.43);
const SAND_DARK = new THREE.Color(0.72, 0.5, 0.3);
const BED = new THREE.Color(0.66, 0.5, 0.36);
const ROCK_A = new THREE.Color(0.5, 0.27, 0.15);
const ROCK_B = new THREE.Color(0.68, 0.42, 0.26);
const _c = new THREE.Color();

function colorAt(track: Track, x: number, y: number, z: number, ny: number, out: THREE.Color): void {
  const n = fbm2(x / 90, z / 90, 3, 51);
  out.copy(SAND).lerp(SAND_DARK, n * 0.7);
  // Steep faces: layered sandstone strata.
  const slope = 1 - ny;
  const strata = 0.5 + 0.5 * Math.sin(y * 0.55 + noise2(x / 40, z / 40, 61) * 3);
  _c.copy(ROCK_A).lerp(ROCK_B, strata);
  out.lerp(_c, smoothstep(0.22, 0.42, slope));
  // Packed track bed.
  track.nearest(x, z, _hit, 60);
  if (_hit.dist < TRACK_HALF_WIDTH + 6) out.lerp(BED, smoothstep(TRACK_HALF_WIDTH + 6, TRACK_HALF_WIDTH - 4, _hit.dist) * 0.55);
}

/** Tiled sand grain / ripple detail (multiplied over the vertex colours). */
function detailTexture(): THREE.CanvasTexture {
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // Tileable: both noises use a wrapping lattice (16 and 128 cells across the texture).
      const ripple = 0.5 + 0.5 * Math.sin((y / N) * Math.PI * 2 * 9 + noise2((x / N) * 16, (y / N) * 16, 7, 16) * 2.5);
      const grain = noise2((x / N) * 128, (y / N) * 128, 13, 128);
      const v = clamp(0.82 + ripple * 0.1 + (grain - 0.5) * 0.16, 0, 1);
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function finish(geo: THREE.BufferGeometry, track: Track): void {
  geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    colorAt(track, x, pos.getY(i), z, nrm.getY(i), _c);
    col.set([_c.r, _c.g, _c.b], i * 3);
    uv.set([x / 9, z / 9], i * 2); // detail texture tiles every 9 m
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Fine strip along the track: lateral spacing grows from 2 m at the centre to ~30 m at the edge. */
function corridor(track: Track, halfWidth: number): THREE.BufferGeometry {
  const lateral: number[] = [];
  for (let i = -36; i <= 36; i++) {
    const s = i / 36;
    lateral.push(Math.sign(s) * s * s * halfWidth * 0.93 + s * halfWidth * 0.07);
  }
  const rings = Math.ceil(track.length / 5);
  const cols = lateral.length;
  const pos = new Float32Array(rings * cols * 3);
  const p = new THREE.Vector3();
  const tng = new THREE.Vector3();
  const right = new THREE.Vector3();
  for (let r = 0; r < rings; r++) {
    track.frame(r / rings, p, tng, right);
    for (let c = 0; c < cols; c++) {
      const x = p.x + right.x * lateral[c];
      const z = p.z + right.z * lateral[c];
      pos.set([x, groundHeight(track, x, z), z], (r * cols + c) * 3);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rings; r++) {
    const r2 = (r + 1) % rings; // closed loop
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = r2 * cols + c;
      // Rings run forward, columns run right: (a, a+1, b) winds counter-clockwise seen from above.
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
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
  geo.setIndex(idx);
  return geo;
}

export function buildTerrain(track: Track): THREE.Group {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detailTexture(), roughness: 0.96, metalness: 0 });
  const CORRIDOR = 240;
  const near = corridor(track, CORRIDOR);
  finish(near, track);
  const far = backdrop(track, 14000, 220, CORRIDOR);
  finish(far, track);
  const group = new THREE.Group();
  const a = new THREE.Mesh(near, mat);
  a.receiveShadow = true;
  const b = new THREE.Mesh(far, mat);
  b.receiveShadow = true;
  group.add(a, b);
  return group;
}
