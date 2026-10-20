// DOM race HUD: position and lap times (top left), minimap (top right), speed, heat and hull (bottom right),
// plus the event layer: banners, trick popups, cinematic captions and letterbox bars.
// update() runs every frame, so it only touches the DOM when a displayed value changes and always assigns
// precomputed strings (digit tables below) instead of formatting new ones.
import '@fontsource/orbitron/800.css';
import '@fontsource/orbitron/900.css';
import { onLangChange, t, type StringKey } from '../i18n/i18n';

export interface HudPod {
  x: number;
  z: number;
  player: boolean;
  alive: boolean;
}

export interface HudState {
  /** Current lap, 1..laps (display clamps). */
  lap: number;
  laps: number;
  /** 1-based race position. */
  position: number;
  racers: number;
  /** m/s; shown as km/h. */
  speed: number;
  /** 0..1 */
  heat: number;
  overheated: boolean;
  /** Wear per engine 0..1 (left, right). */
  engines: readonly [number, number];
  /** Repair droids at work. */
  repairing: boolean;
  /** Seconds. */
  raceTime: number;
  lapTime: number;
  /** Completed laps (s). */
  lapTimes: readonly number[];
  bestLap: number | null;
  wrongWay: boolean;
  /** Minimap dots; stable array. */
  pods: readonly HudPod[];
}

export type BannerKind = 'countdown' | 'go' | 'lap' | 'final' | 'info' | 'trick' | 'warn';

const BANNER_SECONDS: Record<BannerKind, number> = {
  countdown: 0.9,
  go: 1.1,
  lap: 2,
  final: 2.4,
  info: 2.5,
  trick: 1.5,
  warn: 2.5,
};

const MAX_TRICKS = 4;
/** Minimap edge in CSS pixels (the canvas backing store is scaled by devicePixelRatio). */
const MAP_SIZE = 170;
const MAP_PAD = 10;

// Digit tables: per-frame readouts index these instead of building strings.
const NUM: readonly string[] = Array.from({ length: 2000 }, (_, i) => String(i));
const PAD2: readonly string[] = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0'));
const PAD3: readonly string[] = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
/** Bar fills in 1% steps. */
const SCALE_X: readonly string[] = Array.from({ length: 101 }, (_, i) => `scaleX(${i / 100})`);
/** Speed-fx intensity in 1% steps, fed to the `--fx` CSS variable. */
const UNIT: readonly string[] = Array.from({ length: 101 }, (_, i) => String(i / 100));

const percent = (v: number): number => Math.max(0, Math.min(100, Math.round(v * 100)));
const num = (v: number): string => NUM[Math.max(0, Math.min(NUM.length - 1, Math.round(v)))];

/** m:ss.mmm (menus, results). Allocates: not for per-frame use, see Clock. */
export function formatTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  return `${Math.floor(ms / 60000)}:${PAD2[Math.floor(ms / 1000) % 60]}.${PAD3[ms % 1000]}`;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A m:ss.mmm readout built from text nodes, so ticking it every frame allocates nothing. */
class Clock {
  readonly root: HTMLSpanElement;
  private readonly m = document.createTextNode('0');
  private readonly s = document.createTextNode('00');
  private readonly ms = document.createTextNode('000');
  private last = -1;

  constructor(cls: string) {
    this.root = el('span', cls);
    this.root.append(this.m, ':', this.s, '.', this.ms);
  }

  set(seconds: number): void {
    const total = Math.max(0, Math.round(seconds * 1000));
    if (total === this.last) return;
    const prev = this.last;
    this.last = total;
    this.ms.data = PAD3[total % 1000];
    // Seconds and minutes change far less often than the millisecond digits.
    const sec = Math.floor(total / 1000);
    if (prev < 0 || sec !== Math.floor(prev / 1000)) {
      this.s.data = PAD2[sec % 60];
      this.m.data = num(Math.floor(sec / 60));
    }
  }
}

export class Hud {
  readonly root: HTMLDivElement;
  /** Gameplay readouts; hidden by setVisible() while the event layer (banners, captions, letterbox) stays. */
  private readonly play: HTMLDivElement;
  private readonly labels: [HTMLElement, StringKey][] = [];

  private readonly posBox: HTMLDivElement;
  private readonly posN = document.createTextNode('1');
  private readonly posOf = document.createTextNode('6');
  private readonly lapN = document.createTextNode('1');
  private readonly lapOf = document.createTextNode('3');
  private readonly raceClock = new Clock('hud-clock');
  private readonly lapClock = new Clock('hud-clock');
  private readonly liveLapN = document.createTextNode('1');
  private readonly lapList: HTMLDivElement;
  private readonly bestText = document.createTextNode('');

  private readonly speedBox: HTMLDivElement;
  private readonly speedN = document.createTextNode('0');
  private readonly heatFill: HTMLDivElement;
  private readonly hullFill: HTMLDivElement[];
  private readonly heatRow: HTMLDivElement;
  private readonly hullRow: HTMLDivElement[];
  private readonly wrong: HTMLDivElement;

  private readonly map: HTMLCanvasElement;
  private readonly mapCtx: CanvasRenderingContext2D;
  private readonly mapTrack: HTMLCanvasElement;
  private readonly mapScale: number;
  private readonly mapOffX: number;
  private readonly mapOffZ: number;
  private readonly dpr: number;

  private readonly bannerEl: HTMLDivElement;
  private bannerTimer = 0;
  private readonly tricks: HTMLDivElement;
  private readonly captionEl: HTMLDivElement;
  private readonly capTitle: HTMLDivElement;
  private readonly capSub: HTMLDivElement;

  // Last displayed values: the DOM is only written when these change.
  private lastPos = -1;
  private lastRacers = -1;
  private lastLap = -1;
  private lastLaps = -1;
  private lastLapCount = -1;
  private lastBest: number | null = -1;
  private lastKmh = -1;
  private lastHeat = -1;
  private lastHull = [-1, -1];
  private lastOver = false;
  private lastHot = false;
  private lastCrit = [false, false];
  private lastRepair = false;
  private lastWrong = false;
  private lastFx = -1;

  constructor(parent: HTMLElement, trackXZ: Float32Array) {
    this.root = el('div', 'hud');
    this.play = el('div', 'hud-play');

    // Top left: position, lap, clocks.
    const tl = el('div', 'hud-tl');
    this.posBox = el('div', 'hud-pos');
    const posNum = el('span', 'hud-pos-n');
    posNum.append(this.posN);
    const posOf = el('span', 'hud-pos-of');
    posOf.append('/', this.posOf);
    this.posBox.append(this.label('hud.pos'), posNum, posOf);

    const lapBox = el('div', 'hud-lap');
    const lapNum = el('b');
    lapNum.append(this.lapN);
    const lapOf = el('span', 'hud-lap-of');
    lapOf.append('/', this.lapOf);
    lapBox.append(this.label('hud.lap'), lapNum, lapOf);

    const times = el('div', 'hud-times');
    const total = el('div', 'hud-row total');
    total.append(this.label('hud.time'), this.raceClock.root);
    this.lapList = el('div', 'hud-laplist');
    const live = el('div', 'hud-row live');
    const liveLabel = el('span', 'hud-label');
    liveLabel.append('L', this.liveLapN);
    live.append(liveLabel, this.lapClock.root);
    const best = el('div', 'hud-row bestrow');
    const bestVal = el('span', 'hud-clock');
    bestVal.append(this.bestText);
    best.append(this.label('hud.best'), bestVal);
    times.append(total, this.lapList, live, best);
    tl.append(this.posBox, lapBox, times);

    // Top right: minimap. The track is rasterised once; each frame blits it and draws the pod dots.
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(MAP_SIZE * this.dpr);
    this.map = el('canvas', 'hud-map');
    this.map.width = this.map.height = px;
    this.mapCtx = this.map.getContext('2d')!;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < trackXZ.length; i += 2) {
      minX = Math.min(minX, trackXZ[i]);
      maxX = Math.max(maxX, trackXZ[i]);
      minZ = Math.min(minZ, trackXZ[i + 1]);
      maxZ = Math.max(maxZ, trackXZ[i + 1]);
    }
    const inner = px - 2 * MAP_PAD * this.dpr;
    this.mapScale = inner / Math.max(1, maxX - minX, maxZ - minZ);
    // Centre the course in the square whichever axis is longer.
    this.mapOffX = px / 2 - ((minX + maxX) / 2) * this.mapScale;
    this.mapOffZ = px / 2 - ((minZ + maxZ) / 2) * this.mapScale;
    this.mapTrack = this.drawTrack(trackXZ, px);

    // Bottom right: speed, heat, hull.
    this.speedBox = el('div', 'hud-speed');
    const speedNum = el('div', 'hud-speed-n');
    speedNum.append(this.speedN);
    const unit = this.label('hud.kmh');
    unit.classList.add('hud-unit');
    const bar = (key: StringKey, cls: string): [HTMLDivElement, HTMLDivElement] => {
      const row = el('div', `hud-bar ${cls}`);
      const track = el('div', 'hud-bar-track');
      const fill = el('div', 'hud-bar-fill');
      track.append(fill);
      row.append(this.label(key), track);
      return [row, fill];
    };
    [this.heatRow, this.heatFill] = bar('hud.heat', 'heat');
    const [rowL, fillL] = bar('hud.engL', 'hull');
    const [rowR, fillR] = bar('hud.engR', 'hull');
    this.hullRow = [rowL, rowR];
    this.hullFill = [fillL, fillR];
    const overTag = this.label('hud.overheated');
    overTag.classList.add('hud-over');
    const repairTag = this.label('hud.repairing');
    repairTag.classList.add('hud-repair');
    this.speedBox.append(speedNum, unit, this.heatRow, rowL, rowR, overTag, repairTag);

    this.wrong = el('div', 'hud-wrong');
    this.labels.push([this.wrong, 'race.wrongway']);

    this.play.append(tl, this.map, this.speedBox, this.wrong);

    // Event layer.
    const lbTop = el('div', 'hud-lb top');
    const lbBot = el('div', 'hud-lb bottom');
    this.bannerEl = el('div', 'hud-banner');
    this.tricks = el('div', 'hud-tricks');
    this.captionEl = el('div', 'hud-caption');
    this.capTitle = el('div', 'cap-title');
    this.capSub = el('div', 'cap-sub');
    this.captionEl.append(this.capTitle, this.capSub);

    this.root.append(this.play, lbTop, lbBot, this.bannerEl, this.tricks, this.captionEl);
    parent.appendChild(this.root);
    this.relabel();
    onLangChange(() => this.relabel());
  }

  /** Small caps label whose text follows the language. */
  private label(key: StringKey): HTMLSpanElement {
    const e = el('span', 'hud-label');
    this.labels.push([e, key]);
    return e;
  }

  private relabel(): void {
    for (const [e, key] of this.labels) e.textContent = t(key);
  }

  private drawTrack(xz: Float32Array, px: number): HTMLCanvasElement {
    const c = el('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d')!;
    const path = new Path2D();
    for (let i = 0; i < xz.length; i += 2) {
      const x = this.mapOffX + xz[i] * this.mapScale;
      const y = this.mapOffZ + xz[i + 1] * this.mapScale;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.closePath();
    g.lineJoin = g.lineCap = 'round';
    // Dark casing first so the amber line reads over bright sand behind the translucent map.
    g.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    g.lineWidth = 7 * this.dpr;
    g.stroke(path);
    g.strokeStyle = 'rgba(255, 179, 71, 0.85)';
    g.lineWidth = 2.5 * this.dpr;
    g.stroke(path);

    // Start/finish tick across the first segment.
    if (xz.length >= 4) {
      const dx = xz[2] - xz[0];
      const dz = xz[3] - xz[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * 7 * this.dpr;
      const nz = (dx / len) * 7 * this.dpr;
      const x = this.mapOffX + xz[0] * this.mapScale;
      const y = this.mapOffZ + xz[1] * this.mapScale;
      g.strokeStyle = '#fff';
      g.lineWidth = 2 * this.dpr;
      g.beginPath();
      g.moveTo(x - nx, y - nz);
      g.lineTo(x + nx, y + nz);
      g.stroke();
    }
    return c;
  }

  private drawMap(pods: readonly HudPod[]): void {
    const g = this.mapCtx;
    const px = this.map.width;
    g.clearRect(0, 0, px, px);
    g.drawImage(this.mapTrack, 0, 0);
    // Rivals first, the player on top.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < pods.length; i++) {
        const p = pods[i];
        if (p.player !== (pass === 1)) continue;
        const x = this.mapOffX + p.x * this.mapScale;
        const y = this.mapOffZ + p.z * this.mapScale;
        g.beginPath();
        if (p.player) {
          g.arc(x, y, 5 * this.dpr, 0, Math.PI * 2);
          g.fillStyle = '#ffe14a';
          g.fill();
          g.lineWidth = 1.5 * this.dpr;
          g.strokeStyle = '#000';
          g.stroke();
        } else {
          g.arc(x, y, 3.5 * this.dpr, 0, Math.PI * 2);
          g.fillStyle = p.alive ? '#ff5a3c' : 'rgba(150, 150, 150, 0.6)';
          g.fill();
        }
      }
    }
  }

  /** Shows or hides the gameplay readouts; banners, tricks, captions and letterbox are unaffected. */
  setVisible(on: boolean): void {
    this.play.hidden = !on;
  }

  update(s: HudState): void {
    if (s.position !== this.lastPos) {
      const prev = this.lastPos;
      this.lastPos = s.position;
      this.posN.data = num(s.position);
      // Restart the bump animation (not on the first frame): a gained place flashes gold, a lost one red.
      if (prev > 0) {
        this.posBox.classList.remove('up', 'down');
        void this.posBox.offsetWidth;
        this.posBox.classList.add(s.position < prev ? 'up' : 'down');
      }
    }
    if (s.racers !== this.lastRacers) {
      this.lastRacers = s.racers;
      this.posOf.data = num(s.racers);
    }
    const lap = Math.max(1, Math.min(s.laps, s.lap));
    if (lap !== this.lastLap) {
      this.lastLap = lap;
      this.lapN.data = num(lap);
      this.liveLapN.data = num(lap);
    }
    if (s.laps !== this.lastLaps) {
      this.lastLaps = s.laps;
      this.lapOf.data = num(s.laps);
    }
    this.raceClock.set(s.raceTime);
    this.lapClock.set(s.lapTime);
    if (s.lapTimes.length !== this.lastLapCount || s.bestLap !== this.lastBest) this.rebuildLaps(s.lapTimes, s.bestLap);

    const kmh = Math.round(s.speed * 3.6);
    if (kmh !== this.lastKmh) {
      this.lastKmh = kmh;
      this.speedN.data = num(kmh);
    }
    const heat = percent(s.heat);
    if (heat !== this.lastHeat) {
      this.lastHeat = heat;
      this.heatFill.style.transform = SCALE_X[heat];
    }
    const hot = heat >= 75;
    if (hot !== this.lastHot) {
      this.lastHot = hot;
      this.heatRow.classList.toggle('hot', hot);
    }
    if (s.overheated !== this.lastOver) {
      this.lastOver = s.overheated;
      this.speedBox.classList.toggle('over', s.overheated);
    }
    for (let i = 0; i < 2; i++) {
      const hull = 100 - percent(s.engines[i]);
      if (hull !== this.lastHull[i]) {
        this.lastHull[i] = hull;
        this.hullFill[i].style.transform = SCALE_X[hull];
      }
      const crit = hull <= 30;
      if (crit !== this.lastCrit[i]) {
        this.lastCrit[i] = crit;
        this.hullRow[i].classList.toggle('crit', crit);
      }
    }
    if (s.repairing !== this.lastRepair) {
      this.lastRepair = s.repairing;
      this.speedBox.classList.toggle('repairing', s.repairing);
    }
    if (s.wrongWay !== this.lastWrong) {
      this.lastWrong = s.wrongWay;
      this.wrong.classList.toggle('on', s.wrongWay);
    }
    if (!this.play.hidden) this.drawMap(s.pods);
  }

  /** Completed laps only change a few times per race, so rebuilding the list then is fine. */
  private rebuildLaps(times: readonly number[], best: number | null): void {
    this.lastLapCount = times.length;
    this.lastBest = best;
    this.lapList.replaceChildren();
    for (let i = 0; i < times.length; i++) {
      const row = el('div', times[i] === best ? 'hud-row done best' : 'hud-row done');
      row.append(el('span', 'hud-label', `L${i + 1}`), el('span', 'hud-clock', formatTime(times[i])));
      this.lapList.append(row);
    }
    this.bestText.data = best === null ? '-:--.---' : formatTime(best);
  }

  /** Big centre text with a punchy scale-in; auto-hides after `seconds` (default per kind). */
  banner(text: string, kind: BannerKind, seconds = BANNER_SECONDS[kind]): void {
    const b = this.bannerEl;
    b.textContent = text;
    b.className = `hud-banner k-${kind}`;
    // Force a reflow so re-adding `show` restarts the animation (countdown 3, 2, 1 reuse the element).
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), seconds * 1000);
  }

  /** Small popup stacked under the centre that floats up and fades. */
  trick(text: string): void {
    while (this.tricks.childElementCount >= MAX_TRICKS) this.tricks.firstElementChild!.remove();
    const e = el('div', 'hud-trick', text);
    e.addEventListener('animationend', () => e.remove());
    this.tricks.append(e);
  }

  /** Cinematic lower third (rival introductions). An empty title hides it. */
  caption(title: string, sub: string): void {
    const c = this.captionEl;
    if (!title) {
      c.classList.remove('on');
      return;
    }
    this.capTitle.textContent = title;
    this.capSub.textContent = sub;
    c.classList.remove('on');
    void c.offsetWidth;
    c.classList.add('on');
  }

  letterbox(on: boolean): void {
    this.root.classList.toggle('cine', on);
  }

  /** 0..1 adrenaline level: drives the speed readout glow and shake through the `--fx` CSS variable. */
  speedFx(k: number): void {
    const i = percent(k);
    if (i === this.lastFx) return;
    this.lastFx = i;
    this.speedBox.style.setProperty('--fx', UNIT[i]);
  }
}
