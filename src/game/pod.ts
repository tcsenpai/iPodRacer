// One racer: the podracer model plus its flight state and physics. Player and rivals share this code;
// only the source of `ctl` differs (keyboard/gamepad vs the AI pilot).
//
// Physics is arcade-plausible: a heading with yaw-rate limited steering, thrust against quadratic drag,
// lateral grip that lets the pod slide, a sprung repulsor hover over the terrain with real airtime off
// dune crests, and circle colliders for rocks and other pods.
import * as THREE from 'three';
import type { PodControls } from '../core/input';
import { clamp, damp } from '../core/rng';
import { createPodracer, type PodLivery, type PodracerModel } from '../models/podracer';
import type { Collider } from '../world/props';
import { groundHeight } from '../world/terrain';
import { TRACK_HALF_WIDTH, type Track, type TrackHit } from '../world/track';

/** Top speed on full throttle (m/s, ~775 km/h) and with overdrive (~1025 km/h). */
export const VMAX = 215;
export const VBOOST = 285;
const THRUST = 55;
const DRAG = THRUST / (VMAX * VMAX);
const BOOST_THRUST = DRAG * VBOOST * VBOOST;
/** Extra drag on loose sand: terminal speed drops to ~65%. */
const SAND_DRAG = DRAG * 1.37;
const BRAKE_DECEL = 70;
const HOVER = 2.4;
const GRAVITY = 26;
/** Collision radius of the engine pair: half the span flat, a third of it on knife edge. */
const POD_RADIUS = 3;
/** Hard outer limit from the centreline (m): the corridor terrain mesh ends at 240. */
const OUTER_LIMIT = 150;
const ROLL_TIME = 0.75;
/** Wear repaired per second while the repair button is held, and the throttle cap meanwhile. */
const REPAIR_RATE = 0.16;
const REPAIR_THROTTLE = 0.55;

/** Yaw rate available at speed v (rad/s): agile when slow, committed when flat out. */
export function turnRate(v: number): number {
  return 2.2 - 1.35 * clamp(v / VMAX, 0, 1.3);
}

export interface PodSpec {
  name: string;
  /** Species and pod make, shown in the intro captions. */
  species: string;
  make: string;
  livery: PodLivery;
}

/** Things the race reacts to (sound, camera shake, particles, banners). */
export interface PodEvents {
  impact(pod: Pod, strength: number, at: THREE.Vector3): void;
  nearMiss(pod: Pod, knifeEdge: boolean): void;
  crash(pod: Pod): void;
  landed(pod: Pod, airtime: number): void;
  boost(pod: Pod): void;
  overheat(pod: Pod): void;
  roll(pod: Pod): void;
}

export interface PodWorld {
  track: Track;
  colliders: readonly Collider[];
  pods: readonly Pod[];
  events: PodEvents;
}

const _hit: TrackHit = { dist: 0, floorY: 0, u: 0 };
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class Pod {
  readonly model: PodracerModel;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** Yaw: forward is (sin h, 0, -cos h), so steering right increases it. */
  heading = 0;
  yawRate = 0;
  readonly ctl: PodControls = { steer: 0, throttle: 0, brake: 0, boost: false, tilt: 0, repair: false };
  /** Engines accept no thrust (countdown, finished cool-down). */
  locked = true;
  heat = 0;
  overheated = false;
  boosting = false;
  /** Wear per engine (0 = pristine, 1 = destroyed): index 0 left, 1 right. Either at 1 is a crash. */
  readonly wear: [number, number] = [0, 0];
  /** 1 - wear, for the model (kept as a field to avoid per-frame tuples). */
  readonly health: [number, number] = [1, 1];
  /** Repair droids at work this frame (throttle capped, boost off). */
  repairing = false;
  /** Multiplier on damage taken (difficulty for the player, toughness for rivals). */
  dmgScale = 1;
  alive = true;
  /** Out of the race for good (rivals after a second crash). */
  out = false;
  respawnIn = 0;
  /** Seconds of invulnerability after a respawn (blinks). */
  ghost = 0;
  crashes = 0;
  airborne = false;
  airtime = 0;
  offTrack = 0;
  /** Wall or rock contact this frame: drives the scrape sound and sparks. */
  scraping = false;
  /** Track state: arc parameter, signed lateral offset, and cumulative laps (negative on the grid). */
  u = 0;
  lat = 0;
  progress = 0;
  finishTime: number | null = null;
  lapTimes: number[] = [];
  lapStart = 0;
  wrongWay = 0;
  /** Barrel roll in progress: 0..1, direction ±1. */
  rollT = 1;
  rollDir = 1;
  rollCooldown = 0;
  tilt = 0;
  /** Smoothed visual bank and pitch. */
  bank = 0;
  pitch = 0;
  private sway = 0;
  private swayV = 0;
  private time = Math.random() * 10;
  /** Index of the collider last counted as a near miss, so one pass scores once. */
  private nearIdx = -1;
  private nearCooldown = 0;

  constructor(readonly spec: PodSpec, readonly player: boolean) {
    this.model = createPodracer(spec.livery);
  }

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  get rolling(): boolean {
    return this.rollT < 1;
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  /** Put the pod on the track at arc u, lateral offset lat, facing along it. */
  place(track: Track, u: number, lat: number, speed: number): void {
    track.frame(u, _p, _t, _r);
    this.pos.copy(_p).addScaledVector(_r, lat);
    this.pos.y = groundHeight(track, this.pos.x, this.pos.z) + HOVER;
    this.heading = Math.atan2(_t.x, -_t.z);
    this.vel.set(_t.x, 0, _t.z).normalize().multiplyScalar(speed);
    this.yawRate = 0;
    this.u = ((u % 1) + 1) % 1;
    this.lat = lat;
    this.airborne = false;
    this.bank = this.pitch = 0;
  }

  startRoll(dir: number, events: PodEvents): void {
    if (this.rolling || this.rollCooldown > 0 || !this.alive || this.airborne) return;
    this.rollT = 0;
    this.rollDir = dir;
    this.rollCooldown = ROLL_TIME + 0.5;
    // Sidestep: the roll throws the pod a lane across (right vector is (cos h, 0, sin h)).
    this.vel.x += Math.cos(this.heading) * dir * 34;
    this.vel.z += Math.sin(this.heading) * dir * 34;
    events.roll(this);
  }

  /** Physics step. */
  step(dt: number, w: PodWorld): void {
    this.time += dt;
    this.ghost = Math.max(0, this.ghost - dt);
    this.rollCooldown = Math.max(0, this.rollCooldown - dt);
    this.nearCooldown = Math.max(0, this.nearCooldown - dt);
    if (!this.alive) {
      this.respawnIn -= dt;
      return;
    }
    const c = this.ctl;
    const v = this.speed;

    // Engine heat: overdrive heats, cruising cools, an overheat stalls the boost until it recovers.
    const wantBoost = c.boost && !this.overheated && !this.locked && c.throttle > 0.1;
    if (wantBoost && !this.boosting) w.events.boost(this);
    this.boosting = wantBoost;
    if (this.boosting) this.heat += dt * 0.21;
    else this.heat -= dt * (this.overheated ? 0.22 : 0.11);
    if (this.heat >= 1 && !this.overheated) {
      this.overheated = true;
      this.boosting = false;
      w.events.overheat(this);
    }
    this.heat = clamp(this.heat, 0, 1);
    if (this.overheated && this.heat < 0.35) this.overheated = false;
    // Repair (Episode I Racer): the droid arms patch the worst engine while the pilot eases off.
    this.repairing = c.repair && !this.locked;
    if (this.repairing) {
      const i = this.wear[0] >= this.wear[1] ? 0 : 1;
      this.wear[i] = Math.max(0, this.wear[i] - dt * REPAIR_RATE);
      this.boosting = false;
    }

    // Longitudinal: thrust along the heading against drag; air brakes add drag.
    const fx = Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const throttle = this.repairing ? Math.min(c.throttle, REPAIR_THROTTLE) : c.throttle;
    let thrust = this.locked ? 0 : throttle * (this.boosting ? BOOST_THRUST : THRUST);
    // A hurt engine pushes less, and the pair pulls toward the weak side: the pilot must counter-steer.
    const tL = 1 - this.wear[0] * 0.55;
    const tR = 1 - this.wear[1] * 0.55;
    thrust *= ((tL + tR) / 2) * (this.overheated ? 0.75 : 1);
    if (this.airborne) thrust *= 0.4;
    const sand = this.offTrack;
    const drag = (DRAG + SAND_DRAG * sand) * v * v + c.brake * BRAKE_DECEL * clamp(v / 40, 0, 1);
    let vf = this.vel.x * fx + this.vel.z * fz;
    let vl = this.vel.x * -fz + this.vel.z * fx; // lateral (+ = right)
    vf += (thrust - drag * Math.sign(vf || 1)) * dt;
    if (this.locked && !this.airborne) vf *= Math.exp(-1.5 * dt);
    // Grip: the repulsors bite less on loose sand and in the air, so the pod slides through corners.
    const grip = this.airborne ? 0.4 : this.rolling ? 1.2 : 3.6 - 1.6 * sand;
    vl *= Math.exp(-grip * dt);

    // Steering: yaw rate eases toward the commanded rate; brakes and knife edge tighten it.
    this.tilt += (c.tilt - this.tilt) * damp(7, dt);
    const tight = 1 + c.brake * 0.55 + Math.abs(this.tilt) * 0.15;
    const pull = this.locked ? 0 : (tL - tR) * throttle * 0.55;
    const targetYaw = c.steer * turnRate(Math.abs(vf)) * tight * (this.airborne ? 0.35 : 1) + pull;
    this.yawRate += (targetYaw - this.yawRate) * damp(6, dt);
    this.heading += this.yawRate * dt;
    // Rotate velocity with the heading so speed is kept through the turn (minus the slide).
    const nfx = Math.sin(this.heading);
    const nfz = -Math.cos(this.heading);
    this.vel.x = nfx * vf - nfz * vl;
    this.vel.z = nfz * vf + nfx * vl;

    if (this.rolling) this.rollT = Math.min(1, this.rollT + dt / ROLL_TIME);

    // Integrate horizontal motion.
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // Track frame: progress, lateral offset, surface.
    w.track.nearest(this.pos.x, this.pos.z, _hit, 400);
    const prevU = this.u;
    this.u = _hit.u;
    let du = this.u - prevU;
    if (du > 0.5) du -= 1;
    if (du < -0.5) du += 1;
    this.progress += du;
    w.track.frame(this.u, _p, _t, _r);
    this.lat = (this.pos.x - _p.x) * _r.x + (this.pos.z - _p.z) * _r.z;
    this.offTrack = clamp((Math.abs(this.lat) - TRACK_HALF_WIDTH - 2) / 10, 0, 1);
    // Wrong way: facing against the track tangent while moving.
    if (fx * _t.x + fz * _t.z < -0.3 && v > 15) this.wrongWay += dt;
    else this.wrongWay = 0;

    this.scraping = false;
    // Outer boundary: a soft invisible fence far out in the dunes, bouncing back toward the course.
    if (Math.abs(this.lat) > OUTER_LIMIT) {
      const s = Math.sign(this.lat);
      this.pos.x -= _r.x * (Math.abs(this.lat) - OUTER_LIMIT) * s;
      this.pos.z -= _r.z * (Math.abs(this.lat) - OUTER_LIMIT) * s;
      const vn = (this.vel.x * _r.x + this.vel.z * _r.z) * s;
      if (vn > 0) {
        this.vel.x -= _r.x * s * vn * 1.4;
        this.vel.z -= _r.z * s * vn * 1.4;
      }
      this.scraping = true;
    }

    // Hover: spring toward the ride height; above it the pod flies ballistic (airtime off crests).
    const g = groundHeight(w.track, this.pos.x, this.pos.z);
    // Canyon walls and steep dune faces: if the ground rose more than the pod can climb this step,
    // treat it as a wall and bounce off along the slope's horizontal gradient.
    const rise = g + 0.8 - this.pos.y;
    if (rise > 3.5 && !this.airborne) {
      const gx = groundHeight(w.track, this.pos.x + 1, this.pos.z) - g;
      const gz = groundHeight(w.track, this.pos.x, this.pos.z + 1) - g;
      const gl = Math.hypot(gx, gz) || 1;
      const nx = -gx / gl;
      const nz = -gz / gl;
      const vn = this.vel.x * nx + this.vel.z * nz;
      this.pos.x -= this.vel.x * dt;
      this.pos.z -= this.vel.z * dt;
      if (vn < 0) {
        this.vel.x -= nx * vn * 1.5;
        this.vel.z -= nz * vn * 1.5;
        this.hit(-vn, w, this.sideOf(-nx, -nz));
      }
      this.vel.multiplyScalar(0.97);
      this.scraping = true;
    }
    const ground = groundHeight(w.track, this.pos.x, this.pos.z);
    const target = ground + HOVER;
    if (this.pos.y > target + 0.6) {
      if (!this.airborne && this.vel.y > 4) this.airtime = 0;
      this.airborne = this.vel.y > -50 && this.pos.y > target + 0.6;
      this.vel.y -= GRAVITY * dt;
    } else {
      if (this.airborne) {
        if (this.airtime > 0.3) w.events.landed(this, this.airtime);
        if (this.vel.y < -18) this.hit(-this.vel.y * 0.35, w, -1);
      }
      this.airborne = false;
      this.vel.y += (70 * (target - this.pos.y) - 11 * this.vel.y) * dt;
    }
    this.airtime = this.airborne ? this.airtime + dt : 0;
    this.pos.y += this.vel.y * dt;
    if (this.pos.y < ground + 0.9) {
      this.pos.y = ground + 0.9;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    // Rocks: circle colliders, only near the ground (hoodoos are tall, arches have legs only).
    const rad = POD_RADIUS * (1 - Math.abs(this.tilt) * 0.65);
    const span = 900 / w.track.length;
    for (let i = 0; i < w.colliders.length; i++) {
      const col = w.colliders[i];
      let cu = col.u - this.u;
      if (cu > 0.5) cu -= 1;
      if (cu < -0.5) cu += 1;
      if (Math.abs(cu) > span && Math.abs(col.lat) < 260) continue;
      const dx = this.pos.x - col.x;
      const dz = this.pos.z - col.z;
      const d = Math.hypot(dx, dz);
      const min = col.r + rad;
      if (d < min && d > 0.001) {
        const nx = dx / d;
        const nz = dz / d;
        this.pos.x += nx * (min - d);
        this.pos.z += nz * (min - d);
        const vn = this.vel.x * nx + this.vel.z * nz;
        if (vn < 0) {
          this.vel.x -= nx * vn * 1.35;
          this.vel.z -= nz * vn * 1.35;
          this.hit(-vn, w, this.sideOf(-nx, -nz));
        }
        this.vel.multiplyScalar(0.95);
        this.scraping = true;
      } else if (d < min + 5 && v > 110 && this.nearIdx !== i && this.nearCooldown <= 0 && this.alive) {
        this.nearIdx = i;
        this.nearCooldown = 0.6;
        this.heat = Math.max(0, this.heat - (Math.abs(this.tilt) > 0.6 ? 0.3 : 0.15));
        w.events.nearMiss(this, Math.abs(this.tilt) > 0.6);
      }
    }

    // Other pods: shove apart; a barrel roll shoulders through anyone in the way.
    for (const o of w.pods) {
      if (o === this || !o.alive || o.ghost > 0 || this.ghost > 0) continue;
      const dx = this.pos.x - o.pos.x;
      const dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      const min = POD_RADIUS * 2;
      if (d2 > min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      const push = (min - d) * 0.5;
      this.pos.x += nx * push;
      this.pos.z += nz * push;
      o.pos.x -= nx * push;
      o.pos.z -= nz * push;
      const rv = (this.vel.x - o.vel.x) * nx + (this.vel.z - o.vel.z) * nz;
      if (rv < 0) {
        // The rolling pod deals the blow and barely feels it.
        const mine = this.rolling ? 0.2 : o.rolling ? 1.8 : 1;
        const theirs = 2 - mine;
        this.vel.x -= nx * rv * 0.6 * mine;
        this.vel.z -= nz * rv * 0.6 * mine;
        o.vel.x += nx * rv * 0.6 * theirs;
        o.vel.z += nz * rv * 0.6 * theirs;
        this.hit(-rv * 0.5 * mine, w, this.sideOf(-nx, -nz));
        o.hit(-rv * 0.5 * theirs, w, o.sideOf(nx, nz));
      }
    }
  }

  /** Overall damage: the worse engine (HUD, smoke, screen tint). */
  get damage(): number {
    return Math.max(this.wear[0], this.wear[1]);
  }

  /** Which engine faces horizontal world direction (dx, dz): 0 left, 1 right. */
  sideOf(dx: number, dz: number): 0 | 1 {
    return dx * Math.cos(this.heading) + dz * Math.sin(this.heading) > 0 ? 1 : 0;
  }

  /**
   * Collision of normal speed `vn` (m/s) on engine `side` (-1 = both, e.g. a hard landing). Light taps
   * are free; hard hits add up to a crash.
   */
  hit(vn: number, w: PodWorld, side: -1 | 0 | 1): void {
    if (vn < 6 || this.ghost > 0 || !this.alive) return;
    const strength = clamp(vn / 90, 0, 1);
    const amount = strength * strength * 0.9;
    _v.copy(this.pos);
    w.events.impact(this, strength, _v);
    if (side === -1) {
      this.damageEngine(0, amount * 0.6, w);
      this.damageEngine(1, amount * 0.6, w);
    } else {
      this.damageEngine(side, amount, w);
      this.damageEngine(side === 0 ? 1 : 0, amount * 0.25, w);
    }
  }

  /** Wear one engine (shots, flames, collisions); a destroyed engine takes the pod with it. */
  damageEngine(side: 0 | 1, amount: number, w: PodWorld): void {
    if (this.ghost > 0 || !this.alive) return;
    this.wear[side] = Math.min(1, this.wear[side] + amount * this.dmgScale);
    if (this.wear[side] >= 1) {
      this.alive = false;
      this.crashes++;
      this.respawnIn = 2.6;
      this.boosting = false;
      w.events.crash(this);
      // The wreck stays where it blew up until the respawn.
      this.vel.set(0, 0, 0);
    }
  }

  /** Back on the centreline after a crash, a little behind where it happened. */
  respawn(track: Track): void {
    this.alive = true;
    this.wear[0] = this.wear[1] = 0;
    this.heat = 0;
    this.overheated = false;
    this.ghost = 2.5;
    this.rollT = 1;
    const back = 30 / track.length;
    this.progress -= back;
    this.place(track, this.u - back, 0, 70);
    this.vel.y = 0;
  }

  /** Pose the model from the physics state: bank, pitch, roll maneuver, engine bob, cockpit swing. */
  syncModel(dt: number): void {
    const m = this.model;
    m.root.visible = this.alive && (this.ghost <= 0 || Math.floor(this.ghost * 12) % 2 === 0);
    if (!this.alive) return;
    const v = this.speed;
    const lateralG = this.yawRate * v; // centripetal acceleration (m/s^2)
    const bankTarget = clamp(lateralG / 120, -0.9, 0.9) + this.tilt * (Math.PI / 2 - 0.9 * Math.abs(clamp(lateralG / 120, -0.9, 0.9)));
    this.bank += (bankTarget - this.bank) * damp(5, dt);
    const pitchTarget = clamp(Math.atan2(this.vel.y, Math.max(v, 1)), -0.5, 0.5) + this.ctl.brake * 0.12;
    this.pitch += (pitchTarget - this.pitch) * damp(6, dt);
    // Barrel roll: eased full turn on top of the bank.
    const rt = this.rollT;
    const roll = this.rolling ? this.rollDir * Math.PI * 2 * (rt * rt * (3 - 2 * rt)) : 0;
    m.root.position.copy(this.pos);
    _e.set(this.pitch, -this.heading, -(this.bank + roll));
    m.root.quaternion.setFromEuler(_e);
    // Engines ride independently; the cockpit swings out on its cables against the turn.
    // A hurt engine shakes and wobbles on its own.
    m.engineL.position.y = Math.sin(this.time * 9) * 0.06 * (1 + this.wear[0] * 4);
    m.engineR.position.y = Math.sin(this.time * 9 + 1.3) * 0.06 * (1 + this.wear[1] * 4);
    m.engineL.rotation.z = Math.sin(this.time * 23) * 0.01 * (1 + this.wear[0] * 8);
    m.engineR.rotation.z = Math.sin(this.time * 21 + 2) * 0.01 * (1 + this.wear[1] * 8);
    const swayTarget = clamp(-lateralG / 40, -3, 3);
    this.swayV += ((swayTarget - this.sway) * 30 - this.swayV * 5) * dt;
    this.sway += this.swayV * dt;
    m.cockpit.position.x = this.sway;
    m.cockpit.rotation.z = -this.sway * 0.25;
    m.cockpit.rotation.y = this.sway * 0.04;
    this.health[0] = 1 - this.wear[0];
    this.health[1] = 1 - this.wear[1];
    m.update(dt, this.locked ? 0.25 : this.repairing ? Math.min(this.ctl.throttle, REPAIR_THROTTLE) : this.ctl.throttle, this.boosting ? 1 : 0, this.health);
  }

  /** World quaternion of the pod without the roll maneuver (cameras use it so they do not spin). */
  stableQuaternion(out: THREE.Quaternion): THREE.Quaternion {
    _e.set(this.pitch * 0.5, -this.heading, -this.bank * 0.35);
    return out.setFromEuler(_e);
  }
}
