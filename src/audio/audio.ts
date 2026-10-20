import type * as THREE from 'three';

// Fully synthesised sound: every engine, effect and note is generated at runtime with WebAudio
// oscillators, noise buffers, filters and waveshapers. No audio files.

export interface EngineVoice {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  throttle: number;
  boost: boolean;
  alive: boolean;
}

export interface PlayerAudioState {
  speed: number;
  throttle: number;
  boost: boolean;
  heat: number;
  airborne: boolean;
  offTrack: boolean;
  scraping: boolean;
}

type MusicMode = 'menu' | 'race' | 'off';

const SPEED_OF_SOUND = 343;
const MAX_SPEED = 300;
const MAX_SHOTS = 32; // concurrent one-shot effects; beyond this, low priority sounds are dropped
const RIVAL_REF = 18; // metres at which a rival engine plays at full level
const RIVAL_FORGET = 5; // seconds a rival voice may go unseen before its nodes are released
const LOOKAHEAD = 0.25; // seconds of music scheduled ahead of AudioContext time
const TAU = 0.06; // default smoothing for per-frame parameter targets

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number): number => {
  const x = clamp01((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};

/** Connect nodes in series; the final element may be an AudioParam (modulation target). */
function wire(...n: (AudioNode | AudioParam)[]): void {
  for (let i = 0; i < n.length - 1; i++) {
    const a = n[i];
    const b = n[i + 1];
    if (!(a instanceof AudioNode)) continue;
    if (b instanceof AudioNode) a.connect(b);
    else a.connect(b);
  }
}

/** Percussive envelope: 0 to peak over `atk`, exponential decay to silence over `decay`. */
function perc(p: AudioParam, t: number, peak: number, atk: number, decay: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + atk);
  p.exponentialRampToValueAtTime(0.0001, t + atk + decay);
}

/** Sustained envelope: attack to peak, hold until `dur`, then exponential-ish release. */
function adsr(p: AudioParam, t: number, peak: number, atk: number, dur: number, rel: number): void {
  const hold = Math.max(atk, dur);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + atk);
  p.setValueAtTime(peak, t + hold);
  p.setTargetAtTime(0, t + hold, rel / 3);
}

const curveCache = new Map<number, Float32Array<ArrayBuffer>>();
function softClip(k: number): Float32Array<ArrayBuffer> {
  let c = curveCache.get(k);
  if (!c) {
    c = new Float32Array(1024);
    const norm = Math.tanh(k);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / norm;
    }
    curveCache.set(k, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Node bags: a sound owns its nodes and disconnects them once every source ended, so
// one-shots never leak graph nodes. Persistent loops (engines, wind) use kill().
// ---------------------------------------------------------------------------

class Bag {
  private readonly nodes: AudioNode[] = [];
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private live = 0;
  private armed = false;
  private freed = false;
  onFree: (() => void) | null = null;

  constructor(readonly ctx: AudioContext) {}

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  osc(type: OscillatorType, freq: number, t: number, detune = 0): OscillatorNode {
    const o = this.add(this.ctx.createOscillator());
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.setValueAtTime(detune, t);
    o.start(t);
    this.srcs.push(o);
    return o;
  }

  noise(buf: AudioBuffer, t: number, rate = 1): AudioBufferSourceNode {
    const s = this.add(this.ctx.createBufferSource());
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    // Random offset so simultaneous noises never phase-align into a comb filter.
    s.start(t, Math.random() * buf.duration * 0.9);
    this.srcs.push(s);
    return s;
  }

  gain(v = 1): GainNode {
    const g = this.add(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  filter(type: BiquadFilterType, f: number, q = 0.7, t?: number): BiquadFilterNode {
    const b = this.add(this.ctx.createBiquadFilter());
    b.type = type;
    b.Q.value = q;
    if (t === undefined) b.frequency.value = f;
    else b.frequency.setValueAtTime(f, t);
    return b;
  }

  shaper(k: number, oversample: OverSampleType = 'none'): WaveShaperNode {
    const s = this.add(this.ctx.createWaveShaper());
    s.curve = softClip(k);
    s.oversample = oversample;
    return s;
  }

  stereo(pan: number): StereoPannerNode {
    const p = this.add(this.ctx.createStereoPanner());
    p.pan.value = pan;
    return p;
  }

  /** Schedule all sources to stop at `end`; nodes are disconnected once every source ended. */
  done(end: number): void {
    this.armed = true;
    this.live = this.srcs.length;
    if (this.live === 0) {
      this.free();
      return;
    }
    for (const s of this.srcs) {
      s.onended = () => {
        if (--this.live <= 0) this.free();
      };
      s.stop(end);
    }
  }

  /** Stop early (persistent loops, retired voices). */
  kill(at: number): void {
    if (!this.armed) {
      this.done(at);
      return;
    }
    for (const s of this.srcs) {
      try {
        s.stop(at);
      } catch {
        /* already stopped */
      }
    }
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    for (const n of this.nodes) n.disconnect();
    this.onFree?.();
  }
}

/** One-shot effect: a bag with an output gain already routed to the effects bus. */
class Shot extends Bag {
  readonly out: GainNode;
  constructor(ctx: AudioContext, level: number) {
    super(ctx);
    this.out = this.gain(level);
  }
}

// ---------------------------------------------------------------------------
// Instruments for the score and the stingers (countdown, lap, finish).
// ---------------------------------------------------------------------------

class Instruments {
  constructor(
    private readonly ctx: AudioContext,
    private readonly white: AudioBuffer,
    private readonly brown: AudioBuffer,
  ) {}

  kick(dest: AudioNode, t: number, vel: number): void {
    const b = new Bag(this.ctx);
    const o = b.osc('sine', 150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    const go = b.gain(0);
    perc(go.gain, t, 0.75 * vel, 0.002, 0.42);
    const n = b.noise(this.white, t);
    const hp = b.filter('highpass', 2500, 0.7);
    const gn = b.gain(0);
    perc(gn.gain, t, 0.12 * vel, 0.0005, 0.012);
    wire(o, go, dest);
    wire(n, hp, gn, dest);
    b.done(t + 0.5);
  }

  snare(dest: AudioNode, t: number, vel: number): void {
    const b = new Bag(this.ctx);
    const n = b.noise(this.white, t);
    const bp = b.filter('bandpass', 3000, 0.7);
    const gn = b.gain(0);
    perc(gn.gain, t, 0.28 * vel, 0.001, 0.16);
    const o = b.osc('triangle', 210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
    const go = b.gain(0);
    perc(go.gain, t, 0.16 * vel, 0.001, 0.08);
    wire(n, bp, gn, dest);
    wire(o, go, dest);
    b.done(t + 0.25);
  }

  hat(dest: AudioNode, t: number, vel: number, open: boolean): void {
    const b = new Bag(this.ctx);
    const n = b.noise(this.white, t);
    const hp = b.filter('highpass', 7000, 0.7);
    const g = b.gain(0);
    const d = open ? 0.28 : 0.035;
    perc(g.gain, t, 0.12 * vel, 0.001, d);
    wire(n, hp, g, dest);
    b.done(t + d + 0.02);
  }

  /** Pitched hand-drum/tom: the "desert percussion" colour of the score. */
  tom(dest: AudioNode, t: number, midi: number, vel: number): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o = b.osc('sine', f * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.07);
    const go = b.gain(0);
    perc(go.gain, t, 0.45 * vel, 0.002, 0.35);
    const n = b.noise(this.brown, t);
    const lp = b.filter('lowpass', 900, 0.7);
    const gn = b.gain(0);
    perc(gn.gain, t, 0.3 * vel, 0.001, 0.06);
    wire(o, go, dest);
    wire(n, lp, gn, dest);
    b.done(t + 0.4);
  }

  /** Snarling synth bass: saw + sub square through a resonant closing lowpass. */
  bass(dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o1 = b.osc('sawtooth', f, t, -5);
    const o2 = b.osc('square', f * 0.5, t);
    const g2 = b.gain(0.5);
    const lp = b.filter('lowpass', Math.min(9000, f * 14), 5, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(90, f * 2.2), t + Math.min(0.18, dur));
    const g = b.gain(0);
    adsr(g.gain, t, 0.16 * vel, 0.004, dur, 0.04);
    o1.connect(lp);
    wire(o2, g2, lp);
    wire(lp, b.shaper(1.6), g, dest);
    b.done(t + dur + 0.1);
  }

  /** Plucked string with a falling pitch bend: an oud-like desert colour. */
  pluck(dest: AudioNode, t: number, midi: number, vel: number): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o1 = b.osc('sawtooth', f * 1.015, t);
    o1.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    const o2 = b.osc('triangle', f * 2.005, t);
    const lp = b.filter('lowpass', f * 10, 2, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.5), t + 0.35);
    const g = b.gain(0);
    perc(g.gain, t, 0.09 * vel, 0.002, 0.7);
    const g2 = b.gain(0);
    perc(g2.gain, t, 0.03 * vel, 0.002, 0.25);
    wire(o1, lp, g, dest);
    wire(o2, g2, dest);
    b.done(t + 0.75);
  }

  /** Dark sustained pad: chorused saws behind a soft lowpass with a slow attack. */
  pad(dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o1 = b.osc('sawtooth', f, t, -9);
    const o2 = b.osc('sawtooth', f, t, 10);
    const lp = b.filter('lowpass', Math.min(2200, Math.max(400, f * 3)), 0.6, t);
    const g = b.gain(0);
    adsr(g.gain, t, 0.035 * vel, Math.min(1.2, dur * 0.4), dur, 0.8);
    o1.connect(lp);
    o2.connect(lp);
    wire(lp, g, dest);
    b.done(t + dur + 1);
  }

  /** Brass section: two detuned saws with an opening filter envelope. */
  brass(dest: AudioNode, t: number, midi: number, dur: number, vel: number, bright: number, atk = 0.05): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o1 = b.osc('sawtooth', f, t, -6);
    const o2 = b.osc('sawtooth', f, t, 7);
    const lp = b.filter('lowpass', f * 0.8, 1.4, t);
    lp.frequency.linearRampToValueAtTime(Math.min(14000, f * (1.5 + 7 * bright * vel)), t + atk * 1.4);
    lp.frequency.setTargetAtTime(Math.min(10000, f * (1.2 + 3.5 * bright * vel)), t + atk * 1.5, 0.25);
    const g = b.gain(0);
    adsr(g.gain, t, 0.085 * vel, atk, dur, 0.2);
    o1.connect(lp);
    o2.connect(lp);
    wire(lp, g, dest);
    b.done(t + Math.max(atk, dur) + 0.45);
  }

  bell(dest: AudioNode, t: number, hz: number, vel: number, decay: number): void {
    const b = new Bag(this.ctx);
    const o1 = b.osc('sine', hz, t);
    const o2 = b.osc('sine', hz * 2.76, t);
    const o3 = b.osc('triangle', hz * 0.5, t);
    const g1 = b.gain(0);
    const g2 = b.gain(0);
    const g3 = b.gain(0);
    perc(g1.gain, t, 0.22 * vel, 0.002, decay);
    perc(g2.gain, t, 0.07 * vel, 0.001, decay * 0.35);
    perc(g3.gain, t, 0.06 * vel, 0.002, decay * 0.6);
    wire(o1, g1, dest);
    wire(o2, g2, dest);
    wire(o3, g3, dest);
    b.done(t + decay + 0.05);
  }

  crash(dest: AudioNode, t: number, vel: number): void {
    const b = new Bag(this.ctx);
    const n = b.noise(this.white, t);
    const hp = b.filter('highpass', 4500, 0.6);
    const g = b.gain(0);
    perc(g.gain, t, 0.13 * vel, 0.004, 2.2);
    wire(n, hp, g, dest);
    b.done(t + 2.3);
  }
}

// ---------------------------------------------------------------------------
// Procedural score: a tense step sequencer. Original material built on a Phrygian-dominant
// scale (the "desert" sound) over a drum + bass ostinato; no existing theme is quoted.
// ---------------------------------------------------------------------------

/** Phrygian dominant degrees (semitones): the flat second and major third give the desert tension. */
const SCALE = [0, 1, 4, 5, 7, 8, 10, 12, 13, 16, 17, 19] as const;

interface Song {
  bpm: number;
  key: number; // midi tonic, bass register
  prog: readonly number[]; // chord root offset per bar, semitones
  swing: number; // fraction of a 16th that odd steps are delayed
  kick: string; // 16 steps: '.' rest, digit = velocity 1..9
  snare: string;
  hat: string;
  open: string;
  fill: string; // toms, only in the last bar of each 4-bar phrase
  bass: readonly (number | null)[]; // semitones over the chord root per 16th, null = rest
  bassLen: number; // steps each bass note lasts
  arp: readonly (number | null)[]; // index into SCALE per 16th, null = rest
  arpOct: number;
  arpFrom: number; // first bar the arp plays
  pad: number; // pad level, 0 = none
}

const SONGS: Record<Exclude<MusicMode, 'off'>, Song> = {
  menu: {
    bpm: 92,
    key: 38,
    prog: [0, 0, 1, 0, 0, 0, -2, 1],
    swing: 0.14,
    kick: '9.........6.....',
    snare: '........6.......',
    hat: '..3...3...3...33',
    open: '................',
    fill: '..........4.5.67',
    bass: [0, null, null, null, null, null, null, null, 0, null, null, 7, null, null, null, null],
    bassLen: 3,
    arp: [0, null, 2, null, 4, null, null, 5, null, 4, null, 2, null, 1, null, null],
    arpOct: 2,
    arpFrom: 2,
    pad: 1,
  },
  race: {
    bpm: 152,
    key: 38,
    prog: [0, 0, 1, 0, 0, 0, -2, 1],
    swing: 0,
    kick: '9..6..9.9..6..7.',
    snare: '....9.......9.5.',
    hat: '6363636363636363',
    open: '..............5.',
    fill: '........5.6.7.89',
    bass: [0, null, 0, 12, 0, null, 0, 13, 0, null, 0, 12, 7, null, 8, 1],
    bassLen: 1,
    arp: [7, null, null, 6, null, null, 4, null, 7, null, null, 6, null, 8, 7, null],
    arpOct: 1,
    arpFrom: 4,
    pad: 0.6,
  },
};

class Track {
  readonly out: GainNode;
  stopAt = Infinity;
  private step = 0;
  private next: number;
  private readonly sd: number;

  constructor(
    private readonly ins: Instruments,
    private readonly song: Song,
    ctx: AudioContext,
    dest: AudioNode,
    start: number,
  ) {
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, start);
    this.out.gain.linearRampToValueAtTime(1, start + 1.5);
    this.out.connect(dest);
    this.next = start;
    this.sd = 60 / song.bpm / 4;
  }

  fadeOut(now: number): void {
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(0, now, 0.5);
    this.stopAt = now + 2.5;
  }

  schedule(now: number, until: number): void {
    // After a stall (background tab, suspended context) resync instead of bursting old steps.
    if (this.next < now - 0.1) this.next = now + 0.02;
    while (this.next < until && this.next < this.stopAt) {
      const swing = this.step % 2 === 1 ? this.song.swing * this.sd : 0;
      this.play(this.step, this.next + swing);
      this.step++;
      this.next += this.sd;
    }
  }

  private play(step: number, t: number): void {
    const sp = this.song;
    const ins = this.ins;
    const out = this.out;
    const sd = this.sd;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const root = sp.key + sp.prog[bar % sp.prog.length];

    const k = sp.kick.charCodeAt(s) - 48;
    if (k > 0 && k <= 9) ins.kick(out, t, k / 9);
    const sn = sp.snare.charCodeAt(s) - 48;
    if (sn > 0 && sn <= 9) ins.snare(out, t, sn / 9);
    const h = sp.hat.charCodeAt(s) - 48;
    if (h > 0 && h <= 9) ins.hat(out, t, h / 9, false);
    const o = sp.open.charCodeAt(s) - 48;
    if (o > 0 && o <= 9) ins.hat(out, t, o / 9, true);
    if (bar % 4 === 3) {
      const f = sp.fill.charCodeAt(s) - 48;
      if (f > 0 && f <= 9) ins.tom(out, t, root + 26 - (s - 8), f / 9);
    }

    const bn = sp.bass[s];
    if (bn !== null && bn !== undefined) ins.bass(out, t, root + bn, sp.bassLen * sd * 0.92, 1);

    if (bar >= sp.arpFrom) {
      const an = sp.arp[s];
      if (an !== null && an !== undefined) ins.pluck(out, t, sp.key + 12 * sp.arpOct + SCALE[an], 1);
    }

    if (sp.pad > 0 && s === 0) {
      const dur = 16 * sd * 1.02;
      ins.pad(out, t, root + 12, dur, sp.pad);
      ins.pad(out, t, root + 19, dur, sp.pad * 0.8);
    }
  }
}

// ---------------------------------------------------------------------------
// Engines: the player's twin turbines (stereo, rich) and one cheap spatial voice per rival.
// ---------------------------------------------------------------------------

/** One of the player's two engines: snarling saw/square stack, rattled and distorted. */
interface EngineSide {
  saw1: OscillatorNode;
  saw2: OscillatorNode;
  sq: OscillatorNode;
  lfo: OscillatorNode; // the ~30-60 Hz amplitude rattle that makes the pod "rip"
  amp: GainNode;
  lfoDepth: GainNode;
  drive: GainNode;
  bp: BiquadFilterNode;
  lp: BiquadFilterNode;
  ratio: number; // the two engines run slightly apart so they beat against each other
}

interface PlayerRig {
  bag: Bag;
  sides: readonly [EngineSide, EngineSide];
  out: GainNode;
  sput: GainNode;
  sputLfo: OscillatorNode;
  sputDepth: GainNode;
  vib: OscillatorNode;
  vibDepth: GainNode;
  whine: OscillatorNode;
  whine2: OscillatorNode;
  gWhine: GainNode;
  roarBp: BiquadFilterNode;
  gRoar: GainNode;
  boostA: OscillatorNode;
  boostB: OscillatorNode;
  boostBp: BiquadFilterNode;
  gBoost: GainNode;
  rumbleLp: BiquadFilterNode;
  gRumble: GainNode;
  scrapeBp: BiquadFilterNode;
  gScrape: GainNode;
  windLp: BiquadFilterNode;
  gWind: GainNode;
}

interface RivalVoice {
  key: EngineVoice;
  base: number; // per-rival fundamental so every pod has its own voice
  bag: Bag;
  o1: OscillatorNode;
  o2: OscillatorNode;
  lfo: OscillatorNode;
  amp: GainNode;
  lfoDepth: GainNode;
  lp: BiquadFilterNode;
  g: GainNode;
  pan: PannerNode;
  seen: number;
  idle: number;
}

interface Core {
  ctx: AudioContext;
  master: GainNode;
  sfx: GainNode;
  stinger: GainNode; // musical cues (countdown, laps, finish): dry + reverb, never culled
  music: GainNode;
  verb: GainNode;
  racing: GainNode; // engines + wind + rivals, faded by setRacing()
  rivals: GainNode;
  white: AudioBuffer;
  brown: AudioBuffer;
  ins: Instruments;
}

export class GameAudio {
  private c: Core | null = null;
  private volume = 0.8;
  private racingOn = false;
  private wantMusic: MusicMode = 'off';
  private curMusic: MusicMode = 'off';
  private tracks: Track[] = [];
  private player: PlayerRig | null = null;
  private readonly rivalMap = new WeakMap<EngineVoice, RivalVoice>();
  private readonly rivalList: RivalVoice[] = [];
  private frame = 0;
  private shots = 0;

  /** Create/resume the AudioContext; call from a user gesture (first click/key). Safe to call repeatedly. */
  unlock(): void {
    if (this.c) {
      if (this.c.ctx.state === 'suspended') void this.c.ctx.resume();
      return;
    }
    if (typeof AudioContext === 'undefined') return;
    this.c = this.create(new AudioContext({ latencyHint: 'interactive' }));
    if (this.c.ctx.state === 'suspended') void this.c.ctx.resume();
    // Music must keep flowing when the game loop does not call update() (menus, pause).
    setInterval(() => this.pump(), 100);
    const want = this.wantMusic;
    this.wantMusic = 'off';
    this.music(want);
  }

  private create(ctx: AudioContext): Core {
    const sr = ctx.sampleRate;
    const white = ctx.createBuffer(1, Math.floor(sr * 2), sr);
    const wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    const brown = ctx.createBuffer(1, Math.floor(sr * 4), sr);
    const bd = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bd.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      bd[i] = last * 3.5;
    }

    // Procedural reverb impulse: short, bright open-air slap that darkens as it decays
    // (a desert arena, not a cathedral).
    const irLen = Math.floor(sr * 1.8);
    const ir = ctx.createBuffer(2, irLen, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const x = i / irLen;
        lp += (0.9 - 0.85 * x) * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.pow(1 - x, 3.5);
      }
    }

    // Glue compressor + makeup + brickwall limiter: dozens of layered engines and explosions
    // must never clip the output.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.4;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    const master = ctx.createGain();
    master.gain.value = this.volume;
    wire(master, comp, makeup, limiter, ctx.destination);

    const verb = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.55;
    wire(verb, conv, verbOut, master);

    const sfx = ctx.createGain();
    sfx.gain.value = 0.9;
    sfx.connect(master);

    const stinger = ctx.createGain();
    stinger.gain.value = 0.9;
    stinger.connect(master);
    const stingerSend = ctx.createGain();
    stingerSend.gain.value = 0.35;
    wire(stinger, stingerSend, verb);

    const music = ctx.createGain();
    music.gain.value = 0.45;
    music.connect(master);
    const musicSend = ctx.createGain();
    musicSend.gain.value = 0.3;
    wire(music, musicSend, verb);

    const racing = ctx.createGain();
    racing.gain.value = this.racingOn ? 1 : 0;
    racing.connect(master);
    const rivals = ctx.createGain();
    rivals.gain.value = 0.9;
    rivals.connect(racing);

    return { ctx, master, sfx, stinger, music, verb, racing, rivals, white, brown, ins: new Instruments(ctx, white, brown) };
  }

  setVolume(v: number): void {
    this.volume = clamp01(v);
    const c = this.c;
    if (c) c.master.gain.setTargetAtTime(this.volume, c.ctx.currentTime, 0.05);
  }

  /** Engines/wind audible (racing) or silenced (menus, pause). Smooth fade. */
  setRacing(on: boolean): void {
    this.racingOn = on;
    const c = this.c;
    if (c) c.racing.gain.setTargetAtTime(on ? 1 : 0, c.ctx.currentTime, on ? 0.35 : 0.2);
  }

  // ---- per-frame engines ---------------------------------------------------

  update(dt: number, listener: THREE.Object3D, listenerVel: THREE.Vector3, player: PlayerAudioState, rivals: readonly EngineVoice[]): void {
    const c = this.c;
    if (!c) return;
    const now = c.ctx.currentTime;
    this.pump();

    // Listener from the camera's world matrix (column-major): position, -Z forward, +Y up.
    const e = listener.matrixWorld.elements;
    const lx = e[12];
    const ly = e[13];
    const lz = e[14];
    const fl = Math.hypot(e[8], e[9], e[10]) || 1;
    const ul = Math.hypot(e[4], e[5], e[6]) || 1;
    const al = c.ctx.listener;
    // Firefox has no AudioParam-based listener: fall back to the legacy setters there.
    if (al.positionX) {
      al.positionX.setTargetAtTime(lx, now, 0.02);
      al.positionY.setTargetAtTime(ly, now, 0.02);
      al.positionZ.setTargetAtTime(lz, now, 0.02);
      al.forwardX.setTargetAtTime(-e[8] / fl, now, 0.02);
      al.forwardY.setTargetAtTime(-e[9] / fl, now, 0.02);
      al.forwardZ.setTargetAtTime(-e[10] / fl, now, 0.02);
      al.upX.setTargetAtTime(e[4] / ul, now, 0.02);
      al.upY.setTargetAtTime(e[5] / ul, now, 0.02);
      al.upZ.setTargetAtTime(e[6] / ul, now, 0.02);
    } else {
      al.setPosition(lx, ly, lz);
      al.setOrientation(-e[8] / fl, -e[9] / fl, -e[10] / fl, e[4] / ul, e[5] / ul, e[6] / ul);
    }

    this.updatePlayer(c, now, player);

    this.frame++;
    for (let i = 0; i < rivals.length; i++) {
      const r = rivals[i];
      let v = this.rivalMap.get(r);
      if (!v) {
        v = this.makeRival(c, r, this.rivalList.length);
        this.rivalMap.set(r, v);
        this.rivalList.push(v);
      }
      v.seen = this.frame;
      v.idle = 0;
      this.updateRival(v, now, lx, ly, lz, listenerVel);
    }
    // Rivals that left the array (new race, new objects): silence, then release their nodes.
    for (let i = this.rivalList.length - 1; i >= 0; i--) {
      const v = this.rivalList[i];
      if (v.seen === this.frame) continue;
      if (v.idle === 0) v.g.gain.setTargetAtTime(0, now, 0.1);
      v.idle += dt;
      if (v.idle > RIVAL_FORGET) {
        v.bag.kill(now + 0.05);
        this.rivalMap.delete(v.key);
        this.rivalList.splice(i, 1);
      }
    }
  }

  private makeSide(b: Bag, now: number, ratio: number, pan: number, dest: AudioNode): EngineSide {
    const saw1 = b.osc('sawtooth', 80, now, -7);
    const saw2 = b.osc('sawtooth', 80, now, 11);
    const sq = b.osc('square', 160, now, -4);
    const gSq = b.gain(0.45);
    const mix = b.gain(0.5);
    saw1.connect(mix);
    saw2.connect(mix);
    wire(sq, gSq, mix);
    const amp = b.gain(0.7);
    const lfo = b.osc('square', 35, now);
    const lfoDepth = b.gain(0.3);
    wire(lfo, lfoDepth, amp.gain);
    const drive = b.gain(1);
    const bp = b.filter('bandpass', 900, 0.8);
    const lp = b.filter('lowpass', 4000, 0.7);
    wire(mix, amp, drive, b.shaper(3.5, '2x'), bp, lp, b.stereo(pan), dest);
    return { saw1, saw2, sq, lfo, amp, lfoDepth, drive, bp, lp, ratio };
  }

  private makePlayer(c: Core): PlayerRig {
    const now = c.ctx.currentTime;
    const b = new Bag(c.ctx);
    const out = b.gain(0.35);
    // Overheat sputter: a square LFO chops the whole engine when heat is critical.
    const sput = b.gain(1);
    const sputLfo = b.osc('square', 9, now);
    const sputDepth = b.gain(0);
    wire(sputLfo, sputDepth, sput.gain);
    wire(sput, out, c.racing);

    const left = this.makeSide(b, now, 1, -0.4, sput);
    const right = this.makeSide(b, now, 1.011, 0.4, sput);

    // Turbine whine: high sines riding on the engine pitch.
    const whine = b.osc('sine', 600, now);
    const whine2 = b.osc('triangle', 900, now);
    const gW2 = b.gain(0.35);
    const gWhine = b.gain(0.02);
    whine.connect(gWhine);
    wire(whine2, gW2, gWhine);
    gWhine.connect(sput);

    // Strain vibrato on every pitched layer (deepens with heat).
    const vib = b.osc('sine', 7, now);
    const vibDepth = b.gain(6);
    vib.connect(vibDepth);
    for (const s of [left, right]) {
      vibDepth.connect(s.saw1.detune);
      vibDepth.connect(s.saw2.detune);
      vibDepth.connect(s.sq.detune);
    }
    vibDepth.connect(whine.detune);
    vibDepth.connect(whine2.detune);

    // Exhaust roar: band-limited brown noise.
    const rn = b.noise(c.brown, now);
    const roarBp = b.filter('bandpass', 400, 0.8);
    const gRoar = b.gain(0.05);
    wire(rn, roarBp, gRoar, sput);

    // Boost scream: high distorted stack that only opens while boosting.
    const boostA = b.osc('sawtooth', 300, now);
    const boostB = b.osc('square', 400, now, 9);
    const bMix = b.gain(0.5);
    boostA.connect(bMix);
    boostB.connect(bMix);
    const boostBp = b.filter('bandpass', 2500, 1.4);
    const gBoost = b.gain(0);
    wire(bMix, b.shaper(4, '2x'), boostBp, gBoost, sput);

    // Ground rumble: repulsor wash over the sand (stronger off track, gone when airborne).
    const gn = b.noise(c.brown, now, 0.8);
    const rumbleLp = b.filter('lowpass', 150, 0.8);
    const gRumble = b.gain(0);
    wire(gn, rumbleLp, gRumble, c.racing);

    // Metal scrape against walls: gritty band of distorted noise, chattered by a fast LFO.
    const sn = b.noise(c.white, now, 0.9);
    const scrapeBp = b.filter('bandpass', 2800, 2.5);
    const chatter = b.gain(0.6);
    const chLfo = b.osc('square', 23, now);
    const chDepth = b.gain(0.4);
    wire(chLfo, chDepth, chatter.gain);
    const gScrape = b.gain(0);
    wire(sn, scrapeBp, b.shaper(3), chatter, gScrape, c.racing);

    // Wind: rises with the square of speed; a slow gust LFO keeps it alive.
    const wn = b.noise(c.white, now, 0.7);
    const whp = b.filter('highpass', 200, 0.7);
    const windLp = b.filter('lowpass', 800, 0.6);
    const gust = b.gain(0.8);
    const gLfo = b.osc('sine', 0.23, now);
    const gDepth = b.gain(0.2);
    wire(gLfo, gDepth, gust.gain);
    const gWind = b.gain(0);
    wire(wn, whp, windLp, gust, gWind, c.racing);

    return {
      bag: b,
      sides: [left, right],
      out,
      sput,
      sputLfo,
      sputDepth,
      vib,
      vibDepth,
      whine,
      whine2,
      gWhine,
      roarBp,
      gRoar,
      boostA,
      boostB,
      boostBp,
      gBoost,
      rumbleLp,
      gRumble,
      scrapeBp,
      gScrape,
      windLp,
      gWind,
    };
  }

  private updatePlayer(c: Core, now: number, p: PlayerAudioState): void {
    if (!this.player) this.player = this.makePlayer(c);
    const r = this.player;
    const s = clamp01(p.speed / MAX_SPEED);
    const th = clamp01(p.throttle);
    const b = p.boost ? 1 : 0;
    const hk = smooth(0.7, 1, p.heat);

    // Pitch tracks speed first (turbine spool) and throttle second (load).
    const f = (58 + 165 * s + 30 * th) * (1 + 0.12 * b);
    const rattle = 28 + 34 * s + 10 * b;
    const am = Math.min(0.5, 0.18 + 0.27 * th + 0.15 * hk);
    const drive = 0.6 + 1.6 * th + 0.8 * b;
    const bp = f * (5 + 4 * th) + 600 * b;
    const lp = 2500 + 5000 * s + 3000 * b + (p.airborne ? 1500 : 0);
    for (let i = 0; i < 2; i++) {
      const e = r.sides[i];
      const fe = f * e.ratio;
      e.saw1.frequency.setTargetAtTime(fe, now, TAU);
      e.saw2.frequency.setTargetAtTime(fe, now, TAU);
      e.sq.frequency.setTargetAtTime(fe * 2, now, TAU);
      e.lfo.frequency.setTargetAtTime(rattle * e.ratio * (i === 0 ? 1 : 1.07), now, TAU);
      e.amp.gain.setTargetAtTime(1 - am, now, TAU);
      e.lfoDepth.gain.setTargetAtTime(am, now, TAU);
      e.drive.gain.setTargetAtTime(drive, now, TAU);
      e.bp.frequency.setTargetAtTime(bp, now, TAU);
      e.lp.frequency.setTargetAtTime(lp, now, TAU);
    }
    r.out.gain.setTargetAtTime(0.22 + 0.2 * th + 0.1 * s, now, TAU);
    r.sput.gain.setTargetAtTime(1 - 0.35 * hk, now, TAU);
    r.sputDepth.gain.setTargetAtTime(0.35 * hk, now, TAU);
    r.sputLfo.frequency.setTargetAtTime(9 + 6 * hk, now, 0.2);
    r.vib.frequency.setTargetAtTime(7 + 5 * hk, now, 0.2);
    r.vibDepth.gain.setTargetAtTime(6 + 40 * hk, now, 0.2);
    r.whine.frequency.setTargetAtTime(f * 7.1, now, TAU);
    r.whine2.frequency.setTargetAtTime(f * 10.7, now, TAU);
    r.gWhine.gain.setTargetAtTime(0.012 + 0.05 * s * th + 0.03 * b, now, TAU);
    r.roarBp.frequency.setTargetAtTime(250 + 1400 * s, now, TAU);
    r.gRoar.gain.setTargetAtTime(0.05 + 0.25 * th * (0.3 + 0.7 * s), now, TAU);
    r.boostA.frequency.setTargetAtTime(f * 3, now, TAU);
    r.boostB.frequency.setTargetAtTime(f * 4.03, now, TAU);
    r.boostBp.frequency.setTargetAtTime(f * 8 + 800, now, TAU);
    r.gBoost.gain.setTargetAtTime(0.22 * b, now, p.boost ? 0.06 : 0.35);

    const rumble = p.airborne ? 0 : p.offTrack ? 0.25 + 0.5 * s : 0.06 + 0.12 * s;
    r.gRumble.gain.setTargetAtTime(rumble, now, 0.08);
    r.rumbleLp.frequency.setTargetAtTime((p.offTrack ? 500 : 90) + 300 * s, now, TAU);
    const scrape = p.scraping ? 0.12 + 0.35 * clamp01(p.speed / 120) : 0;
    r.gScrape.gain.setTargetAtTime(scrape, now, p.scraping ? 0.03 : 0.12);
    r.scrapeBp.frequency.setTargetAtTime(1800 + 2500 * s, now, TAU);
    r.gWind.gain.setTargetAtTime(0.015 + 0.3 * s * s + (p.airborne ? 0.05 : 0), now, 0.15);
    r.windLp.frequency.setTargetAtTime(600 + 7000 * s, now, 0.15);
  }

  private makeRival(c: Core, key: EngineVoice, index: number): RivalVoice {
    const now = c.ctx.currentTime;
    const b = new Bag(c.ctx);
    // Golden-ratio spread keeps every rival's fundamental distinct from its neighbours.
    const base = 52 + 40 * ((index * 0.618034) % 1);
    const o1 = b.osc('sawtooth', base, now, -6);
    const o2 = b.osc('square', base * 1.5, now, 8);
    const g2 = b.gain(0.4);
    const amp = b.gain(0.7);
    const lfo = b.osc('square', 40, now);
    const lfoDepth = b.gain(0.3);
    wire(lfo, lfoDepth, amp.gain);
    o1.connect(amp);
    wire(o2, g2, amp);
    const lp = b.filter('lowpass', 2000, 0.8);
    const g = b.gain(0);
    const pan = b.add(c.ctx.createPanner());
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = RIVAL_REF;
    pan.maxDistance = 5000;
    pan.rolloffFactor = 1.2;
    pan.positionX.value = key.pos.x;
    pan.positionY.value = key.pos.y;
    pan.positionZ.value = key.pos.z;
    wire(amp, b.shaper(2.5), lp, g, pan, c.rivals);
    return { key, base, bag: b, o1, o2, lfo, amp, lfoDepth, lp, g, pan, seen: 0, idle: 0 };
  }

  private updateRival(v: RivalVoice, now: number, lx: number, ly: number, lz: number, lv: THREE.Vector3): void {
    const r = v.key;
    const dx = r.pos.x - lx;
    const dy = r.pos.y - ly;
    const dz = r.pos.z - lz;
    const d = Math.hypot(dx, dy, dz);
    // Manual doppler from radial velocities: the PannerNode has none, and we want the classic
    // "neeeoww" exaggerated just enough to read at racing speeds.
    let dop = 1;
    if (d > 0.01) {
      const vsAway = (r.vel.x * dx + r.vel.y * dy + r.vel.z * dz) / d;
      const vlToward = (lv.x * dx + lv.y * dy + lv.z * dz) / d;
      dop = (SPEED_OF_SOUND + vlToward) / Math.max(SPEED_OF_SOUND * 0.3, SPEED_OF_SOUND + vsAway);
      dop = dop < 0.5 ? 0.5 : dop > 2 ? 2 : dop;
    }
    const speed = Math.hypot(r.vel.x, r.vel.y, r.vel.z);
    const s = clamp01(speed / MAX_SPEED);
    const th = clamp01(r.throttle);
    const f = v.base * (1 + 1.8 * s + 0.25 * th) * (r.boost ? 1.1 : 1) * dop;
    v.o1.frequency.setTargetAtTime(f, now, 0.04);
    v.o2.frequency.setTargetAtTime(f * 1.5, now, 0.04);
    v.lfo.frequency.setTargetAtTime((30 + 25 * s) * dop, now, 0.04);
    const am = 0.2 + 0.25 * th;
    v.amp.gain.setTargetAtTime(1 - am, now, TAU);
    v.lfoDepth.gain.setTargetAtTime(am, now, TAU);
    // Air absorption: distant pods lose their top end before they lose their level.
    v.lp.frequency.setTargetAtTime(300 + (1200 + 5000 * th + (r.boost ? 2000 : 0)) / (1 + d / 250), now, TAU);
    const level = r.alive && d < 2500 ? 0.25 + 0.35 * th : 0;
    v.g.gain.setTargetAtTime(level, now, r.alive ? 0.08 : 0.05);
    v.pan.positionX.setTargetAtTime(r.pos.x, now, 0.02);
    v.pan.positionY.setTargetAtTime(r.pos.y, now, 0.02);
    v.pan.positionZ.setTargetAtTime(r.pos.z, now, 0.02);
  }

  // ---- one-shot effects ----------------------------------------------------

  /** Allocate a one-shot routed to the effects bus (and optionally the reverb); null when culled. */
  private shot(c: Core, level: number, important: boolean, wet = 0): Shot | null {
    if (!important && this.shots >= MAX_SHOTS) return null;
    const v = new Shot(c.ctx, level);
    v.out.connect(c.sfx);
    if (wet > 0) {
      const w = v.gain(wet);
      wire(v.out, w, c.verb);
    }
    this.shots++;
    v.onFree = () => {
      this.shots--;
    };
    return v;
  }

  impact(strength: number): void {
    const c = this.c;
    if (!c) return;
    const k = clamp01(strength);
    const v = this.shot(c, 0.3 + 0.7 * k, k > 0.6, 0.08);
    if (!v) return;
    const t = c.ctx.currentTime;
    const ring = 0.3 + 0.6 * k;
    const tail = 0.4 + 0.5 * k;
    // Body thump.
    const th = v.osc('sine', 130, t);
    th.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const tg = v.gain(0);
    perc(tg.gain, t, 1, 0.002, 0.3);
    wire(th, tg, v.out);
    // Crunch.
    const n = v.noise(c.white, t);
    const bp = v.filter('bandpass', 900, 0.9);
    const cg = v.gain(0);
    perc(cg.gain, t, 0.9, 0.001, 0.12 + 0.25 * k);
    wire(n, bp, v.shaper(4), cg, v.out);
    // Inharmonic metal partials: the hull ringing.
    for (const f of [430, 1170, 1980, 3150]) {
      const o = v.osc('sine', f * rand(0.96, 1.04), t);
      const g = v.gain(0);
      perc(g.gain, t, 0.08, 0.001, ring);
      wire(o, g, v.out);
    }
    // Scrape tail sliding down in pitch as the pod grinds off the obstacle.
    const sn = v.noise(c.white, t);
    const sbp = v.filter('bandpass', 2600, 3, t);
    sbp.frequency.exponentialRampToValueAtTime(1200, t + tail);
    const sg = v.gain(0);
    perc(sg.gain, t, 0.3 * k + 0.05, 0.01, tail);
    wire(sn, sbp, v.shaper(2.5), sg, v.out);
    // Sparks.
    const kn = v.noise(c.white, t);
    const hp = v.filter('highpass', 4000, 0.7);
    const kg = v.gain(0);
    let tp = t + 0.03;
    const end = t + 0.15 + 0.5 * k;
    for (let i = 0; i < 14 && tp < end; i++) {
      kg.gain.setValueAtTime(rand(0.1, 0.4), tp);
      kg.gain.setTargetAtTime(0, tp + 0.002, 0.008);
      tp += rand(0.015, 0.06);
    }
    wire(kn, hp, kg, v.out);
    v.done(t + Math.max(ring, tail) + 0.1);
  }

  explosion(distance: number): void {
    const c = this.c;
    if (!c) return;
    const d = Math.max(0, distance);
    const att = 40 / (40 + Math.max(0, d - 40));
    if (att < 0.01) return;
    const v = this.shot(c, 0.95 * att, att > 0.3, 0.3);
    if (!v) return;
    // Sound travels: a far blast is seen before it is heard (capped so it still reads as one event).
    const t = c.ctx.currentTime + Math.min(0.6, d / SPEED_OF_SOUND);
    const dur = 2.6;
    const far = 1 / (1 + d / 300); // air absorption darkens distant blasts
    // Initial crack.
    const cn = v.noise(c.white, t);
    const chp = v.filter('highpass', 1200, 0.7);
    const cg = v.gain(0);
    perc(cg.gain, t, 0.7 * far, 0.002, 0.18);
    wire(cn, chp, cg, v.out);
    // Body: brown noise through a closing lowpass, plus secondary booms.
    const bn = v.noise(c.brown, t, rand(0.8, 1.15));
    const lp = v.filter('lowpass', 3200 * far + 200, 0.9, t);
    lp.frequency.exponentialRampToValueAtTime(110, t + dur * 0.85);
    const bg = v.gain(0);
    perc(bg.gain, t, 1, 0.006, dur);
    wire(bn, bg, lp);
    for (let i = 0; i < 3; i++) {
      const tb = t + rand(0.15, dur * 0.5);
      const g2 = v.gain(0);
      perc(g2.gain, tb, rand(0.4, 0.8), 0.01, Math.min(dur * 0.4, t + dur - tb));
      wire(bn, g2, lp);
    }
    wire(lp, v.shaper(1.5), v.out);
    // Sub thump.
    const so = v.osc('sine', 85, t);
    so.frequency.exponentialRampToValueAtTime(30, t + dur * 0.5);
    const sg = v.gain(0);
    perc(sg.gain, t, 1, 0.005, dur * 0.6);
    wire(so, sg, v.out);
    // Debris crackle (times ascend so the setValueAtTime events stay ordered).
    const dn = v.noise(c.white, t);
    const bp = v.filter('bandpass', 2800, 0.9);
    const dg = v.gain(0);
    let tp = t + 0.05;
    for (let i = 0; i < 18; i++) {
      tp += rand(0.01, dur * 0.07);
      dg.gain.setValueAtTime(rand(0.1, 0.35) * far, tp);
      dg.gain.setTargetAtTime(0, tp + 0.002, 0.012);
    }
    wire(dn, bp, dg, v.out);
    v.done(t + dur + 0.15);
  }

  nearMiss(): void {
    const c = this.c;
    if (!c) return;
    const v = this.shot(c, 0.55, false);
    if (!v) return;
    const t = c.ctx.currentTime;
    const mid = t + 0.16;
    const end = t + 0.55;
    const side = Math.random() < 0.5 ? -1 : 1;
    const pan = v.stereo(0);
    pan.pan.setValueAtTime(0.8 * side, t);
    pan.pan.linearRampToValueAtTime(-0.8 * side, end);
    pan.connect(v.out);
    // Air whoosh.
    const n = v.noise(c.white, t);
    const bp = v.filter('bandpass', 600, 1.4, t);
    bp.frequency.exponentialRampToValueAtTime(3200, mid);
    bp.frequency.exponentialRampToValueAtTime(700, end);
    const ng = v.gain(0);
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.8, mid);
    ng.gain.exponentialRampToValueAtTime(0.001, end);
    wire(n, bp, ng, pan);
    // The other pod's engine dropping pitch as it flashes past.
    const o = v.osc('sawtooth', 280, t);
    o.frequency.exponentialRampToValueAtTime(300, mid);
    o.frequency.exponentialRampToValueAtTime(150, end);
    const og = v.gain(0);
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.35, mid);
    og.gain.exponentialRampToValueAtTime(0.001, end);
    wire(o, v.shaper(3), v.filter('lowpass', 2500, 1), og, pan);
    v.done(end + 0.02);
  }

  /** Tusken scope glint: a thin rising ring, the warning before the shot. */
  sniperGlint(): void {
    const c = this.c;
    if (!c) return;
    const v = this.shot(c, 0.4, true);
    if (!v) return;
    const t = c.ctx.currentTime;
    const o = v.osc('sine', 2400, t);
    o.frequency.exponentialRampToValueAtTime(4200, t + 0.8);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    wire(o, g, v.out);
    v.done(t + 0.95);
  }

  /** Slugthrower crack, quieter and duller with distance (m). */
  gunshot(distance: number): void {
    const c = this.c;
    if (!c) return;
    const v = this.shot(c, 0.6, false);
    if (!v) return;
    const far = 1 / (1 + distance / 150);
    const t = c.ctx.currentTime + Math.min(distance / 343, 0.5);
    const n = v.noise(c.white, t);
    const bp = v.filter('bandpass', 2600 * (0.4 + far), 0.9, t);
    const g = v.gain(0);
    perc(g.gain, t, 0.9 * far + 0.1, 0.001, 0.18);
    wire(n, bp, g, v.out);
    const th = v.osc('sine', 160, t);
    th.frequency.exponentialRampToValueAtTime(50, t + 0.2);
    const tg = v.gain(0);
    perc(tg.gain, t, 0.6 * far, 0.002, 0.25);
    wire(th, tg, v.out);
    v.done(t + 0.4);
  }

  /** Sebulba's flame vent: a roaring gas burst. */
  flame(): void {
    const c = this.c;
    if (!c) return;
    const v = this.shot(c, 0.7, true);
    if (!v) return;
    const t = c.ctx.currentTime;
    const n = v.noise(c.brown, t);
    const lp = v.filter('lowpass', 500, 0.8, t);
    lp.frequency.linearRampToValueAtTime(2200, t + 0.2);
    lp.frequency.linearRampToValueAtTime(700, t + 1.1);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.08);
    g.gain.setValueAtTime(0.8, t + 0.9);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.25);
    wire(n, lp, v.shaper(2), g, v.out);
    v.done(t + 1.3);
  }

  boost(): void {
    const c = this.c;
    if (!c) return;
    const v = this.shot(c, 0.7, true, 0.1);
    if (!v) return;
    const t = c.ctx.currentTime;
    // Ignition thump.
    const th = v.osc('sine', 95, t);
    th.frequency.exponentialRampToValueAtTime(38, t + 0.3);
    const tg = v.gain(0);
    perc(tg.gain, t, 1, 0.003, 0.35);
    wire(th, tg, v.out);
    // Whoomp: brown noise through an opening lowpass.
    const n = v.noise(c.brown, t);
    const lp = v.filter('lowpass', 300, 1.2, t);
    lp.frequency.exponentialRampToValueAtTime(3000, t + 0.25);
    const ng = v.gain(0);
    perc(ng.gain, t, 0.9, 0.02, 0.6);
    wire(n, lp, ng, v.out);
    // Rising scream.
    const bp = v.filter('bandpass', 800, 1.5, t);
    bp.frequency.exponentialRampToValueAtTime(3500, t + 0.4);
    const sg = v.gain(0);
    perc(sg.gain, t, 0.35, 0.03, 0.55);
    for (const det of [-10, 12]) {
      const o = v.osc('sawtooth', 220, t, det);
      o.frequency.exponentialRampToValueAtTime(1100, t + 0.4);
      o.connect(bp);
    }
    wire(bp, v.shaper(3), sg, v.out);
    v.done(t + 0.75);
  }

  overheat(): void {
    const c = this.c;
    if (!c) return;
    const v = this.shot(c, 0.45, true);
    if (!v) return;
    const t = c.ctx.currentTime;
    // Two-tone warble alarm.
    const o = v.osc('square', 950, t);
    for (let i = 1; i < 16; i++) o.frequency.setValueAtTime(i % 2 ? 700 : 950, t + i * 0.07);
    const lp = v.filter('lowpass', 3000, 0.7);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.01);
    g.gain.setValueAtTime(0.35, t + 1.0);
    g.gain.linearRampToValueAtTime(0, t + 1.12);
    wire(o, lp, g, v.out);
    // Steam hiss venting from the overheated turbines.
    const n = v.noise(c.white, t);
    const hp = v.filter('highpass', 3500, 0.7);
    const bp = v.filter('bandpass', 6000, 0.8, t);
    bp.frequency.exponentialRampToValueAtTime(3000, t + 1.6);
    const ng = v.gain(0);
    perc(ng.gain, t, 0.6, 0.05, 1.6);
    wire(n, hp, bp, ng, v.out);
    // Relief-valve pop.
    const p = v.osc('sine', 220, t);
    p.frequency.exponentialRampToValueAtTime(70, t + 0.12);
    const pg = v.gain(0);
    perc(pg.gain, t, 0.6, 0.002, 0.15);
    wire(p, pg, v.out);
    v.done(t + 1.75);
  }

  roll(): void {
    const c = this.c;
    if (!c) return;
    const v = this.shot(c, 0.55, false);
    if (!v) return;
    const t = c.ctx.currentTime;
    const end = t + 0.75;
    const side = Math.random() < 0.5 ? -1 : 1;
    const pan = v.stereo(0);
    pan.pan.setValueAtTime(-0.8 * side, t);
    pan.pan.linearRampToValueAtTime(0.8 * side, end);
    pan.connect(v.out);
    const n = v.noise(c.white, t);
    const bp = v.filter('bandpass', 400, 2, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.3);
    bp.frequency.exponentialRampToValueAtTime(500, end);
    const ng = v.gain(0);
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.8, t + 0.28);
    ng.gain.exponentialRampToValueAtTime(0.001, end);
    wire(n, bp, ng, pan);
    // Engine note swinging as the turbines rotate around the cockpit.
    const o = v.osc('sawtooth', 180, t);
    o.frequency.exponentialRampToValueAtTime(240, t + 0.3);
    o.frequency.exponentialRampToValueAtTime(150, end);
    const og = v.gain(0);
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.2, t + 0.3);
    og.gain.exponentialRampToValueAtTime(0.001, end);
    wire(o, v.filter('lowpass', 1500, 1), og, pan);
    v.done(end + 0.02);
  }

  // ---- musical cues ----------------------------------------------------------

  countdown(n: number): void {
    const c = this.c;
    if (!c) return;
    const t = c.ctx.currentTime;
    const ins = c.ins;
    if (n > 0) {
      ins.bell(c.stinger, t, 587.33, 0.9, 0.35);
      const b = new Bag(c.ctx);
      const o = b.osc('square', 587.33, t);
      const g = b.gain(0);
      perc(g.gain, t, 0.08, 0.003, 0.2);
      wire(o, b.filter('lowpass', 2500, 0.7), g, c.stinger);
      b.done(t + 0.25);
    } else {
      ins.bell(c.stinger, t, 1174.66, 1, 0.9);
      ins.bell(c.stinger, t, 587.33, 0.7, 0.9);
      ins.brass(c.stinger, t, 62, 0.5, 1, 1, 0.01);
      ins.brass(c.stinger, t, 69, 0.5, 0.9, 1, 0.01);
      ins.kick(c.stinger, t, 1);
      ins.crash(c.stinger, t, 1);
    }
  }

  lap(final: boolean): void {
    const c = this.c;
    if (!c) return;
    const t = c.ctx.currentTime;
    const ins = c.ins;
    if (!final) {
      const notes = [587.33, 880, 1174.66];
      for (let i = 0; i < notes.length; i++) ins.bell(c.stinger, t + i * 0.09, notes[i], 0.8, 0.8);
      return;
    }
    // Final lap: urgent repeated figure plus a brass stab.
    const notes = [880, 1174.66, 880, 1174.66, 1567.98];
    for (let i = 0; i < notes.length; i++) ins.bell(c.stinger, t + i * 0.08, notes[i], 0.85, i === 4 ? 1.1 : 0.3);
    for (const m of [62, 66, 69]) ins.brass(c.stinger, t + 0.4, m, 0.6, 1, 0.9, 0.02);
    ins.tom(c.stinger, t + 0.4, 50, 1);
  }

  finish(won: boolean): void {
    const c = this.c;
    if (!c) return;
    const t = c.ctx.currentTime;
    const ins = c.ins;
    if (won) {
      // Triumphant rising fanfare into a held major chord.
      const run = [62, 66, 69];
      for (let i = 0; i < run.length; i++) ins.brass(c.stinger, t + i * 0.14, run[i], 0.13, 1, 1, 0.015);
      const th = t + 0.42;
      for (const m of [62, 66, 69, 74]) ins.brass(c.stinger, th, m, 1.6, 1, 1, 0.04);
      ins.brass(c.stinger, th, 50, 1.6, 0.8, 0.6, 0.04);
      ins.kick(c.stinger, th, 1);
      ins.crash(c.stinger, th, 1);
      ins.bell(c.stinger, th, 1174.66, 0.7, 1.6);
    } else {
      // Respectful but deflated: falling minor line over a dark chord.
      const run = [62, 60, 58, 57];
      for (let i = 0; i < run.length; i++) ins.brass(c.stinger, t + i * 0.24, run[i], 0.3, 0.75, 0.5, 0.05);
      const th = t + 0.96;
      for (const m of [50, 57, 62, 65]) ins.brass(c.stinger, th, m, 1.4, 0.7, 0.4, 0.15);
      ins.tom(c.stinger, th, 38, 0.9);
    }
  }

  ui(kind: 'select' | 'confirm'): void {
    const c = this.c;
    if (!c) return;
    const t = c.ctx.currentTime;
    const v = this.shot(c, 0.25, true);
    if (!v) return;
    const note = (at: number, f: number, d: number): void => {
      const o = v.osc('triangle', f, at);
      const g = v.gain(0);
      perc(g.gain, at, 0.8, 0.004, d);
      wire(o, g, v.out);
    };
    if (kind === 'select') {
      note(t, 1400, 0.06);
      v.done(t + 0.1);
    } else {
      note(t, 880, 0.1);
      note(t + 0.08, 1320, 0.18);
      v.done(t + 0.3);
    }
  }

  // ---- music ------------------------------------------------------------------

  /** Simple procedural music bed for menus and race (drums + bass ostinato, tense); on/off with fade. */
  music(mode: MusicMode): void {
    const c = this.c;
    if (!c) {
      this.wantMusic = mode;
      return;
    }
    if (mode === this.curMusic) return;
    this.curMusic = mode;
    const now = c.ctx.currentTime;
    for (let i = 0; i < this.tracks.length; i++) if (this.tracks[i].stopAt === Infinity) this.tracks[i].fadeOut(now);
    if (mode !== 'off') this.tracks.push(new Track(c.ins, SONGS[mode], c.ctx, c.music, now + 0.05));
    this.pump();
  }

  /** Lookahead scheduler: music notes are placed on AudioContext time, never on frame time. */
  private pump(): void {
    const c = this.c;
    if (!c || c.ctx.state !== 'running') return;
    const now = c.ctx.currentTime;
    const until = now + LOOKAHEAD;
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const tr = this.tracks[i];
      if (now > tr.stopAt + 1) {
        tr.out.disconnect();
        this.tracks.splice(i, 1);
      } else {
        tr.schedule(now, until);
      }
    }
  }
}
