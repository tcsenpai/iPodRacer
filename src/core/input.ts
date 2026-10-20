// Keyboard + gamepads mapped to one podracer control frame per player slot (ported from yavin's input
// layer). Single player (split = false): every key cluster and the first connected gamepad drive slot 0.
// Split screen (split = true) gives each player half the keyboard and their own gamepad:
//   slot 0: W/S throttle/brake, A/D steer (double tap = barrel roll), Left Shift or Space boost,
//           Q/E tilt, F repair, C camera, R reset
//   slot 1: arrows throttle/brake/steer (double tap left/right = barrel roll), Right Shift or Numpad 0
//           boost, comma/period tilt, slash repair, quote camera, semicolon reset
//   the n-th connected gamepad drives slot n.
// The slot 1 keys are the cluster right above the arrows on laptop and full-size keyboards alike, so the
// right hand never leaves it. Esc/P (pause) and Enter (confirm) are shared and land in slot 0.
import { clamp } from './rng';
import type { StringKey } from '../i18n/i18n';

export interface PodControls {
  /** -1..1, + = right. Keyboard ramps in so a tap is a nudge, a hold is a full turn. */
  steer: number;
  /** 0..1 thrust on both engines. */
  throttle: number;
  /** 0..1 air brakes: slow down and tighten the turn. */
  brake: number;
  /** Held: overdrive boost (builds engine heat). */
  boost: boolean;
  /** -1..1 held tilt: roll the pod on its side to slip through gaps (+ = right side down). */
  tilt: number;
  /** Held: repair droids patch the worst engine (throttle capped, no boost). */
  repair: boolean;
}

export type Action = 'camera' | 'pause' | 'confirm' | 'reset' | 'rollLeft' | 'rollRight';
export type Slot = 0 | 1;

type Control = 'steerLeft' | 'steerRight' | 'throttle' | 'brake' | 'boost' | 'tiltLeft' | 'tiltRight' | 'repair' | 'camera' | 'reset';
type KeyLayout = Record<Control, readonly string[]>;

/** Single player: both clusters at once, exactly the pre-split bindings. */
const SOLO: KeyLayout = {
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  boost: ['ShiftLeft', 'ShiftRight', 'Space'],
  tiltLeft: ['KeyQ'],
  tiltRight: ['KeyE'],
  repair: ['KeyF'],
  camera: ['KeyC'],
  reset: ['KeyR'],
};

const SPLIT: readonly [KeyLayout, KeyLayout] = [
  {
    steerLeft: ['KeyA'],
    steerRight: ['KeyD'],
    throttle: ['KeyW'],
    brake: ['KeyS'],
    boost: ['ShiftLeft', 'Space'],
    tiltLeft: ['KeyQ'],
    tiltRight: ['KeyE'],
    repair: ['KeyF'],
    camera: ['KeyC'],
    reset: ['KeyR'],
  },
  {
    steerLeft: ['ArrowLeft'],
    steerRight: ['ArrowRight'],
    throttle: ['ArrowUp'],
    brake: ['ArrowDown'],
    boost: ['ShiftRight', 'Numpad0'],
    tiltLeft: ['Comma'],
    tiltRight: ['Period'],
    repair: ['Slash'],
    camera: ['Quote'],
    reset: ['Semicolon'],
  },
];

const SOLO_LAYOUTS: readonly KeyLayout[] = [SOLO];

/** Split-screen keyboard legend per slot for the controls card: [keycap text, description key]. */
export const KEY_HINTS: Record<Slot, readonly (readonly [keycap: string, desc: StringKey])[]> = {
  0: [
    ['W', 'ctl.throttle'],
    ['S', 'ctl.brake'],
    ['A D', 'ctl.steer'],
    ['L-Shift / Space', 'ctl.boost'],
    ['2× A / D', 'ctl.roll'],
    ['Q / E', 'ctl.tilt'],
    ['F', 'ctl.repair'],
    ['C', 'ctl.camera'],
    ['R', 'ctl.reset'],
  ],
  1: [
    ['↑', 'ctl.throttle'],
    ['↓', 'ctl.brake'],
    ['← →', 'ctl.steer'],
    ['R-Shift / Num 0', 'ctl.boost'],
    ['2× ← / →', 'ctl.roll'],
    [', / .', 'ctl.tilt'],
    ['/', 'ctl.repair'],
    ["'", 'ctl.camera'],
    [';', 'ctl.reset'],
  ],
};

/** Shared keys, not tied to a player; they land in slot 0. */
const GLOBAL_KEYS: Partial<Record<Action, readonly string[]>> = {
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'NumpadEnter'],
};

const GAMEPAD_ACTIONS: Partial<Record<Action, number>> = {
  camera: 3, // Y
  pause: 9, // start
  confirm: 0, // A
  rollLeft: 2, // X
  rollRight: 1, // B
  reset: 8, // back/view
};

/** Firefox opens quick find on these; only bound (and blocked) in split screen. */
const SPLIT_BLOCKED: Record<string, true> = { Quote: true, Slash: true };

export class Input {
  /** Split-screen bindings (see the header); false = single player, everything drives slot 0. */
  split = false;
  private keys = new Set<string>();
  private readonly pressed: readonly [Set<Action>, Set<Action>] = [new Set(), new Set()];
  private readonly padPrev: readonly [boolean[], boolean[]] = [[], []];
  private readonly kbSteer: [number, number] = [0, 0];
  /** Last key-down time per steer key, for double-tap barrel rolls. */
  private lastTap: Record<string, number> = {};
  private readonly out: readonly [PodControls, PodControls] = [
    { steer: 0, throttle: 0, brake: 0, boost: false, tilt: 0, repair: false },
    { steer: 0, throttle: 0, brake: 0, boost: false, tilt: 0, repair: false },
  ];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const code = e.code;
      this.keys.add(code);
      for (const [action, codes] of Object.entries(GLOBAL_KEYS) as [Action, readonly string[]][]) {
        if (codes.includes(code)) this.pressed[0].add(action);
      }
      const layouts = this.split ? SPLIT : SOLO_LAYOUTS;
      for (let slot = 0; slot < layouts.length; slot++) {
        const l = layouts[slot];
        const pressed = this.pressed[slot];
        if (l.camera.includes(code)) pressed.add('camera');
        if (l.reset.includes(code)) pressed.add('reset');
        const roll: Action | null = l.steerLeft.includes(code) ? 'rollLeft' : l.steerRight.includes(code) ? 'rollRight' : null;
        if (roll) {
          const now = performance.now();
          if (now - (this.lastTap[code] ?? -1e9) < 280) pressed.add(roll);
          this.lastTap[code] = now;
        }
      }
      if (code === 'Space' || code.startsWith('Arrow') || (this.split && SPLIT_BLOCKED[code])) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Edge-triggered action query; consumes the press. No slot = any slot (menus, pause). */
  consume(action: Action, slot?: Slot): boolean {
    if (slot !== undefined) return this.pressed[slot].delete(action);
    // Both deletes must run, or a press left in the other slot would fire on a later query.
    const a = this.pressed[0].delete(action);
    const b = this.pressed[1].delete(action);
    return a || b;
  }

  clearPresses(): void {
    this.pressed[0].clear();
    this.pressed[1].clear();
  }

  private key(codes: readonly string[]): boolean {
    for (let i = 0; i < codes.length; i++) if (this.keys.has(codes[i])) return true;
    return false;
  }

  /** The n-th connected gamepad (pads can leave holes in getGamepads()). */
  private pad(slot: Slot): Gamepad | null {
    const pads = navigator.getGamepads?.();
    if (!pads) return null;
    let n = 0;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (n === slot) return p;
      n++;
    }
    return null;
  }

  /**
   * Current controls of a slot; the returned object is reused every call. Also polls that slot's gamepad
   * buttons for edge actions, so in split screen call it for both slots every frame.
   */
  read(dt: number, slot: Slot = 0): PodControls {
    const o = this.out[slot];
    // Single player has no keyboard slot 1: only a second gamepad could drive it.
    const l: KeyLayout | undefined = (this.split ? SPLIT : SOLO_LAYOUTS)[slot];
    let target = 0;
    let throttle = 0;
    let brake = 0;
    let boost = false;
    let tilt = 0;
    let repair = false;
    if (l) {
      target = (this.key(l.steerRight) ? 1 : 0) - (this.key(l.steerLeft) ? 1 : 0);
      throttle = this.key(l.throttle) ? 1 : 0;
      brake = this.key(l.brake) ? 1 : 0;
      boost = this.key(l.boost);
      tilt = (this.key(l.tiltRight) ? 1 : 0) - (this.key(l.tiltLeft) ? 1 : 0);
      repair = this.key(l.repair);
    }
    // Fast ramp in, faster release: precise on the straights, snappy out of a corner.
    const kb = this.kbSteer[slot];
    const rate = target === 0 || Math.sign(target) !== Math.sign(kb) ? 9 : 4.5;
    const ks = kb + clamp(target - kb, -dt * rate, dt * rate);
    this.kbSteer[slot] = ks;
    let steer = ks;

    const pad = this.pad(slot);
    if (pad) {
      const x = pad.axes[0] ?? 0;
      // Deadzone + mild expo: fine corrections near centre.
      const a = Math.abs(x) < 0.1 ? 0 : (Math.abs(x) - 0.1) / 0.9;
      steer += Math.sign(x) * (0.4 * a + 0.6 * a * a);
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      boost ||= !!pad.buttons[0]?.pressed;
      repair ||= !!pad.buttons[13]?.pressed; // d-pad down
      tilt += (pad.buttons[5]?.pressed ? 1 : 0) - (pad.buttons[4]?.pressed ? 1 : 0);
      const prev = this.padPrev[slot];
      for (const [action, idx] of Object.entries(GAMEPAD_ACTIONS) as [Action, number][]) {
        const down = !!pad.buttons[idx]?.pressed;
        if (down && !prev[idx]) this.pressed[slot].add(action);
        prev[idx] = down;
      }
    }
    o.steer = clamp(steer, -1, 1);
    o.throttle = clamp(throttle, 0, 1);
    o.brake = clamp(brake, 0, 1);
    o.boost = boost;
    o.tilt = clamp(tilt, -1, 1);
    o.repair = repair;
    return o;
  }
}
