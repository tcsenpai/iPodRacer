// Track-side scenery: the start/finish gate, sandstone arches spanning the course and hoodoo pillars.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { noise2 } from './noise';
import { groundHeight } from './terrain';
import { TRACK_HALF_WIDTH, type Track } from './track';

const ROCK = new THREE.MeshStandardMaterial({ color: 0x9a6440, roughness: 0.92, flatShading: true });

/**
 * Displace every vertex along its normal by low-frequency noise: turns primitives into weathered rock.
 * Vertices are welded first, so faces sharing a corner move together (no cracks).
 */
function weather(src: THREE.BufferGeometry, amount: number, scale: number, seed: number): THREE.BufferGeometry {
  src.deleteAttribute('normal');
  src.deleteAttribute('uv');
  const geo = mergeVertices(src);
  src.dispose();
  geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = (noise2(x / scale + z / (scale * 1.7), y / scale, seed) - 0.5) * 2 * amount;
    pos.setXYZ(i, x + nrm.getX(i) * n, y + nrm.getY(i) * n, z + nrm.getZ(i) * n);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Checkered banner for the start/finish gate. */
function checkerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 32;
  const g = c.getContext('2d')!;
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#eee';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildProps(track: Track): THREE.Group {
  const group = new THREE.Group();
  const p = new THREE.Vector3();
  const tng = new THREE.Vector3();
  const right = new THREE.Vector3();
  const rng = new Rng(77);
  const place = (obj: THREE.Object3D, u: number, lateral: number) => {
    track.frame(u, p, tng, right);
    const x = p.x + right.x * lateral;
    const z = p.z + right.z * lateral;
    obj.position.set(x, groundHeight(track, x, z), z);
    obj.rotation.y = Math.atan2(-tng.x, -tng.z);
    group.add(obj);
  };

  // Start / finish gate: two pylons and a checkered banner over the track.
  const gate = new THREE.Group();
  const pylonMat = new THREE.MeshStandardMaterial({ color: 0xcfc6b4, metalness: 0.3, roughness: 0.55 });
  for (const s of [-1, 1]) {
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.8, 26, 12), pylonMat);
    pylon.position.set(s * (TRACK_HALF_WIDTH + 4), 13, 0);
    pylon.castShadow = true;
    gate.add(pylon);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry((TRACK_HALF_WIDTH + 4) * 2, 3, 0.4), new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.7 }));
  banner.position.y = 23;
  banner.castShadow = true;
  gate.add(banner);
  place(gate, 0, 0);

  // Natural arches spanning the course.
  for (const u of [0.18, 0.47, 0.71]) {
    const R = TRACK_HALF_WIDTH + 14;
    const geo = weather(new THREE.TorusGeometry(R, 9, 10, 40, Math.PI), 3.5, 10, Math.round(u * 100));
    const arch = new THREE.Mesh(geo, ROCK);
    arch.castShadow = arch.receiveShadow = true;
    const holder = new THREE.Group();
    arch.position.y = -4; // feet sunk into the sand
    holder.add(arch);
    place(holder, u, 0);
  }

  // Hoodoos: stacked weathered rock lumps either side of the track.
  for (let i = 0; i < 70; i++) {
    const h = new THREE.Group();
    let y = 0;
    const tiers = rng.int(2, 4);
    for (let k = 0; k < tiers; k++) {
      const r = rng.range(3, 7) * (1 - k * 0.18);
      const tier = new THREE.Mesh(weather(new THREE.IcosahedronGeometry(r, 2), r * 0.25, r, i * 7 + k), ROCK);
      tier.scale.y = rng.range(1.2, 1.8);
      tier.position.y = y + r * tier.scale.y * 0.8;
      y += r * tier.scale.y * 1.5;
      tier.castShadow = tier.receiveShadow = true;
      h.add(tier);
    }
    place(h, rng.float(), rng.sign() * rng.range(TRACK_HALF_WIDTH + 30, 200));
  }
  return group;
}
