// Course hazards.
// - Tusken Raiders on the canyon rims (Tatooine), straight out of the film: a scope glint warns of the
//   shot ~0.9 s ahead; a barrel roll or knife edge at the right moment makes them miss, otherwise an
//   engine takes the slug. They target whoever is approaching in range, the player more often than not.
// - Flame geysers in the racing bed (Malastare): a vent glows and spits for ~1.6 s, then a column of
//   burning methane stands for ~2 s; crossing it scorches the engines and spikes their heat.
import * as THREE from 'three';
import { Rng, smoothstep } from '../core/rng';
import { SURFACE_NOISE_GLSL } from '../world/surface';
import { groundHeight } from '../world/terrain';
import { TRACK_HALF_WIDTH, type Track } from '../world/track';
import type { Pod, PodWorld } from './pod';

const AIM_TIME = 0.95;
const RANGE_MIN = 120;
const RANGE_MAX = 560;
/** Engine wear per hit. */
const HIT_WEAR = 0.3;

export interface SniperEvents {
  /** Aim started on `target` (the glint appears). */
  glint(target: Pod): void;
  /** Shot fired from `from`; `hit` false = a miss (dodged or wide). */
  shot(from: THREE.Vector3, target: Pod, hit: boolean, dodged: boolean): void;
}

interface Sniper {
  pos: THREE.Vector3;
  muzzle: THREE.Vector3;
  u: number;
  figure: THREE.Group;
  glint: THREE.Sprite;
  tracer: THREE.Line;
  tracerT: number;
  cooldown: number;
  aimT: number;
  target: Pod | null;
}

function glintTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.15, 'rgba(255,240,200,0.8)');
  grd.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  // Four-point star: reads as a lens glint even when tiny.
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillRect(31, 0, 2, 64);
  g.fillRect(0, 31, 64, 2);
  return new THREE.CanvasTexture(c);
}

/** A robed Tusken with a long rifle: lathe robe, wrapped head, goggles, bandolier. */
function tusken(cloth: THREE.Material, dark: THREE.Material, metal: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const robe = new THREE.Mesh(
    new THREE.LatheGeometry([new THREE.Vector2(0.55, 0), new THREE.Vector2(0.5, 0.3), new THREE.Vector2(0.36, 1.1), new THREE.Vector2(0.3, 1.45), new THREE.Vector2(0.18, 1.55)], 16),
    cloth,
  );
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), cloth);
  head.position.y = 1.72;
  head.scale.set(1, 1.15, 1);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 10), dark);
    eye.rotation.x = Math.PI / 2;
    eye.position.set(s * 0.075, 1.75, -0.17);
    g.add(eye);
  }
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 6, 20), dark);
  band.rotation.set(Math.PI / 2.4, 0, 0.4);
  band.position.y = 1.2;
  const rifle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 1.6, 8), metal);
  rifle.rotation.x = Math.PI / 2 - 0.15;
  rifle.position.set(0.18, 1.5, -0.6);
  g.add(robe, head, band, rifle);
  g.traverse((o) => (o.castShadow = true));
  return g;
}

export class Snipers {
  readonly group = new THREE.Group();
  private list: Sniper[] = [];

  constructor(
    private track: Track,
    private events: SniperEvents,
  ) {
    // Only planets with Tusken Raiders (Tatooine) post snipers; elsewhere the group stays empty.
    if (!track.def.theme.tuskens) return;
    const rng = new Rng(4242);
    const cloth = new THREE.MeshStandardMaterial({ color: 0xa08868, roughness: 0.95 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1612, roughness: 0.5, metalness: 0.3 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 0.4, metalness: 0.8 });
    const glintMat = new THREE.SpriteMaterial({ map: glintTexture(), color: new THREE.Color(6, 5, 3.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const tracerMat = new THREE.LineBasicMaterial({ color: new THREE.Color(4, 3, 1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const p = new THREE.Vector3();
    const tg = new THREE.Vector3();
    const r = new THREE.Vector3();
    // Perches: track points inside the canyons, alternating rims, high on the walls.
    const n = 600;
    let side = 1;
    let lastU = -1;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      track.frame(u, p, tg, r);
      if (!track.canyons.some((c) => Math.hypot(p.x - c.x, p.z - c.z) < c.r * 0.72)) continue;
      if (u - lastU < 0.022) continue;
      lastU = u;
      side = -side;
      const lat = side * rng.range(50, 70);
      const pos = new THREE.Vector3(p.x + r.x * lat, 0, p.z + r.z * lat);
      pos.y = groundHeight(track, pos.x, pos.z);
      const figure = tusken(cloth, dark, metal);
      figure.position.copy(pos);
      figure.lookAt(p.x, pos.y, p.z);
      // lookAt points +Z at the track; the figure faces -Z, so turn it around.
      figure.rotateY(Math.PI);
      const glint = new THREE.Sprite(glintMat.clone());
      glint.visible = false;
      const muzzle = new THREE.Vector3(0.18, 1.55, -1.4);
      figure.updateMatrixWorld();
      muzzle.applyMatrix4(figure.matrixWorld);
      glint.position.copy(muzzle);
      const tracer = new THREE.Line(new THREE.BufferGeometry().setFromPoints([muzzle, muzzle]), tracerMat);
      tracer.visible = false;
      tracer.frustumCulled = false;
      this.group.add(figure, glint, tracer);
      this.list.push({ pos, muzzle, u, figure, glint, tracer, tracerT: 0, cooldown: rng.range(2, 8), aimT: 0, target: null });
    }
  }

  get count(): number {
    return this.list.length;
  }

  update(dt: number, pods: readonly Pod[], world: PodWorld, accuracy: number, camera: THREE.Camera): void {
    const len = this.track.length;
    for (const s of this.list) {
      s.cooldown -= dt;
      if (s.tracerT > 0) {
        s.tracerT -= dt;
        s.tracer.visible = s.tracerT > 0;
      }
      if (!s.target) {
        s.glint.visible = false;
        if (s.cooldown > 0) continue;
        // Pick an approaching pod in range; the player gets the extra attention.
        let pick: Pod | null = null;
        for (const pod of pods) {
          if (!pod.alive || pod.out || pod.locked) continue;
          let du = (s.u - pod.u) * len;
          if (du < -len / 2) du += len;
          if (du > len / 2) du -= len;
          const d = pod.pos.distanceTo(s.pos);
          if (du < 40 || d < RANGE_MIN || d > RANGE_MAX) continue;
          if (!pick || (pod.player && Math.random() < 0.7)) pick = pod;
        }
        if (!pick) {
          s.cooldown = 0.5;
          continue;
        }
        s.target = pick;
        s.aimT = 0;
        this.events.glint(pick);
        continue;
      }
      // Aiming: the glint swells and flickers, sized to stay visible at any distance.
      s.aimT += dt;
      const k = Math.min(1, s.aimT / AIM_TIME);
      const dist = camera.position.distanceTo(s.muzzle);
      const size = dist * 0.012 * (0.6 + k * 1.2) * (0.85 + Math.sin(s.aimT * 40) * 0.15);
      s.glint.scale.setScalar(Math.max(size, 0.8));
      s.glint.visible = true;
      if (s.aimT < AIM_TIME) continue;

      const target = s.target;
      s.target = null;
      s.glint.visible = false;
      s.cooldown = 6 + Math.random() * 6;
      if (!target.alive) continue;
      const dodged = target.rolling || Math.abs(target.tilt) > 0.6 || target.ghost > 0;
      const hit = !dodged && Math.random() < accuracy;
      // Tracer to the pod, or past it on a miss.
      const end = s.tracer.geometry.getAttribute('position');
      end.setXYZ(0, s.muzzle.x, s.muzzle.y, s.muzzle.z);
      const miss = hit ? 0 : 6 + Math.random() * 6;
      end.setXYZ(1, target.pos.x + (Math.random() - 0.5) * miss, target.pos.y + 1 + Math.random() * miss * 0.3, target.pos.z + (Math.random() - 0.5) * miss);
      end.needsUpdate = true;
      s.tracer.visible = true;
      s.tracerT = 0.12;
      if (hit) target.damageEngine(Math.random() < 0.5 ? 0 : 1, HIT_WEAR, world);
      this.events.shot(s.muzzle, target, hit, dodged);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Flame geysers

const GEYSERS = 7;
/** Telegraph (glowing, spitting vent) and eruption lengths (s). */
const WARN_TIME = 1.6;
const ERUPT_TIME = 2.2;
const COLUMN_HEIGHT = 34;
const COLUMN_RADIUS = 3.2;
/** Horizontal reach of the burn around the vent (m) and engine wear per second inside it. */
const BURN_RADIUS = 7.5;
const BURN_WEAR = 0.55;

export interface GeyserEvents {
  /** A vent started its telegraph (~WARN_TIME before the eruption). */
  warn(at: THREE.Vector3): void;
  erupt(at: THREE.Vector3): void;
  /** `target` entered an erupting column (once per eruption); engine damage is already applied. */
  burn(target: Pod): void;
}

interface Geyser {
  pos: THREE.Vector3;
  phase: 'idle' | 'warn' | 'erupt';
  /** Seconds left in the current phase. */
  t: number;
  flame: THREE.Mesh;
  uniforms: { uHeight: { value: number }; uPower: { value: number }; uTime: { value: number }; uSeed: { value: number } };
  glow: THREE.MeshBasicMaterial;
  burned: Set<Pod>;
}

const FLAME_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uHeight;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  p.y *= uHeight;
  // The column billows wider as it climbs.
  p.xz *= 1.0 + uv.y * 0.9;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}`;

const FLAME_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uPower;
uniform float uSeed;
varying vec2 vUv;
${SURFACE_NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float y = vUv.y;
  // Tongues scroll upward and fray toward the top.
  vec2 q = vec2(vUv.x * 7.0, y * 3.0 - uTime * 5.0 + uSeed);
  float n = sfNoise2(q) * 0.6 + sfNoise2(q * 2.3 + 4.0) * 0.4;
  float body = smoothstep(1.0, 0.15, y + (n - 0.5) * 0.5);
  float a = clamp(body * (0.55 + 0.6 * n) * uPower, 0.0, 1.0);
  vec3 col = mix(vec3(1.0, 0.25, 0.04), vec3(1.0, 0.75, 0.3), smoothstep(0.6, 0.15, y + n * 0.2));
  // Emissive: the hot root sits above the bloom threshold on purpose.
  col *= 1.5 + 2.0 * (1.0 - y);
  gl_FragColor = vec4(col, a);
}`;

/** Methane vents in the racing bed that erupt in cycles; inert (no vents) where the theme has none. */
export class Geysers {
  readonly group = new THREE.Group();
  private list: Geyser[] = [];
  private rng = new Rng(9001);
  private time = 0;

  constructor(
    track: Track,
    private events: GeyserEvents,
  ) {
    if (!track.def.theme.geysers) return;
    const rng = this.rng;
    const p = new THREE.Vector3();
    const tg = new THREE.Vector3();
    const r = new THREE.Vector3();
    const ringGeo = new THREE.TorusGeometry(2.6, 0.7, 8, 20).rotateX(Math.PI / 2);
    const discGeo = new THREE.CircleGeometry(2.3, 20).rotateX(-Math.PI / 2);
    // Unit column (y 0..1); the shader stretches it to the current height.
    const columnGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 8, true).translate(0, 0.5, 0);
    const rock = new THREE.MeshStandardMaterial({ color: 0x221d18, roughness: 0.9 });
    for (let i = 0; i < GEYSERS; i++) {
      // Spread round the lap, clear of the grid and the first run to turn one.
      const u = 0.08 + ((i + rng.range(0.2, 0.8)) / GEYSERS) * 0.86;
      const lat = rng.range(-(TRACK_HALF_WIDTH - 10), TRACK_HALF_WIDTH - 10);
      track.frame(u, p, tg, r);
      const pos = new THREE.Vector3(p.x + r.x * lat, 0, p.z + r.z * lat);
      pos.y = groundHeight(track, pos.x, pos.z);
      const ring = new THREE.Mesh(ringGeo, rock);
      ring.position.set(pos.x, pos.y + 0.1, pos.z);
      ring.receiveShadow = true;
      const glow = new THREE.MeshBasicMaterial({ color: 0x000000 });
      const disc = new THREE.Mesh(discGeo, glow);
      disc.position.set(pos.x, pos.y + 0.25, pos.z);
      const uniforms = { uHeight: { value: 0 }, uPower: { value: 0 }, uTime: { value: 0 }, uSeed: { value: rng.range(0, 50) } };
      const flame = new THREE.Mesh(
        columnGeo,
        new THREE.ShaderMaterial({ uniforms, vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      );
      flame.position.copy(pos);
      flame.scale.set(COLUMN_RADIUS, 1, COLUMN_RADIUS);
      // The vertex shader moves the geometry: the static bounds would cull a tall column too early.
      flame.frustumCulled = false;
      flame.visible = false;
      this.group.add(ring, disc, flame);
      this.list.push({ pos, phase: 'idle', t: rng.range(2, 9), flame, uniforms, glow, burned: new Set() });
    }
  }

  get count(): number {
    return this.list.length;
  }

  update(dt: number, pods: readonly Pod[], world: PodWorld): void {
    this.time += dt;
    const time = this.time;
    for (const g of this.list) {
      g.t -= dt;
      if (g.t <= 0) {
        if (g.phase === 'idle') {
          g.phase = 'warn';
          g.t = WARN_TIME;
          this.events.warn(g.pos);
        } else if (g.phase === 'warn') {
          g.phase = 'erupt';
          g.t = ERUPT_TIME;
          g.burned.clear();
          this.events.erupt(g.pos);
        } else {
          g.phase = 'idle';
          g.t = this.rng.range(3.5, 8);
        }
      }
      let heat: number;
      let height = 0;
      let power = 0;
      if (g.phase === 'idle') heat = 0.12 + 0.05 * Math.sin(time * 3 + g.uniforms.uSeed.value);
      else if (g.phase === 'warn') {
        // Telegraph: the vent brightens and flickers faster, short flames lick out of it.
        const k = 1 - g.t / WARN_TIME;
        heat = (0.3 + 0.9 * k) * (0.75 + 0.25 * Math.sin(time * (12 + 30 * k)));
        height = 2 + 5 * k;
        power = 0.35 * k;
      } else {
        const rise = smoothstep(0, 0.3, ERUPT_TIME - g.t);
        const fall = smoothstep(0, 0.5, g.t);
        heat = 1.3;
        height = COLUMN_HEIGHT * rise * (0.6 + 0.4 * fall);
        power = rise * fall;
      }
      g.glow.color.setRGB(3 * heat, 1.2 * heat, 0.3 * heat);
      g.flame.visible = power > 0.01;
      g.uniforms.uHeight.value = height;
      g.uniforms.uPower.value = power;
      g.uniforms.uTime.value = time;
      if (g.phase !== 'erupt' || height < 6) continue;
      for (const pod of pods) {
        if (!pod.alive || pod.out) continue;
        const dx = g.pos.x - pod.pos.x;
        const dz = g.pos.z - pod.pos.z;
        if (dx * dx + dz * dz > BURN_RADIUS * BURN_RADIUS || pod.pos.y > g.pos.y + height) continue;
        pod.damageEngine(pod.sideOf(dx, dz), dt * BURN_WEAR, world);
        pod.heat = Math.min(1, pod.heat + dt * 0.6);
        if (!g.burned.has(pod)) {
          g.burned.add(pod);
          this.events.burn(pod);
        }
      }
    }
  }
}
