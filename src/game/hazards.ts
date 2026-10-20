// Tusken Raiders on the canyon rims, straight out of the film: a scope glint warns of the shot ~0.9 s
// ahead; a barrel roll or knife edge at the right moment makes them miss, otherwise an engine takes
// the slug. They target whoever is approaching in range, the player more often than not.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { groundHeight } from '../world/terrain';
import { CANYONS, type Track } from '../world/track';
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
      if (!CANYONS.some((c) => Math.hypot(p.x - c.x, p.z - c.z) < c.r * 0.72)) continue;
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
