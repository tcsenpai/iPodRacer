// DOM overlays: title (over the 3D showcase), circuit and pilot selection, pause, race results and the
// loading veil shown while a planet is generated.
import '@fontsource/news-cycle/400.css';
import '@fontsource/news-cycle/700.css';
import '@fontsource/orbitron/800.css';
import type { Quality } from '../core/engine';
import { KEY_HINTS } from '../core/input';
import { DIFFICULTIES, bestKey, type CameraMode, type Difficulty, type Settings } from '../core/settings';
import { ROSTER, isUnlocked, unlockHint, type PilotDef, type PodStats } from '../game/roster';
import { LANGS, getLang, onLangChange, setLang, t, type StringKey } from '../i18n/i18n';
import type { TrackDef } from '../world/theme';
import { TRACKS, trackById } from '../world/tracks';
import { el, formatTime } from './hud';

type Render = () => void;

export interface ResultRow {
  name: string;
  /** Total race time; null = DNF / crashed out. */
  time: number | null;
  bestLap: number | null;
  player: boolean;
  /** View slot of a local player's pod, null for rivals. */
  slot: 0 | 1 | null;
}

export interface ResultsInfo {
  rows: readonly ResultRow[];
  /** Finishing position per local player (index = view slot). */
  positions: readonly number[];
  newBest: boolean;
  difficulty: Difficulty;
  track: TrackDef;
  /** Pilots this race unlocked (shown with a banner). */
  unlocked: readonly PilotDef[];
}

export interface MenuHandlers {
  /** Start a race with the current settings (track, pilots, players, difficulty). */
  start(): void;
  /** A circuit was chosen: build its world for the backdrop; resolves once it is ready. */
  selectTrack(id: string): Promise<void>;
  /** Player 1's pilot cursor moved: show that pod on the backdrop. */
  previewPilot(id: string): void;
  /** Any persisted setting changed; the caller persists. */
  settingsChanged(s: Settings): void;
  resume(): void;
  restart(): void;
  quit(): void;
  uiSound(kind: 'select' | 'confirm'): void;
}

const DIFF_KEY: Record<Difficulty, StringKey> = {
  amateur: 'diff.amateur',
  semipro: 'diff.semipro',
  galactic: 'diff.galactic',
};
const DIFF_DESC: Record<Difficulty, StringKey> = {
  amateur: 'diff.amateur.desc',
  semipro: 'diff.semipro.desc',
  galactic: 'diff.galactic.desc',
};
const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];
const QUALITY_KEY: Record<Quality, StringKey> = { low: 'set.q.low', medium: 'set.q.medium', high: 'set.q.high' };
const CAMERAS: readonly CameraMode[] = ['chase', 'far', 'cockpit'];
const ONOFF = ['on', 'off'] as const;
const PLAYER_COUNTS = ['1', '2'] as const;
const CAMERA_KEY: Record<CameraMode, StringKey> = { chase: 'set.cam.chase', far: 'set.cam.far', cockpit: 'set.cam.cockpit' };
const SLOT_NAME: Record<0 | 1, StringKey> = { 0: 'split.p1', 1: 'split.p2' };
const SLOT_TAG: Record<0 | 1, StringKey> = { 0: 'split.tag1', 1: 'split.tag2' };

/** Stat bars on the pilot cards. `invert`: lower is better (heat and damage multipliers). */
const STATS: readonly { key: keyof PodStats; label: StringKey; invert: boolean }[] = [
  { key: 'topSpeed', label: 'menu.stat.speed', invert: false },
  { key: 'thrust', label: 'menu.stat.accel', invert: false },
  { key: 'turn', label: 'menu.stat.turn', invert: false },
  { key: 'cooling', label: 'menu.stat.cooling', invert: true },
  { key: 'durability', label: 'menu.stat.durability', invert: true },
  { key: 'repair', label: 'menu.stat.repair', invert: false },
];

type KeyRows = readonly (readonly [string, StringKey])[];

/** Key caps are not translated except where they contain words. */
const KEYBOARD: KeyRows = [
  ['W / ↑', 'ctl.throttle'],
  ['S / ↓', 'ctl.brake'],
  ['A D / ← →', 'ctl.steer'],
  ['Shift / Space', 'ctl.boost'],
  ['2× A / D', 'ctl.roll'],
  ['Q / E', 'ctl.tilt'],
  ['F', 'ctl.repair'],
  ['C', 'ctl.camera'],
  ['R', 'ctl.reset'],
  ['Esc / P', 'ctl.pause'],
];
const GAMEPAD: KeyRows = [
  ['ctl.stick', 'ctl.steer'],
  ['RT', 'ctl.throttle'],
  ['LT', 'ctl.brake'],
  ['A', 'ctl.boost'],
  ['X / B', 'ctl.rollLeft'],
  ['LB / RB', 'ctl.tilt'],
  ['D-pad ↓', 'ctl.repair'],
  ['Y', 'ctl.camera'],
  ['Start', 'ctl.pause'],
];

function isKey(s: string): s is StringKey {
  return s.startsWith('ctl.');
}

/** Pilot-select keys per player in split screen: [left, right, up, down, confirm]. One player uses both sets. */
const PICK_KEYS: Record<0 | 1, readonly [string, string, string, string, string]> = {
  0: ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space'],
  1: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'],
};

export class Menus {
  readonly root: HTMLDivElement;
  private readonly loader: HTMLDivElement;
  private current: Render | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Track-select cursor (index into TRACKS). */
  private trackCursor = 0;
  /** Pilot-select cursors and confirmations per player slot (indices into ROSTER). */
  private readonly cursor: [number, number] = [0, 0];
  private readonly ready: [boolean, boolean] = [false, false];

  constructor(
    parent: HTMLElement,
    private settings: Settings,
    private h: MenuHandlers,
  ) {
    this.root = el('div', 'overlay');
    this.root.hidden = true;
    this.loader = el('div', 'loading');
    this.loader.hidden = true;
    parent.append(this.root, this.loader);
    onLangChange(() => this.current?.());
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  hide(): void {
    this.root.hidden = true;
    this.root.replaceChildren();
    this.root.className = 'overlay';
    this.current = null;
    this.setKeys(null);
  }

  /** Full-screen veil while a world is generated (the build blocks the main thread for a moment). */
  setLoading(text: string | null): void {
    this.loader.hidden = text === null;
    this.loader.textContent = text ?? '';
  }

  private show(cls: string, render: Render): void {
    this.current = render;
    this.root.className = `overlay ${cls}`;
    this.root.hidden = false;
    render();
  }

  private setKeys(fn: ((e: KeyboardEvent) => void) | null): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = fn;
    if (fn) window.addEventListener('keydown', fn);
  }

  private button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = el('button', primary ? 'btn primary' : 'btn', label);
    b.addEventListener('mouseenter', () => this.h.uiSound('select'));
    b.addEventListener('click', () => {
      this.h.uiSound('confirm');
      onClick();
    });
    return b;
  }

  /** A row of mutually exclusive chips; picking one updates settings and re-renders the screen. */
  private chips<T extends string>(items: readonly T[], value: T, name: (v: T) => string, pick: (v: T) => void, tip?: (v: T) => string): HTMLElement {
    const box = el('div', 'chips');
    for (const it of items) {
      const b = el('button', it === value ? 'chip active' : 'chip', name(it));
      if (tip) b.title = tip(it);
      b.addEventListener('mouseenter', () => this.h.uiSound('select'));
      b.addEventListener('click', () => {
        if (it === value) return;
        this.h.uiSound('confirm');
        pick(it);
        this.h.settingsChanged(this.settings);
        this.current?.();
      });
      box.append(b);
    }
    return box;
  }

  private field(label: StringKey, input: HTMLElement): HTMLElement {
    const r = el('div', 'field');
    r.append(el('span', '', t(label)), input);
    return r;
  }

  private langSwitch(): HTMLElement {
    return this.chips(
      LANGS.map((l) => l.id),
      getLang(),
      (id) => LANGS.find((l) => l.id === id)!.label,
      // setLang notifies onLangChange, which re-renders; the chips() re-render after it is harmless.
      (id) => setLang(id),
    );
  }

  /** Record line for a circuit at the current difficulty. */
  private bestLine(track: string): HTMLElement {
    const best = this.settings.best[bestKey(track, this.settings.difficulty)];
    return best
      ? el('div', 'best', t('menu.best', { time: formatTime(best.time), lap: formatTime(best.lap), pos: best.position }))
      : el('div', 'best none', t('menu.noBest'));
  }

  private controlsCard(): HTMLElement {
    const card = el('div', 'controls-card');
    card.append(el('div', 'section', t('menu.controls')));
    const cols = el('div', 'controls-cols');
    const sets: readonly (readonly [StringKey, KeyRows])[] =
      this.settings.players === 2
        ? [
            ['split.keys1', KEY_HINTS[0]],
            ['split.keys2', KEY_HINTS[1]],
            ['menu.gamepad', GAMEPAD],
          ]
        : [
            ['menu.keyboard', KEYBOARD],
            ['menu.gamepad', GAMEPAD],
          ];
    for (const [title, rows] of sets) {
      const col = el('div', 'controls-col');
      col.append(el('div', 'controls-head', t(title)));
      const table = el('div', 'controls');
      for (const [k, d] of rows) table.append(el('kbd', '', isKey(k) ? t(k) : k), el('span', '', t(d)));
      col.append(table);
      cols.append(col);
    }
    card.append(cols);
    return card;
  }

  showTitle(): void {
    this.setKeys((e) => {
      if (e.repeat || (e.code !== 'Enter' && e.code !== 'NumpadEnter')) return;
      // Stop a focused button from also activating on the same press.
      e.preventDefault();
      this.h.uiSound('confirm');
      this.showTracks();
    });
    this.show('title', () => {
      const s = this.settings;
      const def = trackById(s.track);
      const panel = el('div', 'title-panel');
      panel.append(el('div', 'pre', t('menu.pre', { track: t(def.nameKey), planet: def.planet })), el('h1', 'logo', t('menu.title')), el('div', 'subtitle', t('menu.subtitle')));

      const start = this.button(t('menu.start'), () => this.showTracks(), true);
      start.classList.add('start');
      start.append(el('span', 'btn-sub', t('menu.startHint')));

      const players = el('div', 'group');
      players.append(
        el('div', 'section', t('menu.players')),
        this.chips(PLAYER_COUNTS, s.players === 2 ? '2' : '1', (v) => t(v === '2' ? 'menu.players2' : 'menu.players1'), (v) => (s.players = v === '2' ? 2 : 1)),
      );

      const circuit = el('div', 'group');
      circuit.append(
        el('div', 'section', t('menu.circuit')),
        this.chips(DIFFICULTIES, s.difficulty, (d) => t(DIFF_KEY[d]), (d) => (s.difficulty = d), (d) => t(DIFF_DESC[d])),
        el('div', 'desc', t(DIFF_DESC[s.difficulty])),
        this.bestLine(def.id),
      );

      const form = el('div', 'group form');
      const volume = el('input');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '1';
      volume.step = '0.01';
      volume.value = String(s.volume);
      // No re-render here: it would drop the slider mid-drag.
      volume.addEventListener('input', () => {
        s.volume = Number(volume.value);
        this.h.settingsChanged(s);
      });
      form.append(
        el('div', 'section', t('menu.settings')),
        this.field('set.quality', this.chips(QUALITIES, s.quality, (q) => t(QUALITY_KEY[q]), (q) => (s.quality = q))),
        this.field('set.volume', volume),
        this.field('set.camera', this.chips(CAMERAS, s.camera, (c) => t(CAMERA_KEY[c]), (c) => (s.camera = c))),
        this.field('set.announcer', this.chips(ONOFF, s.announcer ? 'on' : 'off', (v) => t(v === 'on' ? 'set.on' : 'set.off'), (v) => (s.announcer = v === 'on'))),
        this.field('set.language', this.langSwitch()),
      );

      panel.append(start, players, circuit, form, el('div', 'foot', t('menu.footer')));
      this.root.replaceChildren(panel, this.controlsCard());
      start.focus({ preventScroll: true });
    });
  }

  /** Circuit cards: planet, name, description, laps and the record at the current difficulty. */
  showTracks(): void {
    this.trackCursor = Math.max(0, TRACKS.findIndex((d) => d.id === this.settings.track));
    const n = TRACKS.length;
    const move = (dx: number) => {
      this.trackCursor = (this.trackCursor + dx + n) % n;
      this.h.uiSound('select');
      this.current?.();
    };
    this.setKeys((e) => {
      if (e.repeat) return;
      if (e.code === 'ArrowLeft' || e.code === 'KeyA' || e.code === 'ArrowUp' || e.code === 'KeyW') move(-1);
      else if (e.code === 'ArrowRight' || e.code === 'KeyD' || e.code === 'ArrowDown' || e.code === 'KeyS') move(1);
      else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') void this.pickTrack(TRACKS[this.trackCursor]);
      else if (e.code === 'Escape') this.showTitle();
      else return;
      e.preventDefault();
    });
    this.show('dim select', () => {
      const panel = el('div', 'select-panel');
      panel.append(el('h2', 'select-title', t('menu.chooseTrack')));
      const grid = el('div', 'track-grid');
      TRACKS.forEach((def, i) => {
        const card = el('button', i === this.trackCursor ? 'track-card active' : 'track-card');
        card.append(
          el('div', 'track-planet', def.planet),
          el('div', 'track-name', t(def.nameKey)),
          el('div', 'track-desc', t(def.descKey)),
          el('div', 'track-laps', t('menu.laps', { n: def.laps })),
          this.bestLine(def.id),
        );
        card.addEventListener('mouseenter', () => {
          if (this.trackCursor === i) return;
          this.trackCursor = i;
          this.h.uiSound('select');
          this.current?.();
        });
        card.addEventListener('click', () => void this.pickTrack(def));
        grid.append(card);
      });
      const nav = el('div', 'nav row');
      nav.append(this.button(t('menu.back'), () => this.showTitle()));
      panel.append(grid, nav, el('div', 'foot', t('menu.chooseTrackHint')));
      this.root.replaceChildren(panel);
    });
  }

  private async pickTrack(def: TrackDef): Promise<void> {
    this.h.uiSound('confirm');
    // No input while the world builds: a second Enter must not start a race on a half-built scene.
    this.setKeys(null);
    this.settings.track = def.id;
    this.h.settingsChanged(this.settings);
    await this.h.selectTrack(def.id);
    this.showPilots();
  }

  /** Roster grid with stat bars; in split screen both players pick, each with their own cursor and keys. */
  showPilots(): void {
    const s = this.settings;
    const two = s.players === 2;
    const n = ROSTER.length;
    /** First unlocked pilot at or after `from` that is not `other`. */
    const nextFree = (from: number, other: number) => {
      for (let k = 0; k < n; k++) {
        const i = (from + k) % n;
        if (isUnlocked(ROSTER[i], s) && i !== other) return i;
      }
      return from;
    };
    const saved0 = ROSTER.findIndex((p) => p.id === s.pilots[0]);
    this.cursor[0] = nextFree(Math.max(0, saved0), -1);
    const saved1 = ROSTER.findIndex((p) => p.id === s.pilots[1]);
    this.cursor[1] = two ? nextFree(Math.max(0, saved1), this.cursor[0]) : this.cursor[0];
    this.ready[0] = this.ready[1] = false;
    this.h.previewPilot(ROSTER[this.cursor[0]].id);

    let cards: HTMLElement[] = [];
    let grid: HTMLElement | null = null;
    const paint = () => {
      cards.forEach((c, i) => {
        c.classList.toggle('c1', this.cursor[0] === i);
        c.classList.toggle('c2', two && this.cursor[1] === i);
        c.classList.toggle('r1', this.ready[0] && this.cursor[0] === i);
        c.classList.toggle('r2', two && this.ready[1] && this.cursor[1] === i);
      });
    };
    const point = (slot: 0 | 1, i: number) => {
      if (this.ready[slot] || this.cursor[slot] === i) return;
      this.cursor[slot] = i;
      this.h.uiSound('select');
      if (slot === 0) this.h.previewPilot(ROSTER[i].id);
      paint();
    };
    const move = (slot: 0 | 1, dx: number, dy: number) => {
      const c = this.cursor[slot];
      // Columns come from the live layout (the grid reflows on narrow screens): up/down moves one row.
      const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1;
      const row = c + dy * cols;
      point(slot, dy ? (row >= 0 && row < n ? row : c) : (c + dx + n) % n);
    };
    const confirm = (slot: 0 | 1) => {
      const other = two ? (slot === 0 ? 1 : 0) : slot;
      const i = this.cursor[slot];
      // Locked, or already taken by the other player: two identical pods would be unreadable.
      if (this.ready[slot] || !isUnlocked(ROSTER[i], s) || (two && this.ready[other] && this.cursor[other] === i)) {
        this.h.uiSound('select');
        return;
      }
      this.h.uiSound('confirm');
      this.ready[slot] = true;
      s.pilots[slot] = ROSTER[i].id;
      if (this.ready[0] && (!two || this.ready[1])) {
        this.h.settingsChanged(s);
        this.h.start();
        return;
      }
      paint();
    };

    this.setKeys((e) => {
      if (e.repeat) return;
      if (e.code === 'Escape') {
        if (this.ready[0] || this.ready[1]) {
          this.ready[0] = this.ready[1] = false;
          paint();
        } else this.showTracks();
        e.preventDefault();
        return;
      }
      for (const slot of [0, 1] as const) {
        // One player drives the grid with either key set.
        const who: 0 | 1 = two ? slot : 0;
        const keys = PICK_KEYS[slot];
        const k = keys.indexOf(e.code === 'NumpadEnter' ? 'Enter' : e.code);
        if (k < 0) continue;
        e.preventDefault();
        if (k === 4) confirm(who);
        else move(who, k === 0 ? -1 : k === 1 ? 1 : 0, k === 2 ? -1 : k === 3 ? 1 : 0);
        return;
      }
    });

    this.show('dim select', () => {
      const panel = el('div', 'select-panel');
      const def = trackById(s.track);
      panel.append(el('div', 'pre', `${t(def.nameKey)} · ${def.planet}`), el('h2', 'select-title', t('menu.choosePilot')));
      // Bars are relative to the roster's spread, so every stat uses the full width.
      const ranges = STATS.map(({ key }) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of ROSTER) {
          lo = Math.min(lo, p.stats[key]);
          hi = Math.max(hi, p.stats[key]);
        }
        return { lo, span: hi - lo || 1 };
      });
      const box = el('div', 'pilot-grid');
      grid = box;
      cards = ROSTER.map((p, i) => {
        const locked = !isUnlocked(p, s);
        const card = el('div', locked ? 'pilot-card locked' : 'pilot-card');
        const tags = el('div', 'pilot-tags');
        tags.append(el('span', 'tag t1', t(SLOT_TAG[0])));
        if (two) tags.append(el('span', 'tag t2', t(SLOT_TAG[1])));
        card.append(tags, el('div', 'pilot-name', p.name), el('div', 'pilot-sub', `${p.species} · ${p.make}`));
        const stats = el('div', 'pilot-stats');
        STATS.forEach(({ key, label, invert }, k) => {
          const r = (p.stats[key] - ranges[k].lo) / ranges[k].span;
          const bar = el('div', 'stat-bar');
          const fill = el('div', 'stat-fill');
          fill.style.transform = `scaleX(${0.12 + 0.88 * (invert ? 1 - r : r)})`;
          bar.append(fill);
          stats.append(el('span', 'stat-label', t(label)), bar);
        });
        card.append(stats);
        if (locked) card.append(el('div', 'pilot-lock', `${t('menu.locked')} · ${unlockHint(p)}`));
        card.addEventListener('mouseenter', () => {
          // The mouse picks for the first player still choosing.
          const slot = !this.ready[0] ? 0 : two && !this.ready[1] ? 1 : null;
          if (slot !== null) point(slot, i);
        });
        card.addEventListener('click', () => {
          const slot = !this.ready[0] ? 0 : two && !this.ready[1] ? 1 : null;
          if (slot === null) return;
          point(slot, i);
          confirm(slot);
        });
        box.append(card);
        return card;
      });
      const nav = el('div', 'nav row');
      nav.append(this.button(t('menu.back'), () => this.showTracks()));
      panel.append(box, nav, el('div', 'foot', t(two ? 'split.pilotHint' : 'menu.choosePilotHint')));
      this.root.replaceChildren(panel);
      paint();
    });
  }

  showPause(): void {
    this.setKeys((e) => {
      if (e.repeat || (e.code !== 'Escape' && e.code !== 'KeyP')) return;
      e.preventDefault();
      this.h.uiSound('confirm');
      this.h.resume();
    });
    this.show('dim', () => {
      const panel = el('div', 'panel');
      panel.append(el('h2', '', t('menu.paused')));
      const nav = el('div', 'nav');
      nav.append(
        this.button(t('menu.resume'), () => this.h.resume(), true),
        this.button(t('menu.restart'), () => this.h.restart()),
        this.button(t('menu.quit'), () => this.h.quit()),
      );
      panel.append(nav, el('div', 'foot', t('menu.pauseHint')));
      this.root.replaceChildren(panel, this.controlsCard());
    });
  }

  showResults(r: ResultsInfo): void {
    this.setKeys((e) => {
      if (e.repeat) return;
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        this.h.uiSound('confirm');
        this.h.restart();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        this.h.uiSound('confirm');
        this.h.quit();
      }
    });
    this.show('dim', () => {
      const duel = r.positions.length > 1;
      const p1 = r.positions[0];
      const me = r.rows.find((row) => row.slot === 0);
      const out = !duel && me !== undefined && me.time === null;
      const won = duel ? Math.min(...r.positions) === 1 : p1 === 1;
      const panel = el('div', `panel results${out ? ' fail' : won ? ' won' : ''}`);
      const head = el('div', 'result-head');
      if (duel) {
        r.positions.forEach((pos, slot) => {
          const box = el('div', `place-box s${slot + 1}`);
          box.append(el('div', `place p${pos}`, `P${pos}`), el('div', 'place-who', t(SLOT_NAME[slot === 0 ? 0 : 1])));
          head.append(box);
        });
      } else head.append(el('div', `place p${out ? 0 : p1}`, out ? '-' : `P${p1}`));
      const titles = el('div');
      const winner: 0 | 1 = duel && r.positions[1] < r.positions[0] ? 1 : 0;
      titles.append(
        el('div', 'pre', t('res.pre', { track: t(r.track.nameKey), diff: t(DIFF_KEY[r.difficulty]) })),
        el('h2', '', duel ? t('split.wins', { player: t(SLOT_NAME[winner]) }) : out ? t('res.out') : p1 === 1 ? t('res.won') : t('res.placed', { pos: p1 })),
      );
      if (r.newBest) titles.append(el('div', 'badge', t('res.newBest')));
      head.append(titles);

      const table = el('div', 'podium');
      for (const k of ['res.pos', 'res.pilot', 'res.time', 'res.bestLap'] as const) table.append(el('div', 'th', t(k)));
      const lead = r.rows[0]?.time ?? null;
      r.rows.forEach((row, i) => {
        const cls = `${row.player ? ' you' : ''}${row.slot !== null && duel ? ` s${row.slot + 1}` : ''}${i < 3 && row.time !== null ? ` p${i + 1}` : ''}${row.time === null ? ' dnf' : ''}`;
        const time = el('div', `td num${cls}`, row.time === null ? t('res.dnf') : formatTime(row.time));
        // Gap to the winner reads better than raw totals further down the order.
        if (i > 0 && row.time !== null && lead !== null) time.append(el('span', 'gap', `+${formatTime(row.time - lead)}`));
        const name = el('div', `td name${cls}`, row.name);
        if (duel && row.slot !== null) name.append(el('span', `tag t${row.slot + 1}`, t(SLOT_TAG[row.slot])));
        table.append(el('div', `td pos${cls}`, String(i + 1)), name, time, el('div', `td num${cls}`, row.bestLap === null ? '-:--.---' : formatTime(row.bestLap)));
      });

      panel.append(head, table);
      if (r.unlocked.length) {
        const box = el('div', 'unlock');
        box.append(el('div', 'unlock-head', t('menu.unlocked')));
        for (const p of r.unlocked) box.append(el('div', 'unlock-name', `${p.name} · ${p.species} · ${p.make}`));
        panel.append(box);
      }
      const nav = el('div', 'nav row');
      nav.append(this.button(t('res.restart'), () => this.h.restart(), true), this.button(t('res.title'), () => this.h.quit()));
      panel.append(nav, el('div', 'foot', t('res.hint')));
      this.root.replaceChildren(panel);
    });
  }
}
