// Keyboard + gamepad merged into one podracer control frame (ported from yavin's input layer).
import { clamp } from './rng';

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
}

export type Action = 'camera' | 'pause' | 'confirm' | 'reset' | 'rollLeft' | 'rollRight';

const ACTION_KEYS: Record<Action, string[]> = {
  camera: ['KeyC'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'NumpadEnter'],
  reset: ['KeyR'],
  // Triggered by double-tapping the steer keys (see the keydown handler), not by a single key.
  rollLeft: [],
  rollRight: [],
};

const GAMEPAD_ACTIONS: Partial<Record<Action, number>> = {
  camera: 3, // Y
  pause: 9, // start
  confirm: 0, // A
  rollLeft: 2, // X
  rollRight: 1, // B
  reset: 8, // back/view
};

const ROLL_TAP: Record<string, Action> = { KeyA: 'rollLeft', ArrowLeft: 'rollLeft', KeyD: 'rollRight', ArrowRight: 'rollRight' };

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<Action>();
  private padPrev: boolean[] = [];
  private kbSteer = 0;
  /** Last key-down time per steer key, for double-tap barrel rolls. */
  private lastTap: Record<string, number> = {};
  private out: PodControls = { steer: 0, throttle: 0, brake: 0, boost: false, tilt: 0 };

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      for (const [action, codes] of Object.entries(ACTION_KEYS) as [Action, string[]][]) {
        if (codes.includes(e.code)) this.pressed.add(action);
      }
      const roll = ROLL_TAP[e.code];
      if (roll) {
        const now = performance.now();
        if (now - (this.lastTap[e.code] ?? -1e9) < 280) this.pressed.add(roll);
        this.lastTap[e.code] = now;
      }
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Edge-triggered action query; consumes the press. */
  consume(action: Action): boolean {
    return this.pressed.delete(action);
  }

  clearPresses(): void {
    this.pressed.clear();
  }

  private key(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Current controls; the returned object is reused every call. */
  read(dt: number): PodControls {
    const o = this.out;
    const target = (this.key('KeyD', 'ArrowRight') ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') ? 1 : 0);
    // Fast ramp in, faster release: precise on the straights, snappy out of a corner.
    const rate = target === 0 || Math.sign(target) !== Math.sign(this.kbSteer) ? 9 : 4.5;
    this.kbSteer += clamp(target - this.kbSteer, -dt * rate, dt * rate);
    let steer = this.kbSteer;
    let throttle = this.key('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = this.key('KeyS', 'ArrowDown') ? 1 : 0;
    let boost = this.key('ShiftLeft', 'ShiftRight', 'Space');
    let tilt = (this.key('KeyE') ? 1 : 0) - (this.key('KeyQ') ? 1 : 0);

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const x = pad.axes[0] ?? 0;
      // Deadzone + mild expo: fine corrections near centre.
      const a = Math.abs(x) < 0.1 ? 0 : (Math.abs(x) - 0.1) / 0.9;
      steer += Math.sign(x) * (0.4 * a + 0.6 * a * a);
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      boost ||= !!pad.buttons[0]?.pressed;
      tilt += (pad.buttons[5]?.pressed ? 1 : 0) - (pad.buttons[4]?.pressed ? 1 : 0);
      for (const [action, idx] of Object.entries(GAMEPAD_ACTIONS) as [Action, number][]) {
        const down = !!pad.buttons[idx]?.pressed;
        if (down && !this.padPrev[idx]) this.pressed.add(action);
        this.padPrev[idx] = down;
      }
    }
    o.steer = clamp(steer, -1, 1);
    o.throttle = clamp(throttle, 0, 1);
    o.brake = clamp(brake, 0, 1);
    o.boost = boost;
    o.tilt = clamp(tilt, -1, 1);
    return o;
  }
}
