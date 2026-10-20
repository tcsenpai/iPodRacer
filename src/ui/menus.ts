// DOM overlays: title (over the 3D showcase), pause and race results.
import '@fontsource/news-cycle/400.css';
import '@fontsource/news-cycle/700.css';
import '@fontsource/orbitron/800.css';
import type { Quality } from '../core/engine';
import { DIFFICULTIES, type CameraMode, type Difficulty, type Settings } from '../core/settings';
import { LANGS, getLang, onLangChange, setLang, t, type StringKey } from '../i18n/i18n';
import { el, formatTime } from './hud';

type Render = () => void;

export interface ResultRow {
  name: string;
  /** Total race time; null = DNF / crashed out. */
  time: number | null;
  bestLap: number | null;
  player: boolean;
}

export interface MenuHandlers {
  /** Start a race with settings.difficulty. */
  start(): void;
  /** Difficulty, quality, volume, camera or language changed; the caller persists. */
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
const CAMERA_KEY: Record<CameraMode, StringKey> = { chase: 'set.cam.chase', far: 'set.cam.far', cockpit: 'set.cam.cockpit' };

/** Key caps are not translated except where they contain words. */
const KEYBOARD: readonly [string | StringKey, StringKey][] = [
  ['W / ↑', 'ctl.throttle'],
  ['S / ↓', 'ctl.brake'],
  ['A D / ← →', 'ctl.steer'],
  ['Shift / Space', 'ctl.boost'],
  ['2× A / D', 'ctl.roll'],
  ['Q / E', 'ctl.tilt'],
  ['C', 'ctl.camera'],
  ['R', 'ctl.reset'],
  ['Esc / P', 'ctl.pause'],
];
const GAMEPAD: readonly [string | StringKey, StringKey][] = [
  ['ctl.stick', 'ctl.steer'],
  ['RT', 'ctl.throttle'],
  ['LT', 'ctl.brake'],
  ['A', 'ctl.boost'],
  ['X / B', 'ctl.rollLeft'],
  ['LB / RB', 'ctl.tilt'],
  ['Y', 'ctl.camera'],
  ['Start', 'ctl.pause'],
];

function isKey(s: string): s is StringKey {
  return s.startsWith('ctl.');
}

export class Menus {
  readonly root: HTMLDivElement;
  private current: Render | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private settings: Settings,
    private h: MenuHandlers,
  ) {
    this.root = el('div', 'overlay');
    this.root.hidden = true;
    parent.appendChild(this.root);
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

  private controlsCard(): HTMLElement {
    const card = el('div', 'controls-card');
    card.append(el('div', 'section', t('menu.controls')));
    const cols = el('div', 'controls-cols');
    for (const [title, rows] of [
      ['menu.keyboard', KEYBOARD],
      ['menu.gamepad', GAMEPAD],
    ] as const) {
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
      this.h.start();
    });
    this.show('title', () => {
      const s = this.settings;
      const panel = el('div', 'title-panel');
      panel.append(el('div', 'pre', t('menu.pre')), el('h1', 'logo', t('menu.title')), el('div', 'subtitle', t('menu.subtitle')));

      const start = this.button(t('menu.start'), () => this.h.start(), true);
      start.classList.add('start');
      start.append(el('span', 'btn-sub', t('menu.startHint')));

      const circuit = el('div', 'group');
      circuit.append(
        el('div', 'section', t('menu.circuit')),
        this.chips(DIFFICULTIES, s.difficulty, (d) => t(DIFF_KEY[d]), (d) => (s.difficulty = d), (d) => t(DIFF_DESC[d])),
        el('div', 'desc', t(DIFF_DESC[s.difficulty])),
      );
      const best = s.best[s.difficulty];
      circuit.append(
        best
          ? el('div', 'best', t('menu.best', { time: formatTime(best.time), lap: formatTime(best.lap), pos: best.position }))
          : el('div', 'best none', t('menu.noBest')),
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
        this.field('set.language', this.langSwitch()),
      );

      panel.append(start, circuit, form, el('div', 'foot', t('menu.footer')));
      this.root.replaceChildren(panel, this.controlsCard());
      start.focus({ preventScroll: true });
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

  showResults(rows: readonly ResultRow[], playerPos: number, newBest: boolean, difficulty: Difficulty): void {
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
      const player = rows.find((r) => r.player);
      const out = player !== undefined && player.time === null;
      const panel = el('div', `panel results${out ? ' fail' : playerPos === 1 ? ' won' : ''}`);
      const head = el('div', 'result-head');
      head.append(el('div', `place p${out ? 0 : playerPos}`, out ? '-' : `P${playerPos}`));
      const titles = el('div');
      titles.append(
        el('div', 'pre', t('res.pre', { diff: t(DIFF_KEY[difficulty]) })),
        el('h2', '', out ? t('res.out') : playerPos === 1 ? t('res.won') : t('res.placed', { pos: playerPos })),
      );
      if (newBest) titles.append(el('div', 'badge', t('res.newBest')));
      head.append(titles);

      const table = el('div', 'podium');
      for (const k of ['res.pos', 'res.pilot', 'res.time', 'res.bestLap'] as const) table.append(el('div', 'th', t(k)));
      const winner = rows[0]?.time ?? null;
      rows.forEach((r, i) => {
        const cls = `${r.player ? ' you' : ''}${i < 3 && r.time !== null ? ` p${i + 1}` : ''}${r.time === null ? ' dnf' : ''}`;
        const time = el('div', `td num${cls}`, r.time === null ? t('res.dnf') : formatTime(r.time));
        // Gap to the winner reads better than raw totals further down the order.
        if (i > 0 && r.time !== null && winner !== null) time.append(el('span', 'gap', `+${formatTime(r.time - winner)}`));
        table.append(
          el('div', `td pos${cls}`, String(i + 1)),
          el('div', `td name${cls}`, r.name),
          time,
          el('div', `td num${cls}`, r.bestLap === null ? '-:--.---' : formatTime(r.bestLap)),
        );
      });

      const nav = el('div', 'nav row');
      nav.append(this.button(t('res.restart'), () => this.h.restart(), true), this.button(t('res.title'), () => this.h.quit()));
      panel.append(head, table, nav, el('div', 'foot', t('res.hint')));
      this.root.replaceChildren(panel);
    });
  }
}
