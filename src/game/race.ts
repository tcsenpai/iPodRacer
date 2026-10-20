// The Boonta Eve race: grid, cinematic intro, countdown, three laps against five rivals, finish.
// Owns the pods and their pilots; turns physics events into sound, particles, camera and HUD moments.
import * as THREE from 'three';
import type { Announcer } from '../audio/announcer';
import type { GameAudio, EngineVoice } from '../audio/audio';
import type { Engine } from '../core/engine';
import type { Input } from '../core/input';
import { DIFFICULTY, type Difficulty } from '../core/settings';
import { t } from '../i18n/i18n';
import type { PodLivery } from '../models/podracer';
import { ANAKIN_LIVERY } from '../models/podracer';
import type { Hud, HudPod, HudState } from '../ui/hud';
import type { ResultRow } from '../ui/menus';
import type { DustTrail } from '../world/dust';
import type { Collider } from '../world/props';
import { groundHeight } from '../world/terrain';
import type { Track } from '../world/track';
import { Pilot, type PilotTraits } from './ai';
import { Snipers, type SniperEvents } from './hazards';
import type { CameraRig } from './camera';
import type { Fx } from './fx';
import { Pod, type PodEvents, type PodSpec, type PodWorld } from './pod';

export const LAPS = 3;
/** Rivals are a little tougher than the player and drop out on their third wreck. */
const RIVAL_DAMAGE = 0.7;
const RIVAL_LIVES = 3;
const GRID_ROW = 34; // m between grid rows
const COUNTDOWN = 3.6; // s from the end of the intro to GO
/** Shots of the intro: duration (s) and who to show. -1 = the grid crane. */
const INTRO: { dur: number; who: number }[] = [
  { dur: 3.4, who: -1 },
  { dur: 2.4, who: 1 },
  { dur: 2.2, who: 2 },
  { dur: 2.6, who: 0 },
];

const livery = (skin: string, band: string, trim: string, cockpit: string, engineScale = 1): PodLivery => ({ skin, band, trim, cockpit, engineScale });

/** Index 0 is the player. Grid order: index 1 (Sebulba) on pole. */
const ROSTER: { spec: PodSpec; traits: PilotTraits }[] = [
  { spec: { name: 'Anakin Skywalker', species: 'Human', make: 'Radon-Ulzer 620C', livery: ANAKIN_LIVERY }, traits: { lane: 0, pace: 1, aggression: 0 } },
  { spec: { name: 'Sebulba', species: 'Dug', make: 'Collor Pondrat Plug-F Mammoth', livery: livery('#ffb070', '#7a2e10', '#2a2a2a', '#c4601c', 1.22) }, traits: { lane: -6, pace: 1.03, aggression: 1.6, flame: true } },
  { spec: { name: 'Gasgano', species: 'Xexto', make: 'Ord Pedrovia', livery: livery('#c8d8b0', '#2a6e3a', '#d8c060', '#3c7a46') }, traits: { lane: 10, pace: 1.0, aggression: 0.3 } },
  { spec: { name: 'Mawhonic', species: 'Gran', make: 'GPE-3130', livery: livery('#f2f6ff', '#2aa198', '#f0f0f0', '#2a8a80', 0.9) }, traits: { lane: -14, pace: 0.98, aggression: 0.2 } },
  { spec: { name: 'Ody Mandrell', species: "Er'Kit", make: 'Exelbrok XL 5115', livery: livery('#d8d0c8', '#b02020', '#f0e0c0', '#8a1a1a', 1.08) }, traits: { lane: 4, pace: 0.97, aggression: 0.6 } },
  { spec: { name: 'Aldar Beedo', species: 'Glymphid', make: 'Manta RamAir Mark II', livery: livery('#b8c890', '#3a5a2a', '#c09040', '#5a7a3a', 0.95) }, traits: { lane: -2, pace: 0.96, aggression: 0.8 } },
];
/** Grid slot per roster index (0 = pole). The player starts fifth, like Anakin. */
const GRID_SLOT = [4, 0, 1, 2, 3, 5];

export type Phase = 'intro' | 'countdown' | 'racing' | 'finished';

export interface RaceDeps {
  scene: THREE.Object3D;
  engine: Engine;
  track: Track;
  colliders: readonly Collider[];
  hud: Hud;
  audio: GameAudio;
  fx: Fx;
  dust: DustTrail;
  rig: CameraRig;
  announcer: Announcer;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Race {
  readonly pods: Pod[];
  readonly player: Pod;
  readonly difficulty: Difficulty;
  phase: Phase = 'intro';
  /** Race clock (s since GO). */
  time = 0;
  /** Time-scale wanted by the race (slow motion moments); main applies it. */
  timeScale = 1;
  /** Seconds since the player crossed the line (results show after a cool-down). */
  finishedFor = 0;
  /** Dev/headless: the AI flies the player's pod (galactic skill). */
  autoplay = false;
  private phaseT = 0;
  private shot = -1;
  private slowmo = 0;
  private slowFactor = 1;
  private pilots: Pilot[] = [];
  private autopilot: Pilot;
  private world: PodWorld;
  private order: Pod[];
  private position = 0;
  private lastBeep = 99;
  private resetCooldown = 0;
  private throttleWas = 0;
  private perfectWindow = false;
  private wrongShown = false;
  private hudPods: HudPod[];
  private hudState: HudState;
  private snipers: Snipers;
  /** The engine-hit repair hint shows once per race. */
  private hintShown = false;
  private repairedFrom = 0;
  /** Commentary state: current leader and the highest lap any pod has completed. */
  private leader: Pod | null = null;
  private leaderLap = 0;
  private sniperCalled = false;
  /** Centre of the grandstands (start/finish line), for the crowd roar. */
  private readonly stands = new THREE.Vector3();
  /** Rival engine voices, index i mirrors pods[i + 1]. */
  private voices: EngineVoice[];

  constructor(
    private d: RaceDeps,
    difficulty: Difficulty,
  ) {
    this.difficulty = difficulty;
    this.pods = ROSTER.map((r, i) => new Pod(r.spec, i === 0));
    this.player = this.pods[0];
    for (const pod of this.pods) pod.dmgScale = pod.player ? DIFFICULTY[difficulty].damage : RIVAL_DAMAGE;
    for (let i = 1; i < this.pods.length; i++) this.pilots.push(new Pilot(this.pods[i], ROSTER[i].traits));
    this.autopilot = new Pilot(this.player, ROSTER[0].traits);
    this.order = this.pods.slice();
    const events = this.events();
    this.world = { track: d.track, colliders: d.colliders, pods: this.pods, events };

    // Grid: two staggered columns behind the line.
    this.pods.forEach((pod, i) => {
      const slot = GRID_SLOT[i];
      const back = 25 + Math.floor(slot / 2) * GRID_ROW + (slot % 2) * 12;
      const u = -back / d.track.length;
      pod.place(d.track, u, slot % 2 ? 11 : -11, 0);
      pod.progress = u;
      d.scene.add(pod.model.root);
      pod.syncModel(0);
    });
    this.hudPods = this.pods.map((p) => ({ x: p.pos.x, z: p.pos.z, player: p.player, alive: true }));
    this.hudState = {
      lap: 1,
      laps: LAPS,
      position: this.pods.length,
      racers: this.pods.length,
      speed: 0,
      heat: 0,
      overheated: false,
      cooldown: 0,
      engines: this.player.wear,
      repairing: false,
      raceTime: 0,
      lapTime: 0,
      lapTimes: this.player.lapTimes,
      bestLap: null,
      wrongWay: false,
      pods: this.hudPods,
    };
    this.voices = this.pods.slice(1).map((p) => ({ pos: p.pos, vel: p.vel, throttle: 0, boost: false, alive: true }));
    d.hud.setVisible(false);
    d.hud.letterbox(true);
    d.audio.setRacing(true);
    d.audio.music('race');
    this.snipers = new Snipers(d.track, this.sniperEvents());
    d.track.frame(0, this.stands, _a, _b);
    d.scene.add(this.snipers.group);
    this.nextShot();
  }

  dispose(): void {
    for (const p of this.pods) this.d.scene.remove(p.model.root);
    this.d.scene.remove(this.snipers.group);
    this.d.hud.caption('', '');
    this.d.hud.letterbox(false);
    this.d.audio.setRacing(false);
    this.d.announcer.stop();
  }

  private sniperEvents(): SniperEvents {
    const d = this.d;
    return {
      glint: (target) => {
        if (!target.player) return;
        d.audio.sniperGlint();
        d.hud.banner(t('race.sniper'), 'warn', 0.9);
      },
      shot: (from, target, hit, dodged) => {
        d.audio.gunshot(from.distanceTo(d.rig.camera.position));
        if (hit) {
          _b.copy(target.vel).multiplyScalar(0.3);
          d.fx.burst('spark', target.pos, _b, 40, 25);
          d.fx.burst('smoke', target.pos, _b, 6, 6);
        }
        if (!target.player) return;
        if (hit) {
          d.audio.impact(0.7);
          d.rig.shake(0.7);
          d.engine.flash = Math.max(d.engine.flash, 0.2);
          if (!this.hintShown) {
            this.hintShown = true;
            d.hud.banner(t('race.enginehit'), 'warn', 2.5);
          }
          if (!this.sniperCalled) {
            this.sniperCalled = true;
            d.announcer.say('ann.sniper', undefined, true);
          }
        } else if (dodged) {
          d.hud.trick(t('race.dodge'));
          this.player.heat = Math.max(0, this.player.heat - 0.2);
        }
      },
    };
  }

  private events(): PodEvents {
    const d = this.d;
    const nearCam = (p: Pod) => p.pos.distanceTo(d.rig.camera.position);
    return {
      impact: (pod, s, at) => {
        _b.copy(pod.vel).multiplyScalar(0.3);
        d.fx.burst('spark', at, _b, Math.round(10 + s * 50), 18 + s * 30);
        if (pod.player) {
          d.audio.impact(s);
          d.rig.shake(0.3 + s * 0.9);
          d.engine.flash = Math.max(d.engine.flash, s * 0.25);
        } else if (nearCam(pod) < 90) d.audio.impact(s * 0.5);
      },
      nearMiss: (pod, knife) => {
        if (!pod.player) return;
        d.hud.trick(t(knife ? 'race.knife' : 'race.nearmiss'));
        d.audio.nearMiss();
        d.rig.shake(0.2);
        if (knife) this.slow(0.6, 0.45);
      },
      crash: (pod) => {
        d.fx.explosion(pod.pos, pod.vel);
        d.audio.explosion(nearCam(pod));
        if (pod.player) {
          d.hud.banner(t('race.crash'), 'warn');
          d.rig.setShot({ kind: 'crash', pod });
          d.rig.shake(1.2);
          d.engine.flash = 0.4;
          this.slow(1.2, 0.35);
          d.announcer.say('ann.crash', { name: pod.spec.name }, true);
        } else {
          if (pod.crashes >= RIVAL_LIVES) {
            pod.out = true;
            d.hud.banner(t('race.rivalout', { name: pod.spec.name }), 'info');
            d.announcer.say('ann.out', { name: pod.spec.name }, true);
          } else d.announcer.say('ann.crash', { name: pod.spec.name });
          if (nearCam(pod) < 350) {
            this.slow(0.9, 0.35);
            d.rig.shake(0.5);
          }
        }
      },
      landed: (pod, air) => {
        _a.copy(pod.pos);
        _a.y -= 2;
        _b.set(0, 4, 0);
        d.fx.burst('smoke', _a, _b, Math.round(air * 10), 10);
        if (!pod.player) return;
        d.rig.shake(Math.min(0.25 + air * 0.35, 0.9));
        if (air > 0.8) d.hud.trick(t('race.air', { s: air.toFixed(1) }));
      },
      boost: (pod) => {
        if (!pod.player) return;
        d.audio.boost();
        d.rig.kick(9);
        d.rig.shake(0.3);
      },
      overheat: (pod) => {
        if (!pod.player) return;
        d.audio.overheat();
        d.hud.banner(t('race.overheat'), 'warn');
      },
      roll: (pod) => {
        if (pod.player) {
          d.audio.roll();
          d.hud.trick(t('race.roll'));
        }
      },
    };
  }

  /** Slow motion for `seconds` (real time) at `factor`. */
  private slow(seconds: number, factor: number): void {
    this.slowmo = Math.max(this.slowmo, seconds);
    this.slowFactor = Math.min(this.slowmo > 0 ? this.slowFactor : 1, factor);
  }

  /** Skip the intro straight to the countdown. */
  skipIntro(): void {
    if (this.phase === 'intro') this.startCountdown();
  }

  private nextShot(): void {
    this.shot++;
    this.phaseT = 0;
    if (this.shot >= INTRO.length) return this.startCountdown();
    const s = INTRO[this.shot];
    const { hud, rig, track } = this.d;
    if (s.who < 0) {
      const p = new THREE.Vector3();
      const tg = new THREE.Vector3();
      const r = new THREE.Vector3();
      track.frame(-60 / track.length, p, tg, r);
      p.y = groundHeight(track, p.x, p.z) + 2;
      rig.setShot({ kind: 'crane', at: p, heading: Math.atan2(tg.x, -tg.z) });
      hud.caption(t('race.intro.title'), t('race.intro.sub'));
      this.d.announcer.say('ann.intro', undefined, true);
    } else {
      const pod = this.pods[s.who];
      rig.setShot({ kind: s.who === 0 ? 'low' : 'orbit', pod });
      hud.caption(pod.spec.name, t('rival.sub', { species: pod.spec.species, pod: pod.spec.make }));
    }
  }

  private startCountdown(): void {
    this.phase = 'countdown';
    this.phaseT = 0;
    this.d.hud.caption('', '');
    this.d.hud.letterbox(false);
    this.d.hud.setVisible(true);
    this.d.rig.setShot({ kind: 'race' });
  }

  /** Advance by `dt` (game time, already slowed) with `real` the unscaled frame time. */
  update(dt: number, real: number, input: Input): void {
    const d = this.d;
    this.phaseT += real;
    this.slowmo = Math.max(0, this.slowmo - real);
    if (this.slowmo <= 0) this.slowFactor = 1;
    this.timeScale = this.slowFactor;
    const diff = DIFFICULTY[this.difficulty];
    const p = this.player;

    // Player controls (the autopilot takes over after the finish line).
    const ctl = input.read(real);
    if (this.phase === 'finished') {
      this.autopilot.drive(dt, d.track, d.colliders, this.pods, diff, p.progress, true);
    } else if (this.autoplay) {
      if (!p.locked) this.autopilot.drive(dt, d.track, d.colliders, this.pods, DIFFICULTY.galactic, p.progress);
      if (this.autopilot.pendingRoll) p.startRoll(this.autopilot.pendingRoll, this.world.events);
    } else {
      Object.assign(p.ctl, ctl);
      if (input.consume('rollLeft')) p.startRoll(-1, this.world.events);
      if (input.consume('rollRight')) p.startRoll(1, this.world.events);
    }
    if (input.consume('camera')) d.rig.mode = d.rig.mode === 'chase' ? 'far' : d.rig.mode === 'far' ? 'cockpit' : 'chase';
    this.resetCooldown -= real;
    if (input.consume('reset') && this.phase === 'racing' && p.alive && this.resetCooldown <= 0) {
      this.resetCooldown = 3;
      p.place(d.track, p.u, 0, 50);
      p.ghost = 1.5;
    }

    if (this.phase === 'intro') {
      if (this.phaseT > INTRO[this.shot].dur) this.nextShot();
      if (input.consume('confirm')) this.skipIntro();
    } else if (this.phase === 'countdown') {
      const left = COUNTDOWN - this.phaseT;
      const n = Math.ceil(left);
      if (n !== this.lastBeep && n <= 3 && n >= 1) {
        this.lastBeep = n;
        d.hud.banner(String(n), 'countdown');
        d.audio.countdown(n);
      }
      // Perfect start: hit the throttle in the last moment before the lights go (or just after).
      if (ctl.throttle > 0.5 && this.throttleWas <= 0.5) this.perfectWindow = left < 0.35;
      if (left <= 0) this.go();
    } else if (this.phase === 'racing' && this.time < 0.15 && ctl.throttle > 0.5 && this.throttleWas <= 0.5) {
      this.perfectStart();
    }
    this.throttleWas = ctl.throttle;

    if (this.phase === 'racing' || this.phase === 'finished') this.time += dt;

    // AI, and Sebulba's flame vent on whoever he catches alongside.
    for (const pilot of this.pilots) {
      if (pilot.pod.locked || pilot.pod.out) continue;
      const wasFlaming = pilot.flameTime > 0;
      pilot.drive(dt, d.track, d.colliders, this.pods, diff, p.progress);
      if (pilot.pendingRoll) pilot.pod.startRoll(pilot.pendingRoll, this.world.events);
      const victim = pilot.flameVictim;
      if (victim && pilot.flameTime > 0 && pilot.pod.alive) {
        const src = pilot.pod;
        const side = src.sideOf(victim.pos.x - src.pos.x, victim.pos.z - src.pos.z);
        (side ? src.model.engineR : src.model.engineL).getWorldPosition(_a);
        _b.subVectors(victim.pos, _a).multiplyScalar(2.5).add(src.vel);
        d.fx.burst('fire', _a, _b, 3, 4);
        if (victim.pos.distanceTo(src.pos) < 18) {
          victim.damageEngine(victim.sideOf(src.pos.x - victim.pos.x, src.pos.z - victim.pos.z), dt * 0.22, this.world);
          victim.heat = Math.min(1, victim.heat + dt * 0.25);
        }
        if (!wasFlaming) {
          if (victim.player || src.pos.distanceTo(d.rig.camera.position) < 120) d.audio.flame();
          if (victim.player) {
            d.hud.banner(t('race.flame'), 'warn', 1.2);
            d.announcer.say('ann.flame');
            d.rig.shake(0.5);
          }
        }
      }
    }
    if (this.phase === 'racing') this.snipers.update(dt, this.pods, this.world, diff.sniper, d.rig.camera);

    // Physics, laps, respawns.
    for (const pod of this.pods) {
      if (pod.out) {
        pod.model.root.visible = false;
        continue;
      }
      pod.step(dt, this.world);
      if (!pod.alive && pod.respawnIn <= 0 && !pod.out) {
        pod.respawn(d.track);
        if (pod.player) {
          d.rig.setShot(this.phase === 'finished' ? { kind: 'finish', pod } : { kind: 'race' });
          d.hud.banner(t('race.respawn'), 'info');
        }
      }
      this.laps(pod);
      pod.syncModel(dt);
    }
    this.rank();
    this.effects(dt);

    // Finish cool-down: let the camera circle the pod before the results.
    if (this.phase === 'finished') this.finishedFor += real;

    // HUD.
    const h = this.hudState;
    h.lap = Math.min(LAPS, Math.max(1, Math.floor(p.progress) + 1));
    h.position = this.position;
    h.speed = p.speed;
    h.heat = p.heat;
    h.overheated = p.overheated;
    h.cooldown = p.boostCooldown / p.boostCooldownMax;
    h.repairing = p.repairing;
    // A full repair after real damage earns a callout.
    if (p.repairing) this.repairedFrom = Math.max(this.repairedFrom, p.damage);
    else this.repairedFrom = 0;
    if (p.repairing && p.damage === 0 && this.repairedFrom > 0.2) {
      this.repairedFrom = 0;
      d.hud.trick(t('race.repaired'));
    }
    h.raceTime = p.finishTime ?? this.time;
    h.lapTime = this.phase === 'racing' ? this.time - p.lapStart : 0;
    h.bestLap = p.lapTimes.length ? Math.min(...p.lapTimes) : null;
    const wrong = p.wrongWay > 1.2 && this.phase === 'racing';
    h.wrongWay = wrong;
    if (wrong && !this.wrongShown) d.audio.overheat();
    this.wrongShown = wrong;
    for (let i = 0; i < this.pods.length; i++) {
      this.hudPods[i].x = this.pods[i].pos.x;
      this.hudPods[i].z = this.pods[i].pos.z;
      this.hudPods[i].alive = this.pods[i].alive && !this.pods[i].out;
    }
    d.hud.update(h);
    d.hud.speedFx(Math.min(1, p.speed / 260));
  }

  private go(): void {
    const d = this.d;
    this.phase = 'racing';
    this.time = 0;
    for (const pod of this.pods) {
      pod.locked = false;
      pod.lapStart = 0;
    }
    d.hud.banner(t('race.go'), 'go');
    d.audio.countdown(0);
    d.announcer.say('ann.go', undefined, true);
    d.rig.shake(0.4);
    if (this.perfectWindow) this.perfectStart();
  }

  private perfectStart(): void {
    const d = this.d;
    this.player.forward(_a);
    this.player.vel.addScaledVector(_a, 55);
    d.hud.trick(t('race.perfect'));
    d.audio.boost();
    d.rig.kick(10);
    d.rig.shake(0.4);
  }

  private laps(pod: Pod): void {
    if (this.phase !== 'racing' && this.phase !== 'finished') return;
    if (pod.finishTime !== null) return;
    const lap = Math.floor(pod.progress);
    if (lap <= pod.lapTimes.length || lap < 1) return;
    pod.lapTimes.push(this.time - pod.lapStart);
    pod.lapStart = this.time;
    if (lap >= LAPS) {
      pod.finishTime = this.time;
      if (pod.player) this.finish();
      return;
    }
    // The first pod through the line calls the lap for the commentators.
    if (lap > this.leaderLap) {
      this.leaderLap = lap;
      const final = lap === LAPS - 1;
      this.d.announcer.say(final ? 'ann.final' : 'ann.lap', { name: pod.spec.name, n: lap }, final);
    }
    if (pod.player) {
      const final = lap === LAPS - 1;
      this.d.hud.banner(final ? t('race.final') : t('race.lap', { n: lap + 1 }), final ? 'final' : 'lap');
      this.d.audio.lap(final);
    }
  }

  private finish(): void {
    const d = this.d;
    this.phase = 'finished';
    this.finishedFor = 0;
    this.rank();
    d.hud.banner(`${t('race.finish')} · ${t('race.position', { pos: this.position })}`, 'final', 4);
    d.audio.finish(this.position === 1);
    if (this.position === 1) d.announcer.say('ann.win', { name: this.player.spec.name }, true);
    else d.announcer.say('ann.finish', { name: this.player.spec.name, pos: this.position }, true);
    d.hud.letterbox(true);
    d.rig.setShot({ kind: 'finish', pod: this.player });
    this.slow(2.4, 0.3);
  }

  private rank(): void {
    this.order.sort((a, b) => {
      if (a.out !== b.out) return a.out ? 1 : -1;
      if (a.finishTime !== null || b.finishTime !== null) {
        if (a.finishTime === null) return 1;
        if (b.finishTime === null) return -1;
        return a.finishTime - b.finishTime;
      }
      return b.progress - a.progress;
    });
    const pos = this.order.indexOf(this.player) + 1;
    if (this.position && pos < this.position && this.phase === 'racing') this.d.hud.trick(`${t('race.overtake')} ${t('race.position', { pos })}`);
    this.position = pos;
    const leader = this.order[0];
    if (this.phase === 'racing' && this.time > 3 && leader !== this.leader) this.d.announcer.say('ann.lead', { name: leader.spec.name });
    this.leader = leader;
  }

  /** Dust, smoke from damaged or overheated engines, zoom blur, damage tint. */
  private effects(dt: number): void {
    const d = this.d;
    const p = this.player;
    for (const pod of this.pods) {
      if (!pod.alive || pod.out) continue;
      const close = pod.pos.distanceToSquared(d.rig.camera.position) < 600 * 600;
      if (!close) continue;
      const speed = pod.speed;
      for (let i = 0; i < 2; i++) {
        const e = i ? pod.model.engineR : pod.model.engineL;
        e.getWorldPosition(_a);
        if (!pod.airborne && speed > 20) {
          _b.copy(_a);
          _b.y = groundHeight(d.track, _b.x, _b.z) + 0.5;
          _a.copy(pod.vel).multiplyScalar(0.25);
          d.dust.emit(_b, _a, pod.offTrack > 0 ? 5 : 2);
          e.getWorldPosition(_a);
        }
        // A hurt engine trails smoke, a dying one sparks too.
        const wear = pod.wear[i];
        if (wear > 0.3 && Math.random() < wear * dt * 40) {
          _b.copy(pod.vel).multiplyScalar(0.2);
          d.fx.burst('smoke', _a, _b, 1, 3);
          if (wear > 0.7) d.fx.burst('spark', _a, _b, 2, 6);
        }
        if (pod.repairing && wear > 0 && Math.random() < dt * 20) {
          _b.copy(pod.vel);
          d.fx.burst('spark', _a, _b, 2, 3);
        }
        if (pod.overheated && Math.random() < dt * 25) {
          _b.set(0, 3, 0);
          d.fx.burst('steam', _a, _b, 1, 2);
        }
      }
      if (pod.scraping && speed > 30) {
        _b.copy(pod.vel).multiplyScalar(0.4);
        d.fx.burst('spark', pod.pos, _b, 3, 12);
      }
    }
    const sp = Math.min(1, Math.max(0, (p.speed - 120) / 150));
    d.engine.speed += ((p.boosting ? 1 : sp * 0.6) - d.engine.speed) * Math.min(1, dt * 4);
    d.engine.damage = p.alive ? Math.max(0, p.damage - 0.35) * 1.2 : 0.35;
    d.engine.flash = Math.max(0, d.engine.flash - dt * 2.5);

    // Audio: the stands roar as the camera nears them; rival voices mirror their pods.
    const near = Math.max(0, 1 - d.rig.camera.position.distanceTo(this.stands) / 700);
    d.audio.crowd(near * near * (this.phase === 'finished' ? 1.4 : 1));
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const pod = this.pods[i + 1];
      v.throttle = pod.locked ? 0.15 : pod.ctl.throttle;
      v.boost = pod.boosting;
      v.alive = pod.alive && !pod.out;
    }
    d.audio.update(dt, d.rig.camera, d.rig.velocity, { speed: p.speed, throttle: p.locked ? 0.2 : p.ctl.throttle, boost: p.boosting, heat: p.heat, airborne: p.airborne, offTrack: p.offTrack > 0, scraping: p.scraping }, this.voices);
  }

  results(): ResultRow[] {
    const len = this.d.track.length;
    return this.order.map((pod) => {
      let time = pod.finishTime;
      // Pods still racing when the results come up: projected finish at a typical race pace.
      if (time === null && !pod.out) time = this.time + ((LAPS - pod.progress) * len) / 190;
      return {
        name: pod.spec.name,
        time: pod.out ? null : time,
        bestLap: pod.lapTimes.length ? Math.min(...pod.lapTimes) : null,
        player: pod.player,
      };
    });
  }

  get playerPosition(): number {
    return this.position;
  }
}
