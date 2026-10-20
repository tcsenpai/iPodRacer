// The living horizon around a course: layered mountain and mesa ranges 7.6 to 19.5 km out with their own
// aerial perspective, a distant plain (or sea) that closes the gap to the course terrain, named landmark
// silhouettes, moons and ringed giants on the sky, drifting cloud bands, ships or birds on slow arcs, dust
// devils and volcanic smoke. Nothing comes within ~3 km of the centre, so none of it can touch the course.
// Draw calls: at most 9 (ranges, landmarks, convoy, flyers, glows, dust devils, smoke, sky bodies, clouds).
//
// Research sources for the Tatooine landmarks and the other Episode I: Racer planets:
// - Jundland Wastes: https://starwars.fandom.com/wiki/Jundland_Wastes
// - Jabba's Palace (B'omarr monastery, fringe of the Northern Dune Sea, single canyon road):
//   https://starwars.fandom.com/wiki/Jabba's_Palace/Legends, https://starwars.fandom.com/wiki/Boba_Fett%27s_Palace,
//   https://www.starwars.com/databank/jabba-the-hutts-palace
// - Dune Sea: https://starwars.fandom.com/wiki/Dune_Sea
// - Krayt dragon (skeleton in the Dune Sea): https://starwars.fandom.com/wiki/Krayt_dragon,
//   https://starwars.fandom.com/wiki/Greater_krayt_dragon
// - Mos Espa podrace circuit (Mushroom Mesa, Ben's Mesa, Beggar's Canyon, Hutt Flats, Waldo Grade):
//   https://starwars.fandom.com/wiki/Mos_Espa_podrace_circuit, https://starwars.fandom.com/wiki/Ben's_Mesa,
//   https://starwars.fandom.com/wiki/Beggar's_Canyon
// - Boonta Eve Classic (Arch Canyon, course layout): https://starwars.fandom.com/wiki/Boonta_Eve_Classic/Legends,
//   https://www.ign.com/wikis/star-wars-episode-i-racer
// - Mos Espa: https://starwars.fandom.com/wiki/Mos_Espa
// - Sandcrawler: https://starwars.fandom.com/wiki/Sandcrawler, https://en.wikipedia.org/wiki/Sandcrawler
// - Ando Prime (ice planet): https://starwars.fandom.com/wiki/Ando_Prime
// - Malastare (methane, Gran colonists): https://starwars.fandom.com/wiki/Malastare/Legends,
//   https://starwars.fandom.com/wiki/Gran
// - Baroonda (volcanic swamp world of Episode I: Racer): https://giantbomb.com/wiki/Locations/Baroonda
import * as THREE from 'three';
import { Rng, smoothstep } from '../core/rng';
import { noise2 } from './noise';
import type { HorizonTheme, Theme } from './theme';
import { Builder, box, sandcrawler, tr } from './lifeModels';
import type { HazeUniforms } from './horizonShaders';
import { columnMaterial, farMaterial, glowMaterial, hazeUniforms } from './horizonShaders';
import { buildBodies, buildClouds, themeColor } from './horizonSky';
import type { Ground } from './horizonLandmarks';
import { LANDMARK_SITES, buildLandmarks, sitePosition } from './horizonLandmarks';

export interface Horizon {
  group: THREE.Group;
  update(dt: number, camera: THREE.Camera): void;
}

// -------------------------------------------------------------------------------------------------
// Ranges

interface Range {
  r0: number;
  r1: number;
  /** Height relative to theme.mountainHeight. */
  height: number;
  segs: number;
  /** Noise cells around the ring (integer so the profile wraps seamlessly). */
  period: number;
  /** 0 = continuous range, toward 1 = broken into separate massifs that let the next layer show. */
  gate: number;
  seed: number;
}

const RANGES: readonly Range[] = [
  { r0: 7600, r1: 9800, height: 0.55, segs: 900, period: 48, gate: 0.55, seed: 3 },
  { r0: 10500, r1: 13800, height: 0.95, segs: 720, period: 40, gate: 0.3, seed: 5 },
  { r0: 14500, r1: 19500, height: 1.5, segs: 540, period: 32, gate: 0, seed: 7 },
];
const ROWS = 8;
const BURY = 150; // m: range feet sink below the plain so no seam shows
const PLAIN_RADII = [6700, 7300, 8200, 10000, 13000, 17000, 22000];
const PLAIN_SEGS = 256;

/** Periodic fbm around the ring: `a` in noise cells (wraps at `period`), `b` across the range. */
function ringFbm(a: number, b: number, period: number, seed: number, ridged: boolean): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  for (let o = 0; o < 4; o++) {
    const n = noise2(a, b + o * 7.3, seed + o * 13, p);
    sum += (ridged ? Math.pow(1 - Math.abs(n * 2 - 1), 1.4) : n) * amp;
    norm += amp;
    amp *= 0.5;
    a *= 2;
    b *= 2;
    p *= 2;
  }
  return sum / norm;
}

function buildRanges(theme: Theme, center: { x: number; z: number }, ground: Ground): THREE.BufferGeometry {
  const h = theme.horizon;
  const pos: number[] = [];
  const col: number[] = [];
  const nrm: number[] = [];
  const index: number[] = [];
  const rock = themeColor(h.mountains);
  const fog = new THREE.Color(theme.fogColor);
  const c = new THREE.Color();

  // Distant plain: its inner edge follows the course terrain (under the backdrop's rim), the rest sits at the
  // mean level; a liquid planet's sea carries on to the horizon wherever the inner edge is under the surface.
  const liquid = theme.liquid;
  const plainCol = rock.clone().lerp(fog, 0.45);
  const sea = liquid ? new THREE.Color().setRGB(liquid.deep[0], liquid.deep[1], liquid.deep[2]) : null;
  const inner: number[] = [];
  let level = 0;
  for (let i = 0; i <= PLAIN_SEGS; i++) {
    const a = (i / PLAIN_SEGS) * Math.PI * 2;
    const g = ground(center.x + Math.cos(a) * PLAIN_RADII[0], center.z + Math.sin(a) * PLAIN_RADII[0]);
    inner.push(g);
    level += g / (PLAIN_SEGS + 1);
  }
  for (let j = 0; j < PLAIN_RADII.length; j++) {
    for (let i = 0; i <= PLAIN_SEGS; i++) {
      const a = (i / PLAIN_SEGS) * Math.PI * 2;
      const wet = liquid !== null && sea !== null && inner[i] <= liquid.level + 0.5;
      const y = wet && liquid ? liquid.level - 0.3 : (j === 0 ? inner[i] : level) - 2;
      pos.push(center.x + Math.cos(a) * PLAIN_RADII[j], y, center.z + Math.sin(a) * PLAIN_RADII[j]);
      nrm.push(0, 1, 0);
      c.copy(wet && sea ? sea : plainCol).multiplyScalar(0.92 + 0.16 * noise2(i * 0.15, j, 41));
      col.push(c.r, c.g, c.b);
      if (j > 0 && i < PLAIN_SEGS) {
        const a0 = (j - 1) * (PLAIN_SEGS + 1) + i;
        const b0 = a0 + PLAIN_SEGS + 1;
        index.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
      }
    }
  }

  // Ranges: radial height fields, so each massif has real slopes for the sun to shade.
  const flatness = (1 - h.jagged) * 0.85;
  for (const r of RANGES) {
    const first = pos.length / 3;
    const peak = h.mountainHeight * r.height;
    for (let j = 0; j <= ROWS; j++) {
      const t = j / ROWS;
      const cross = Math.pow(Math.sin(Math.PI * t), 0.8);
      const radius = r.r0 + (r.r1 - r.r0) * t;
      for (let i = 0; i <= r.segs; i++) {
        const u = (i % r.segs) / r.segs;
        const a = u * r.period;
        const smooth = ringFbm(a, t * 2.5, r.period, r.seed, false);
        const ridged = ringFbm(a, t * 2.5, r.period, r.seed + 100, true);
        const prof = smooth + (ridged - smooth) * h.jagged;
        const gate = r.gate > 0 ? smoothstep(r.gate - 0.15, r.gate + 0.15, noise2(u * 8, 0.5, r.seed + 9, 8)) : 1;
        let hh = peak * (0.3 + 1.1 * prof) * gate * cross;
        // Low jaggedness flattens the crests into mesas: heights saturate toward a varying cap.
        const cap = peak * (0.55 + 0.4 * noise2(u * 16, 2.5, r.seed + 3, 16));
        hh += (cap * (1 - Math.exp(-hh / cap)) - hh) * flatness;
        const y = level - BURY * (1 - cross) + hh;
        const ang = u * Math.PI * 2;
        pos.push(center.x + Math.cos(ang) * radius, y, center.z + Math.sin(ang) * radius);
        nrm.push(0, 1, 0);
        // Strata bands and darker gullies; the haze in the shader does the depth grading.
        const n = noise2(a * 3, t * 4, r.seed + 20, r.period * 3);
        const k = (0.82 + 0.3 * n) * (1 + 0.07 * Math.sin(y * 0.05 + n * 4)) * (0.75 + 0.25 * Math.min(1, hh / Math.max(peak, 1)));
        c.copy(rock).multiplyScalar(k);
        col.push(c.r, c.g, c.b);
        if (j > 0 && i < r.segs) {
          const a0 = first + (j - 1) * (r.segs + 1) + i;
          const b0 = a0 + r.segs + 1;
          // Same winding as the plain: the inner slopes face the course (and the sky).
          index.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// -------------------------------------------------------------------------------------------------
// Flyers

interface Flyer {
  phase: number;
  omega: number;
  radius: number;
  alt: number;
  amp: number;
  ox: number;
  oz: number;
  scale: number;
  seed: number;
}

/** Freighter facing -Z (about 32 m long): fuselage, wings, twin nacelles, fin. Engines at z = +12.5. */
function shipGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  const hull = 0x9a9a96;
  const dark = 0x3a3a3c;
  b.add(new THREE.CylinderGeometry(2.4, 3.2, 30, 10), hull, tr(0, 0, 0, 0, 1, 1, 1, Math.PI / 2));
  b.add(new THREE.SphereGeometry(2.6, 10, 6), 0x30343a, tr(0, 0.8, -14));
  b.add(box(-16, -0.5, -2, 16, 0.5, 6), 0x8a8478);
  for (const x of [-10, 10]) b.add(new THREE.CylinderGeometry(1.8, 2.2, 12, 8), dark, tr(x, 0, 6, 0, 1, 1, 1, Math.PI / 2));
  b.add(box(-0.4, 0, 2, 0.4, 6, 12), hull);
  return b.build();
}

/** Gliding bird about 1.1 m across (instances scale it to giant desert/jungle fliers); +Y is wing lift. */
function birdGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  const tone = 0x2e2620;
  b.add(box(-0.06, -0.04, -0.35, 0.06, 0.04, 0.35), tone);
  for (const s of [-1, 1]) b.add(box(0, -0.01, -0.12, 0.55, 0.01, 0.12), tone, tr(s * 0.05, 0, 0, s > 0 ? 0 : Math.PI, 1, 1, 1, 0, 0.3));
  b.add(box(-0.12, -0.01, 0.3, 0.12, 0.01, 0.5), tone);
  return b.build();
}

const SHIP_ENGINES: readonly (readonly [number, number, number])[] = [
  [-10, 0, 12.4],
  [10, 0, 12.4],
  [0, 0, 15.2],
];

// -------------------------------------------------------------------------------------------------
// Dust devils

interface Devil {
  bearing: number;
  dist: number;
  drift: number;
  age: number;
  life: number;
  radius: number;
  height: number;
  base: number;
}

const DEVIL_COUNT = 6;

// Scratch (update() must not allocate).
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

/**
 * Builds the horizon for a planet theme around the course `center`. `ground` (optional, default flat at 0)
 * lets landmarks, the convoy, dust devils and the inner plain edge sit on the course terrain.
 */
export function buildHorizon(theme: Theme, center: { x: number; z: number }, ground: Ground = () => 0): Horizon {
  const h: HorizonTheme = theme.horizon;
  const group = new THREE.Group();
  group.name = 'horizon';
  const haze: HazeUniforms = hazeUniforms(theme.fogColor, theme.sunDir);
  const far = farMaterial(haze);
  const rng = new Rng(0x9e1f);

  const ranges = new THREE.Mesh(buildRanges(theme, center, ground), far);
  ranges.matrixAutoUpdate = false;
  group.add(ranges);

  const marks = buildLandmarks(h.landmarks, center, ground);
  if (marks.geometry) {
    const mesh = new THREE.Mesh(marks.geometry, far);
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  const bodies = buildBodies(h, theme.sunDir);
  if (bodies) group.add(bodies);
  const clouds = buildClouds(h, haze);
  if (clouds) group.add(clouds);

  // Jawa convoy crawling along a great circle around the course.
  const convoySite = h.landmarks.includes('sandcrawler-convoy') ? LANDMARK_SITES['sandcrawler-convoy'] : null;
  const CRAWLERS = 3;
  const CRAWLER_SPEED = 3.2; // m/s
  const CRAWLER_GAP = 150; // m between crawlers along the arc
  let convoy: THREE.InstancedMesh | null = null;
  let convoyAngle = 0;
  if (convoySite) {
    const b = new Builder();
    sandcrawler(b);
    convoy = new THREE.InstancedMesh(b.build(), far, CRAWLERS);
    convoy.frustumCulled = false;
    convoy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    sitePosition(convoySite, center, _p);
    convoyAngle = Math.atan2(_p.z - center.z, _p.x - center.x);
    group.add(convoy);
  }

  // Flyers: ships with engine glows, or birds with flapping wings.
  const flyers: Flyer[] = [];
  let flyMesh: THREE.InstancedMesh | null = null;
  const ships = h.flyers === 'ships';
  if (h.flyers !== 'none') {
    const count = ships ? 6 : 16;
    for (let i = 0; i < count; i++) {
      const radius = ships ? rng.range(4300, 8500) : rng.range(3800, 5600);
      flyers.push({
        phase: rng.range(0, Math.PI * 2),
        // Ships cruise at 120-260 m/s, birds glide at 15-25 m/s; the sign picks the direction around.
        omega: (rng.sign() * (ships ? rng.range(120, 260) : rng.range(15, 25))) / radius,
        radius,
        alt: ships ? rng.range(500, 2200) : rng.range(220, 650),
        amp: ships ? rng.range(80, 400) : rng.range(20, 80),
        ox: rng.range(-700, 700),
        oz: rng.range(-700, 700),
        scale: ships ? rng.range(1.8, 3) : rng.range(18, 28),
        seed: rng.range(0, 100),
      });
    }
    flyMesh = new THREE.InstancedMesh(ships ? shipGeometry() : birdGeometry(), far, count);
    flyMesh.frustumCulled = false;
    flyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(flyMesh);
  }

  // Glow sprites: ship engines first (rewritten every frame), then the static landmark fires.
  const dynGlows = ships ? flyers.length * SHIP_ENGINES.length : 0;
  const staticGlows = marks.glows.length / 8;
  const glowCount = dynGlows + staticGlows;
  let glowPos: THREE.BufferAttribute | null = null;
  if (glowCount > 0) {
    const p = new Float32Array(glowCount * 3);
    const color = new Float32Array(glowCount * 3);
    const size = new Float32Array(glowCount);
    const flicker = new Float32Array(glowCount);
    for (let i = 0; i < dynGlows; i++) {
      color.set([1.6, 1.8, 2.6], i * 3);
      size[i] = 16;
    }
    for (let i = 0; i < staticGlows; i++) {
      const o = i * 8;
      const k = dynGlows + i;
      p.set(marks.glows.slice(o, o + 3), k * 3);
      color.set(marks.glows.slice(o + 3, o + 6), k * 3);
      size[k] = marks.glows[o + 6];
      flicker[k] = marks.glows[o + 7];
    }
    const geo = new THREE.BufferGeometry();
    glowPos = new THREE.BufferAttribute(p, 3);
    glowPos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', glowPos);
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aFlicker', new THREE.BufferAttribute(flicker, 1));
    const points = new THREE.Points(geo, glowMaterial(haze));
    points.frustumCulled = false;
    group.add(points);
  }

  // Unit open column with its foot at the origin, shared by smoke and dust devils: many rings so the sway
  // bends smoothly.
  const column = new THREE.CylinderGeometry(1, 1, 1, 20, 24, true).translate(0, 0.5, 0);

  // Smoke columns from the landmarks (volcano), static.
  const plumeCount = marks.plumes.length / 5;
  if (plumeCount > 0) {
    const smoke = new THREE.InstancedMesh(column, columnMaterial(haze, 0.12, 1.2, 0.7), plumeCount);
    const tint = new THREE.Color(0x5a524c);
    for (let i = 0; i < plumeCount; i++) {
      const o = i * 5;
      _m.makeScale(marks.plumes[o + 3], marks.plumes[o + 4], marks.plumes[o + 3]).setPosition(marks.plumes[o], marks.plumes[o + 1], marks.plumes[o + 2]);
      smoke.setMatrixAt(i, _m);
      smoke.setColorAt(i, tint);
    }
    group.add(smoke);
  }

  // Dust devils wandering near the horizon, spinning up and dying away.
  const devils: Devil[] = [];
  let devilMesh: THREE.InstancedMesh | null = null;
  const respawn = (d: Devil, age: number): void => {
    d.bearing = rng.range(0, Math.PI * 2);
    d.dist = rng.range(3800, 6800);
    d.drift = rng.range(-6, 6);
    d.age = age;
    d.life = rng.range(40, 80);
    d.radius = rng.range(18, 42);
    d.height = rng.range(260, 620);
    // Foot a little below the sand: the column fades out there anyway, and dunes rise and fall as it drifts.
    d.base = ground(center.x + Math.sin(d.bearing) * d.dist, center.z - Math.cos(d.bearing) * d.dist) - 12;
  };
  if (h.dustDevils) {
    devilMesh = new THREE.InstancedMesh(column, columnMaterial(haze, 1.6, 0.9, 0.42), DEVIL_COUNT);
    devilMesh.frustumCulled = false;
    devilMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const tint = themeColor(h.mountains).lerp(new THREE.Color(theme.fogColor), 0.6);
    for (let i = 0; i < DEVIL_COUNT; i++) {
      const d: Devil = { bearing: 0, dist: 0, drift: 0, age: 0, life: 1, radius: 1, height: 1, base: 0 };
      respawn(d, 0);
      // Stagger the life cycles so they never all appear together.
      d.age = (i / DEVIL_COUNT) * d.life;
      devils.push(d);
      devilMesh.setColorAt(i, tint);
    }
    group.add(devilMesh);
  }

  return {
    group,
    update(dt, _camera) {
      haze.uTime.value += dt;
      const time = haze.uTime.value;

      if (flyMesh) {
        for (let i = 0; i < flyers.length; i++) {
          const f = flyers[i];
          f.phase += f.omega * dt;
          const c = Math.cos(f.phase);
          const s = Math.sin(f.phase);
          const dir = Math.sign(f.omega);
          const climb = f.amp * 2 * Math.cos(f.phase * 2 + f.seed);
          _p.set(center.x + f.ox + f.radius * c, f.alt + f.amp * Math.sin(f.phase * 2 + f.seed), center.z + f.oz + f.radius * s);
          // Heading along the circle, nose following the climb, banked into the turn: with increasing
          // phase the centre lies on the right (negative roll), otherwise on the left.
          const dx = -s * dir;
          const dz = c * dir;
          const yaw = Math.atan2(-dx, -dz);
          const pitch = Math.atan2(climb * dir, f.radius);
          const roll = dir > 0 ? -0.32 : 0.32;
          _e.set(pitch, yaw, ships ? roll : roll * 0.6);
          _q.setFromEuler(_e);
          if (ships) {
            _s.setScalar(f.scale);
          } else {
            // Birds glide, flapping in bursts: flipping the wing dihedral reads as a wingbeat from afar.
            const burst = smoothstep(0.6, 0.8, Math.sin(time * 0.4 + f.seed));
            const flap = 1 - burst + burst * Math.sin(time * 9 + f.seed * 3);
            _s.set(f.scale, f.scale * (Math.abs(flap) < 0.15 ? Math.sign(flap || 1) * 0.15 : flap), f.scale);
          }
          _m.compose(_p, _q, _s);
          flyMesh.setMatrixAt(i, _m);
          if (glowPos && ships) {
            for (let k = 0; k < SHIP_ENGINES.length; k++) {
              const e = SHIP_ENGINES[k];
              _v.set(e[0], e[1], e[2]).applyMatrix4(_m);
              glowPos.setXYZ(i * SHIP_ENGINES.length + k, _v.x, _v.y, _v.z);
            }
          }
        }
        flyMesh.instanceMatrix.needsUpdate = true;
        if (glowPos && dynGlows > 0) {
          glowPos.clearUpdateRanges();
          glowPos.addUpdateRange(0, dynGlows * 3);
          glowPos.needsUpdate = true;
        }
      }

      if (convoy && convoySite) {
        convoyAngle += (CRAWLER_SPEED / convoySite.dist) * dt;
        for (let i = 0; i < CRAWLERS; i++) {
          const a = convoyAngle - (i * CRAWLER_GAP) / convoySite.dist;
          const c = Math.cos(a);
          const s = Math.sin(a);
          const x = center.x + c * convoySite.dist;
          const z = center.z + s * convoySite.dist;
          // Treads a metre into the sand; the crawler faces +Z, so yaw onto the tangent (-sin, cos).
          _p.set(x, ground(x, z) - 1, z);
          _e.set(0, Math.atan2(-s, c), 0);
          _q.setFromEuler(_e);
          _m.compose(_p, _q, _s.setScalar(1.6));
          convoy.setMatrixAt(i, _m);
        }
        convoy.instanceMatrix.needsUpdate = true;
      }

      if (devilMesh) {
        for (let i = 0; i < devils.length; i++) {
          const d = devils[i];
          d.age += dt;
          if (d.age > d.life) respawn(d, 0);
          d.bearing += (d.drift * dt) / d.dist;
          const env = smoothstep(0, 7, d.age) * (1 - smoothstep(d.life - 9, d.life, d.age));
          _p.set(center.x + Math.sin(d.bearing) * d.dist, d.base, center.z - Math.cos(d.bearing) * d.dist);
          _q.identity();
          _s.set(d.radius * (0.35 + 0.65 * env), d.height * (0.1 + 0.9 * env) + 1, d.radius * (0.35 + 0.65 * env));
          _m.compose(_p, _q, _s);
          devilMesh.setMatrixAt(i, _m);
        }
        devilMesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
