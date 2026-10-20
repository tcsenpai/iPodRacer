// A race on any course: grid, cinematic intro, countdown, laps against the rivals, finish.
// Owns the pods and their pilots; turns physics events into sound, particles, camera and HUD moments.
// One or two local players: each has its own pod, camera rig, HUD and post-process view.
import * as THREE from 'three';
import type { Announcer } from '../audio/announcer';
import type { GameAudio, EngineVoice } from '../audio/audio';
import type { Engine, ViewFx } from '../core/engine';
import type { Input } from '../core/input';
import { DIFFICULTY, type Difficulty, type DifficultyProfile } from '../core/settings';
import { t } from '../i18n/i18n';
import type { Hud, HudPod, HudState } from '../ui/hud';
import type { ResultRow } from '../ui/menus';
import type { DustTrail } from '../world/dust';
import type { Collider } from '../world/props';
import { groundHeight } from '../world/terrain';
import type { Track } from '../world/track';
import { Pilot } from './ai';
import { Geysers, Snipers, type GeyserEvents, type SniperEvents } from './hazards';
import type { CameraRig } from './camera';
import type { Fx } from './fx';
import { Pod, type PodEvents, type PodWorld } from './pod';
import { pickRivals, type PilotDef } from './roster';

/** Pods on the grid, players included. */
const FIELD = 6;
/** Rivals are a little tougher than the player and drop out on their third wreck. */
const RIVAL_DAMAGE = 0.7;
const RIVAL_LIVES = 3;
const GRID_ROW = 34; // m between grid rows
const COUNTDOWN = 3.6; // s from the end of the intro to GO
/** Grid slots of the players (0 = pole): fifth and sixth, like Anakin. Rivals fill the rest. */
const PLAYER_SLOTS = [4, 5];
/**
 * Split screen: once one player is through the line the other gets this long (race time) to finish
 * before the results; the straggler's time is then projected like a rival still on course.
 */
const FINISH_GRACE = 30;
/** Shots of the intro: the grid crane, a rival by grid rank, or each player's own pod. */
const INTRO: { dur: number; who: 'grid' | 'player' | number }[] = [
  { dur: 3.4, who: 'grid' },
  { dur: 2.4, who: 0 },
  { dur: 2.2, who: 1 },
  { dur: 2.6, who: 'player' },
];

export type Phase = 'intro' | 'countdown' | 'racing' | 'finished';

export interface RaceDeps {
  scene: THREE.Object3D;
  engine: Engine;
  track: Track;
  colliders: readonly Collider[];
  /** One HUD and one camera rig per local player; index = view slot (engine.fx / input slot). */
  huds: readonly Hud[];
  rigs: readonly CameraRig[];
  audio: GameAudio;
  fx: Fx;
  dust: DustTrail;
  announcer: Announcer;
}

/** Per local player state: everything the single-player race used to keep once. */
interface Human {
  slot: 0 | 1;
  pod: Pod;
  rig: CameraRig;
  hud: Hud;
  view: ViewFx;
  hudState: HudState;
  /** Flies the pod after the finish line (and in autoplay). */
  autopilot: Pilot;
  position: number;
  /** Through the line (or timed out by FINISH_GRACE): the autopilot drives. */
  done: boolean;
  throttle: number;
  throttleWas: number;
  perfectWindow: boolean;
  resetCooldown: number;
  wrongShown: boolean;
  /** The engine-hit repair hint shows once per race. */
  hintShown: boolean;
  repairedFrom: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Race {
  readonly pods: Pod[];
  /** Local players' pods, index = view slot. */
  readonly players: Pod[];
  /** Player 1: audio listener and the focus for world updates. */
  readonly player: Pod;
  readonly difficulty: Difficulty;
  readonly laps: number;
  phase: Phase = 'intro';
  /** Race clock (s since GO). */
  time = 0;
  /** Time-scale wanted by the race (slow motion moments); main applies it. */
  timeScale = 1;
  /** Seconds since the race finished for every player (results show after a cool-down). */
  finishedFor = 0;
  /** Dev/headless: the AI flies the players' pods (galactic skill). */
  autoplay = false;
  private phaseT = 0;
  private shot = -1;
  private slowmo = 0;
  private slowFactor = 1;
  private readonly humans: Human[];
  /** Rivals in grid order (pole first). */
  private readonly rivals: Pod[];
  private pilots: Pilot[] = [];
  private world: PodWorld;
  private order: Pod[];
  private lastBeep = 99;
  /** Race time when the first player crossed the line, -1 before. */
  private firstDone = -1;
  private hudPods: HudPod[];
  private snipers: Snipers;
  private geysers: Geysers;
  /** Commentary state: current leader and the highest lap any pod has completed. */
  private leader: Pod | null = null;
  private leaderLap = 0;
  private sniperCalled = false;
  /** Centre of the start/finish line, for the crowd roar. */
  private readonly stands = new THREE.Vector3();
  /** Engine voices of every pod but player 1's (the listener), index i mirrors pods[i + 1]. */
  private voices: EngineVoice[];

  constructor(
    private d: RaceDeps,
    difficulty: Difficulty,
    /** One pilot per local player (1 or 2), matching d.huds / d.rigs. */
    players: readonly PilotDef[],
    seed: number,
  ) {
    this.difficulty = difficulty;
    const def = d.track.def;
    this.laps = def.laps;
    const diff = DIFFICULTY[difficulty];
    this.players = players.map((p) => new Pod(p, true));
    this.player = this.players[0];
    // Qualifying: the quickest rivals start up front.
    const rivalDefs = pickRivals(
      players.map((p) => p.id),
      FIELD - players.length,
      seed,
    ).sort((a, b) => b.traits.pace - a.traits.pace);
    this.rivals = rivalDefs.map((p) => new Pod(p, false));
    this.pods = [...this.players, ...this.rivals];
    for (const pod of this.pods) pod.dmgScale = pod.baseDurability * (pod.player ? diff.damage : RIVAL_DAMAGE);
    for (const pod of this.rivals) this.pilots.push(new Pilot(pod, pod.pilot.traits));
    this.order = this.pods.slice();
    const events = this.events();
    this.world = { track: d.track, colliders: d.colliders, pods: this.pods, events };

    // Grid: two staggered columns behind the line.
    const free = [0, 1, 2, 3, 4, 5].filter((s) => !PLAYER_SLOTS.slice(0, players.length).includes(s));
    this.pods.forEach((pod, i) => {
      const slot = i < players.length ? PLAYER_SLOTS[i] : free[i - players.length];
      const back = 25 + Math.floor(slot / 2) * GRID_ROW + (slot % 2) * 12;
      const u = -back / d.track.length;
      pod.place(d.track, u, slot % 2 ? 11 : -11, 0);
      pod.progress = u;
      d.scene.add(pod.model.root);
      pod.syncModel(0);
    });
    this.hudPods = this.pods.map((p, i) => ({ x: p.pos.x, z: p.pos.z, player: p.player, alive: true, slot: i === 0 ? 0 : i === 1 && p.player ? 1 : undefined }));
    this.humans = this.players.map((pod, i) => {
      const slot: 0 | 1 = i === 0 ? 0 : 1;
      return {
        slot,
        pod,
        rig: d.rigs[i],
        hud: d.huds[i],
        view: d.engine.fx[i],
        hudState: {
          lap: 1,
          laps: this.laps,
          position: this.pods.length,
          racers: this.pods.length,
          speed: 0,
          heat: 0,
          overheated: false,
          cooldown: 0,
          engines: pod.wear,
          repairing: false,
          raceTime: 0,
          lapTime: 0,
          lapTimes: pod.lapTimes,
          bestLap: null,
          wrongWay: false,
          pods: this.hudPods,
        },
        autopilot: new Pilot(pod, pod.pilot.traits),
        position: 0,
        done: false,
        throttle: 0,
        throttleWas: 0,
        perfectWindow: false,
        resetCooldown: 0,
        wrongShown: false,
        hintShown: false,
        repairedFrom: 0,
      };
    });
    this.voices = this.pods.slice(1).map((p) => ({ pos: p.pos, vel: p.vel, throttle: 0, boost: false, alive: true }));
    for (const h of this.humans) {
      h.hud.setVisible(false);
      h.hud.letterbox(true);
    }
    d.audio.setRacing(true);
    d.audio.music('race');
    this.snipers = new Snipers(d.track, this.sniperEvents());
    d.track.frame(0, this.stands, _a, _b);
    d.scene.add(this.snipers.group);
    this.geysers = new Geysers(d.track, this.geyserEvents());
    d.scene.add(this.geysers.group);
    this.nextShot();
  }

  dispose(): void {
    for (const p of this.pods) this.d.scene.remove(p.model.root);
    this.d.scene.remove(this.snipers.group);
    this.d.scene.remove(this.geysers.group);
    for (const h of this.humans) {
      h.hud.caption('', '');
      h.hud.letterbox(false);
    }
    this.d.audio.setRacing(false);
    this.d.announcer.stop();
  }

  /** The local player flying `pod`, if any. */
  private human(pod: Pod): Human | null {
    for (const h of this.humans) if (h.pod === pod) return h;
    return null;
  }

  /** Player 1's camera: the audio listener. */
  private get listener(): THREE.PerspectiveCamera {
    return this.humans[0].rig.camera;
  }

  private sniperEvents(): SniperEvents {
    const d = this.d;
    return {
      glint: (target) => {
        const h = this.human(target);
        if (!h) return;
        d.audio.sniperGlint();
        h.hud.banner(t('race.sniper'), 'warn', 0.9);
      },
      shot: (from, target, hit, dodged) => {
        d.audio.gunshot(from.distanceTo(this.listener.position));
        if (hit) {
          _b.copy(target.vel).multiplyScalar(0.3);
          d.fx.burst('spark', target.pos, _b, 40, 25);
          d.fx.burst('smoke', target.pos, _b, 6, 6);
        }
        const h = this.human(target);
        if (!h) return;
        if (hit) {
          d.audio.impact(0.7);
          h.rig.shake(0.7);
          h.view.flash = Math.max(h.view.flash, 0.2);
          if (!h.hintShown) {
            h.hintShown = true;
            h.hud.banner(t('race.enginehit'), 'warn', 2.5);
          }
          if (!this.sniperCalled) {
            this.sniperCalled = true;
            d.announcer.say('ann.sniper', undefined, true);
          }
        } else if (dodged) {
          h.hud.trick(t('race.dodge'));
          h.pod.heat = Math.max(0, h.pod.heat - 0.2);
        }
      },
    };
  }

  private geyserEvents(): GeyserEvents {
    const d = this.d;
    return {
      // The vent glows before it blows: warn players close enough to react.
      warn: (at) => {
        for (const h of this.humans) if (!h.done && h.pod.pos.distanceToSquared(at) < 160 * 160) h.hud.banner(t('race.geyser'), 'warn', 0.9);
      },
      erupt: (at) => {
        if (at.distanceToSquared(this.listener.position) < 300 * 300) d.audio.flame();
      },
      burn: (target) => {
        _b.set(0, 6, 0);
        d.fx.burst('fire', target.pos, _b, 10, 8);
        const h = this.human(target);
        if (!h) return;
        d.audio.impact(0.5);
        h.rig.shake(0.6);
        h.view.flash = Math.max(h.view.flash, 0.25);
        h.hud.trick(t('race.burn'));
      },
    };
  }

  private events(): PodEvents {
    const d = this.d;
    const nearCam = (p: Pod) => p.pos.distanceTo(this.listener.position);
    return {
      impact: (pod, s, at) => {
        _b.copy(pod.vel).multiplyScalar(0.3);
        d.fx.burst('spark', at, _b, Math.round(10 + s * 50), 18 + s * 30);
        const h = this.human(pod);
        if (h) {
          d.audio.impact(s);
          h.rig.shake(0.3 + s * 0.9);
          h.view.flash = Math.max(h.view.flash, s * 0.25);
        } else if (nearCam(pod) < 90) d.audio.impact(s * 0.5);
      },
      nearMiss: (pod, knife) => {
        const h = this.human(pod);
        if (!h) return;
        h.hud.trick(t(knife ? 'race.knife' : 'race.nearmiss'));
        d.audio.nearMiss();
        h.rig.shake(0.2);
        if (knife) this.slow(0.6, 0.45);
      },
      crash: (pod) => {
        d.fx.explosion(pod.pos, pod.vel);
        d.audio.explosion(nearCam(pod));
        const h = this.human(pod);
        if (h) {
          h.hud.banner(t('race.crash'), 'warn');
          h.rig.setShot({ kind: 'crash', pod });
          h.rig.shake(1.2);
          h.view.flash = 0.4;
          this.slow(1.2, 0.35);
          d.announcer.say('ann.crash', { name: pod.spec.name }, true);
        } else {
          if (pod.crashes >= RIVAL_LIVES) {
            pod.out = true;
            for (const o of this.humans) o.hud.banner(t('race.rivalout', { name: pod.spec.name }), 'info');
            d.announcer.say('ann.out', { name: pod.spec.name }, true);
          } else d.announcer.say('ann.crash', { name: pod.spec.name });
          for (const o of this.humans) {
            if (pod.pos.distanceTo(o.rig.camera.position) >= 350) continue;
            this.slow(0.9, 0.35);
            o.rig.shake(0.5);
          }
        }
      },
      landed: (pod, air) => {
        _a.copy(pod.pos);
        _a.y -= 2;
        _b.set(0, 4, 0);
        d.fx.burst('smoke', _a, _b, Math.round(air * 10), 10);
        const h = this.human(pod);
        if (!h) return;
        h.rig.shake(Math.min(0.25 + air * 0.35, 0.9));
        if (air > 0.8) h.hud.trick(t('race.air', { s: air.toFixed(1) }));
      },
      boost: (pod) => {
        const h = this.human(pod);
        if (!h) return;
        d.audio.boost();
        h.rig.kick(9);
        h.rig.shake(0.3);
      },
      overheat: (pod) => {
        const h = this.human(pod);
        if (!h) return;
        d.audio.overheat();
        h.hud.banner(t('race.overheat'), 'warn');
      },
      roll: (pod) => {
        const h = this.human(pod);
        if (!h) return;
        d.audio.roll();
        h.hud.trick(t('race.roll'));
      },
    };
  }

  /**
   * Slow motion for `seconds` (real time) at `factor`. Split screen keeps real time while anyone is
   * still racing: one player's wreck must not slow the other's run.
   */
  private slow(seconds: number, factor: number): void {
    if (this.humans.length > 1 && this.phase !== 'finished') return;
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
    const who = INTRO[this.shot].who;
    const track = this.d.track;
    if (who === 'grid') {
      const p = new THREE.Vector3();
      const tg = new THREE.Vector3();
      const r = new THREE.Vector3();
      track.frame(-60 / track.length, p, tg, r);
      p.y = groundHeight(track, p.x, p.z) + 2;
      const def = track.def;
      const name = t(def.nameKey);
      for (const h of this.humans) {
        h.rig.setShot({ kind: 'crane', at: p, heading: Math.atan2(tg.x, -tg.z) });
        h.hud.caption(name, t('race.intro.sub', { planet: def.planet, laps: this.laps }));
      }
      this.d.announcer.say('ann.intro', { planet: def.planet, track: name, laps: this.laps }, true);
    } else {
      for (const h of this.humans) {
        const pod = who === 'player' ? h.pod : this.rivals[who];
        h.rig.setShot({ kind: who === 'player' ? 'low' : 'orbit', pod });
        h.hud.caption(pod.spec.name, t('rival.sub', { species: pod.spec.species, pod: pod.spec.make }));
      }
    }
  }

  private startCountdown(): void {
    this.phase = 'countdown';
    this.phaseT = 0;
    for (const h of this.humans) {
      h.hud.caption('', '');
      h.hud.letterbox(false);
      h.hud.setVisible(true);
      h.rig.setShot({ kind: 'race' });
    }
  }

  /** Read one player's controls into their pod (the autopilot takes over after the finish line). */
  private control(h: Human, dt: number, real: number, input: Input, diff: DifficultyProfile): void {
    const d = this.d;
    const p = h.pod;
    const ctl = input.read(real, h.slot);
    h.throttle = ctl.throttle;
    if (h.done) {
      h.autopilot.drive(dt, d.track, d.colliders, this.pods, diff, p.progress, true);
    } else if (this.autoplay) {
      if (!p.locked) h.autopilot.drive(dt, d.track, d.colliders, this.pods, DIFFICULTY.galactic, p.progress);
      if (h.autopilot.pendingRoll) p.startRoll(h.autopilot.pendingRoll, this.world.events);
    } else {
      Object.assign(p.ctl, ctl);
      if (input.consume('rollLeft', h.slot)) p.startRoll(-1, this.world.events);
      if (input.consume('rollRight', h.slot)) p.startRoll(1, this.world.events);
    }
    if (input.consume('camera', h.slot)) h.rig.mode = h.rig.mode === 'chase' ? 'far' : h.rig.mode === 'far' ? 'cockpit' : 'chase';
    h.resetCooldown -= real;
    if (input.consume('reset', h.slot) && this.phase === 'racing' && !h.done && p.alive && h.resetCooldown <= 0) {
      h.resetCooldown = 3;
      p.place(d.track, p.u, 0, 50);
      p.ghost = 1.5;
    }
  }

  /** Advance by `dt` (game time, already slowed) with `real` the unscaled frame time. */
  update(dt: number, real: number, input: Input): void {
    const d = this.d;
    this.phaseT += real;
    this.slowmo = Math.max(0, this.slowmo - real);
    if (this.slowmo <= 0) this.slowFactor = 1;
    this.timeScale = this.slowFactor;
    const diff = DIFFICULTY[this.difficulty];

    for (const h of this.humans) this.control(h, dt, real, input, diff);

    if (this.phase === 'intro') {
      if (this.phaseT > INTRO[this.shot].dur) this.nextShot();
      if (input.consume('confirm')) this.skipIntro();
    } else if (this.phase === 'countdown') {
      const left = COUNTDOWN - this.phaseT;
      const n = Math.ceil(left);
      if (n !== this.lastBeep && n <= 3 && n >= 1) {
        this.lastBeep = n;
        for (const h of this.humans) h.hud.banner(String(n), 'countdown');
        d.audio.countdown(n);
      }
      // Perfect start: hit the throttle in the last moment before the lights go (or just after).
      for (const h of this.humans) if (h.throttle > 0.5 && h.throttleWas <= 0.5) h.perfectWindow = left < 0.35;
      if (left <= 0) this.go();
    } else if (this.phase === 'racing' && this.time < 0.15) {
      for (const h of this.humans) if (h.throttle > 0.5 && h.throttleWas <= 0.5) this.perfectStart(h);
    }
    for (const h of this.humans) h.throttleWas = h.throttle;

    if (this.phase === 'racing' || this.phase === 'finished') this.time += dt;

    // Rubber band against the leading player.
    let lead = this.player.progress;
    for (const h of this.humans) lead = Math.max(lead, h.pod.progress);

    // AI, and Sebulba's flame vent on whoever he catches alongside.
    for (const pilot of this.pilots) {
      if (pilot.pod.locked || pilot.pod.out) continue;
      const wasFlaming = pilot.flameTime > 0;
      pilot.drive(dt, d.track, d.colliders, this.pods, diff, lead);
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
          const h = this.human(victim);
          if (h || src.pos.distanceTo(this.listener.position) < 120) d.audio.flame();
          if (h) {
            h.hud.banner(t('race.flame'), 'warn', 1.2);
            d.announcer.say('ann.flame');
            h.rig.shake(0.5);
          }
        }
      }
    }
    if (this.phase === 'racing') {
      this.snipers.update(dt, this.pods, this.world, diff.sniper, this.listener);
      this.geysers.update(dt, this.pods, this.world);
    }

    // Physics, laps, respawns.
    for (const pod of this.pods) {
      if (pod.out) {
        pod.model.root.visible = false;
        continue;
      }
      pod.step(dt, this.world);
      if (!pod.alive && pod.respawnIn <= 0 && !pod.out) {
        pod.respawn(d.track);
        const h = this.human(pod);
        if (h) {
          h.rig.setShot(h.done ? { kind: 'finish', pod } : { kind: 'race' });
          h.hud.banner(t('race.respawn'), 'info');
        }
      }
      this.lapCheck(pod);
      pod.syncModel(dt);
    }
    this.rank();
    // Split screen: a straggler gets FINISH_GRACE seconds after the first player is home.
    if (this.phase === 'racing' && this.firstDone >= 0 && this.time - this.firstDone > FINISH_GRACE) {
      for (const h of this.humans) if (!h.done) this.finishPlayer(h);
    }
    this.effects(dt);

    // Finish cool-down: let the camera circle the pod before the results.
    if (this.phase === 'finished') this.finishedFor += real;

    // HUD.
    for (let i = 0; i < this.pods.length; i++) {
      this.hudPods[i].x = this.pods[i].pos.x;
      this.hudPods[i].z = this.pods[i].pos.z;
      this.hudPods[i].alive = this.pods[i].alive && !this.pods[i].out;
    }
    for (const h of this.humans) this.updateHud(h);
  }

  private updateHud(h: Human): void {
    const p = h.pod;
    const s = h.hudState;
    s.lap = Math.min(this.laps, Math.max(1, Math.floor(p.progress) + 1));
    s.position = h.position;
    s.speed = p.speed;
    s.heat = p.heat;
    s.overheated = p.overheated;
    s.cooldown = p.boostCooldown / p.boostCooldownMax;
    s.repairing = p.repairing;
    // A full repair after real damage earns a callout.
    if (p.repairing) h.repairedFrom = Math.max(h.repairedFrom, p.damage);
    else h.repairedFrom = 0;
    if (p.repairing && p.damage === 0 && h.repairedFrom > 0.2) {
      h.repairedFrom = 0;
      h.hud.trick(t('race.repaired'));
    }
    s.raceTime = p.finishTime ?? this.time;
    s.lapTime = this.phase === 'racing' && !h.done ? this.time - p.lapStart : 0;
    s.bestLap = p.lapTimes.length ? Math.min(...p.lapTimes) : null;
    const wrong = p.wrongWay > 1.2 && this.phase === 'racing' && !h.done;
    s.wrongWay = wrong;
    if (wrong && !h.wrongShown) this.d.audio.overheat();
    h.wrongShown = wrong;
    h.hud.update(s);
    h.hud.speedFx(Math.min(1, p.speed / 260));
  }

  private go(): void {
    const d = this.d;
    this.phase = 'racing';
    this.time = 0;
    for (const pod of this.pods) {
      pod.locked = false;
      pod.lapStart = 0;
    }
    for (const h of this.humans) {
      h.hud.banner(t('race.go'), 'go');
      h.rig.shake(0.4);
    }
    d.audio.countdown(0);
    d.announcer.say('ann.go', undefined, true);
    for (const h of this.humans) if (h.perfectWindow) this.perfectStart(h);
  }

  private perfectStart(h: Human): void {
    h.pod.forward(_a);
    h.pod.vel.addScaledVector(_a, 55);
    h.hud.trick(t('race.perfect'));
    this.d.audio.boost();
    h.rig.kick(10);
    h.rig.shake(0.4);
  }

  private lapCheck(pod: Pod): void {
    if (this.phase !== 'racing' && this.phase !== 'finished') return;
    if (pod.finishTime !== null) return;
    const lap = Math.floor(pod.progress);
    if (lap <= pod.lapTimes.length || lap < 1) return;
    pod.lapTimes.push(this.time - pod.lapStart);
    pod.lapStart = this.time;
    const h = this.human(pod);
    if (lap >= this.laps) {
      pod.finishTime = this.time;
      if (h && !h.done) this.finishPlayer(h);
      return;
    }
    // The first pod through the line calls the lap for the commentators.
    const final = lap === this.laps - 1;
    if (lap > this.leaderLap) {
      this.leaderLap = lap;
      this.d.announcer.say(final ? 'ann.final' : 'ann.lap', { name: pod.spec.name, n: lap }, final);
    }
    if (h && !h.done) {
      h.hud.banner(final ? t('race.final') : t('race.lap', { n: lap + 1 }), final ? 'final' : 'lap');
      this.d.audio.lap(final);
    }
  }

  /** A player is home (or timed out in split screen); the race ends when every player is. */
  private finishPlayer(h: Human): void {
    const d = this.d;
    h.done = true;
    const last = this.humans.every((o) => o.done);
    if (last) {
      this.phase = 'finished';
      this.finishedFor = 0;
    } else if (this.firstDone < 0) this.firstDone = this.time;
    this.rank();
    const name = h.pod.spec.name;
    h.hud.banner(`${t('race.finish')} · ${t('race.position', { pos: h.position })}`, 'final', 4);
    d.audio.finish(h.position === 1);
    if (h.position === 1) d.announcer.say('ann.win', { name, track: t(d.track.def.nameKey) }, true);
    else d.announcer.say('ann.finish', { name, pos: h.position }, true);
    h.hud.letterbox(true);
    h.rig.setShot({ kind: 'finish', pod: h.pod });
    if (last) this.slow(2.4, 0.3);
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
    for (const h of this.humans) {
      const pos = this.order.indexOf(h.pod) + 1;
      if (h.position && pos < h.position && this.phase === 'racing' && !h.done) h.hud.trick(`${t('race.overtake')} ${t('race.position', { pos })}`);
      h.position = pos;
    }
    const leader = this.order[0];
    if (this.phase === 'racing' && this.time > 3 && leader !== this.leader) this.d.announcer.say('ann.lead', { name: leader.spec.name });
    this.leader = leader;
  }

  /** Squared distance from `pos` to the nearest player camera (particles only matter near a view). */
  private viewDistSq(pos: THREE.Vector3): number {
    let best = Infinity;
    for (const h of this.humans) best = Math.min(best, pos.distanceToSquared(h.rig.camera.position));
    return best;
  }

  /** Dust, smoke from damaged or overheated engines, zoom blur, damage tint. */
  private effects(dt: number): void {
    const d = this.d;
    for (const pod of this.pods) {
      if (!pod.alive || pod.out) continue;
      if (this.viewDistSq(pod.pos) >= 600 * 600) continue;
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
    for (const h of this.humans) {
      const p = h.pod;
      const v = h.view;
      const sp = Math.min(1, Math.max(0, (p.speed - 120) / 150));
      v.speed += ((p.boosting ? 1 : sp * 0.6) - v.speed) * Math.min(1, dt * 4);
      v.damage = p.alive ? Math.max(0, p.damage - 0.35) * 1.2 : 0.35;
      v.flash = Math.max(0, v.flash - dt * 2.5);
    }

    // Audio follows player 1: the stands roar as their camera nears them; every other pod is a voice.
    const rig = this.humans[0].rig;
    const p = this.player;
    const near = Math.max(0, 1 - rig.camera.position.distanceTo(this.stands) / 700);
    d.audio.crowd(near * near * (this.phase === 'finished' ? 1.4 : 1));
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const pod = this.pods[i + 1];
      v.throttle = pod.locked ? 0.15 : pod.ctl.throttle;
      v.boost = pod.boosting;
      v.alive = pod.alive && !pod.out;
    }
    d.audio.update(dt, rig.camera, rig.velocity, { speed: p.speed, throttle: p.locked ? 0.2 : p.ctl.throttle, boost: p.boosting, heat: p.heat, airborne: p.airborne, offTrack: p.offTrack > 0, scraping: p.scraping }, this.voices);
  }

  results(): ResultRow[] {
    const len = this.d.track.length;
    return this.order.map((pod) => {
      let time = pod.finishTime;
      // Pods still racing when the results come up: projected finish at a typical race pace.
      if (time === null && !pod.out) time = this.time + ((this.laps - pod.progress) * len) / 190;
      const h = this.human(pod);
      return {
        name: pod.spec.name,
        time: pod.out ? null : time,
        bestLap: pod.lapTimes.length ? Math.min(...pod.lapTimes) : null,
        player: pod.player,
        slot: h ? h.slot : null,
      };
    });
  }

  /** Final (or current) 1-based position of the player in view slot `slot`. */
  position(slot: number): number {
    return this.humans[slot].position;
  }
}
