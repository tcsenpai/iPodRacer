// Rival pilot: chases a point ahead on its racing line, reads the curvature ahead to brake in time,
// weaves around spires and slower pods, boosts on straights and (Sebulba style) leans on its neighbours.
// It writes the same PodControls a human produces, so rivals obey exactly the player's physics.
import * as THREE from 'three';
import { clamp } from '../core/rng';
import type { DifficultyProfile } from '../core/settings';
import type { Collider } from '../world/props';
import { TRACK_HALF_WIDTH, type Track } from '../world/track';
import { VMAX, turnRate, type Pod } from './pod';

/** Deceleration the pilot plans with (m/s^2): below what brakes + drag deliver, for a safety margin. */
const BRAKE_PLAN = 45;
/** Lateral limit of the racing lanes (m): the bed is ±34, keep the engines on it. */
const LANE_MAX = TRACK_HALF_WIDTH - 5;
const MAX_OBS = 8;
const OBS_LAT = new Float32Array(MAX_OBS);
const OBS_CLEAR = new Float32Array(MAX_OBS);
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _r = new THREE.Vector3();

export interface PilotTraits {
  /** Preferred lateral offset (m). */
  lane: number;
  /** Personal pace and aggression multipliers on top of the difficulty. */
  pace: number;
  aggression: number;
  /** Sebulba's dirty trick: a flame vent fired into whoever runs alongside. */
  flame?: boolean;
}

/** Highest speed at which a curve of radius r can be held: fixed point of v = turnRate(v) * r. */
function cornerSpeed(r: number): number {
  let v = VMAX;
  for (let i = 0; i < 6; i++) v = (v + turnRate(v) * r) / 2;
  return v;
}

export class Pilot {
  private boostHold = 0;
  private wander = Math.random() * 100;
  private rollWait = 3 + Math.random() * 6;
  private flameCooldown = 4;
  /** Seconds left on the current flame burst, and its victim (read by the race to apply it). */
  flameTime = 0;
  flameVictim: Pod | null = null;

  constructor(
    readonly pod: Pod,
    readonly traits: PilotTraits,
  ) {}

  /**
   * Fill pod.ctl. `playerProgress` drives the rubber band, for mild rubber banding. `assist` = the player's
   * autopilot after the finish line (no aggression, no rubber band).
   */
  drive(dt: number, track: Track, colliders: readonly Collider[], pods: readonly Pod[], diff: DifficultyProfile, playerProgress: number, assist = false): void {
    const pod = this.pod;
    const c = pod.ctl;
    if (!pod.alive) return;
    const v = pod.speed;
    this.wander += dt;
    const len = track.length;

    // Preferred lateral target: own lane plus a slow weave, passing slower pods, leaning on the player.
    let lane = this.traits.lane + Math.sin(this.wander * 0.23) * 6;
    let ram: Pod | null = null;
    for (const o of pods) {
      if (o === pod || !o.alive) continue;
      const ahead = (o.progress - pod.progress) * len;
      const side = o.lat - pod.lat;
      if (ahead > 4 && ahead < 45 && Math.abs(side) < 8 && o.speed < v) lane = o.lat + (side > 0 ? -10 : 10);
      // Ramming: the player alongside is fair game (rivals do not wreck each other).
      if (!assist && o.player && Math.abs(ahead) < 9 && Math.abs(side) < 16 && Math.abs(side) > 5) ram = o;
    }
    const aggression = diff.ramming * this.traits.aggression;
    if (ram && aggression > 0) lane = pod.lat + (ram.lat - pod.lat) * clamp(aggression, 0, 1);
    lane = clamp(lane, -LANE_MAX, LANE_MAX);

    // Rocks ahead trump everything: pick the lane closest to the preferred one that clears every
    // spire within reach (spires come in chicanes, so clearing one at a time steers into the next).
    const look = 60 + v * 1.6;
    let n = 0;
    let nearest = Infinity;
    for (const col of colliders) {
      if (n === MAX_OBS || Math.abs(col.lat) > TRACK_HALF_WIDTH + 20) continue;
      let du = (col.u - pod.u) * len;
      if (du < -len / 2) du += len;
      if (du > len / 2) du -= len;
      if (du < -4 || du > look) continue;
      OBS_LAT[n] = col.lat;
      OBS_CLEAR[n++] = col.r + 7;
      nearest = Math.min(nearest, Math.max(du, 0));
    }
    if (n > 0) {
      let best = lane;
      let bestCost = Infinity;
      for (let k = -1; k < n * 2; k++) {
        const cand = k < 0 ? lane : OBS_LAT[k >> 1] + (k & 1 ? OBS_CLEAR[k >> 1] + 1 : -OBS_CLEAR[k >> 1] - 1);
        if (Math.abs(cand) > LANE_MAX + 6) continue;
        let ok = true;
        for (let j = 0; j < n && ok; j++) ok = Math.abs(cand - OBS_LAT[j]) >= OBS_CLEAR[j];
        // Prefer staying near the current line: a big swerve costs more than a lane change.
        const cost = Math.abs(cand - lane) + Math.abs(cand - pod.lat) * 0.5;
        if (ok && cost < bestCost) {
          bestCost = cost;
          best = cand;
        }
      }
      lane = best;
    }

    // Steering toward a point ahead on the lane; closer when a rock is near, so the swerve happens in time.
    const aim = Math.max(20, Math.min(25 + v * 0.45, nearest * 0.6 + 12));
    track.frame(pod.u + aim / len, _p, _t, _r);
    _p.addScaledVector(_r, lane);
    const want = Math.atan2(_p.x - pod.pos.x, -(_p.z - pod.pos.z));
    let err = want - pod.heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    c.steer = clamp(err * 3.2 - pod.yawRate * 0.35, -1, 1);

    // Speed: the slowest corner within braking distance decides.
    const skill = assist ? 0.85 : diff.cornering;
    let limit = Infinity;
    const horizon = 80 + (v * v) / (2 * BRAKE_PLAN);
    for (let d = 0; d < horizon; d += 20) {
      const k = Math.abs(track.curvatureAt(pod.u + d / len));
      if (k < 1e-5) continue;
      const vc = cornerSpeed(1 / k) * skill;
      limit = Math.min(limit, Math.sqrt(vc * vc + 2 * BRAKE_PLAN * d));
    }
    // Rubber band: rivals far behind the player find a little extra.
    const gap = playerProgress - pod.progress;
    const band = assist ? 0 : clamp(gap * 6, 0, 1) * diff.catchUp;
    const cruise = VMAX * (assist ? 0.9 : diff.pace * this.traits.pace + band);
    const target = Math.min(limit, cruise);
    // Thrust balance: terminal speed scales with sqrt(throttle).
    c.throttle = v < target - 3 ? 1 : clamp((target / VMAX) ** 2, 0.2, 1);
    // Brake only for corners: above cruise pace (after a boost) just lift.
    c.brake = v > limit + 10 ? clamp((v - limit) / 30, 0, 1) : 0;

    // Boost on a long clear straight, until the engines get hot.
    if (!assist && this.boostHold <= 0 && limit > VMAX * 1.25 && pod.heat < 0.4 && Math.random() < diff.boost * dt) this.boostHold = 2 + Math.random() * 2;
    this.boostHold -= dt;
    // Repairs on the straights once an engine is badly hurt, never while boosting.
    c.repair = pod.damage > 0.45 && limit > VMAX * 1.05;
    c.boost = this.boostHold > 0 && pod.heat < 0.8 && limit > VMAX * 1.1 && c.brake === 0 && !c.repair;

    // Flame vent: only with ramming allowed (not on the amateur circuit), against the player alongside.
    this.flameCooldown -= dt;
    this.flameTime = Math.max(0, this.flameTime - dt);
    if (this.flameTime <= 0) this.flameVictim = null;
    if (this.traits.flame && !assist && ram && diff.ramming > 0 && this.flameCooldown <= 0) {
      this.flameTime = 1.1;
      this.flameVictim = ram;
      this.flameCooldown = 9 / diff.ramming;
    }

    // Showing off: an occasional barrel roll, more often when rubbing panels.
    this.rollWait -= dt * (ram ? 3 : 1);
    c.tilt = 0;
    this.pendingRoll = 0;
    if (this.rollWait <= 0 && !assist && v > 120) {
      this.rollWait = 6 + Math.random() * 10;
      this.pendingRoll = ram ? Math.sign(ram.lat - pod.lat) || 1 : Math.random() < 0.5 ? -1 : 1;
    }
  }

  /** Barrel roll requested by drive() this frame (0 = none); the race applies it with events. */
  pendingRoll = 0;
}
