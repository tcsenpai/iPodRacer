// Persisted player settings and best results.
import type { Quality } from './engine';

/** Circuit classes, named after the Boonta circuits: they scale how hard the rivals push. */
export const DIFFICULTIES = ['amateur', 'semipro', 'galactic'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface DifficultyProfile {
  /** Rival top speed as a fraction of the player's (non-boost) top speed. */
  pace: number;
  /** Rival cornering: fraction of the physically possible corner speed they dare carry. */
  cornering: number;
  /** Chance per second a rival in boost range fires its boost on a straight. */
  boost: number;
  /** Rivals steer into nearby pods (Sebulba style). */
  ramming: number;
  /** Multiplier on damage the player takes from walls, rocks and rams. */
  damage: number;
  /** Rubber band: rivals far behind the player gain up to this fraction of extra pace. */
  catchUp: number;
  /** Chance a Tusken sniper's shot hits a pod that did not dodge (barrel roll or knife edge). */
  sniper: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  amateur: { pace: 0.84, cornering: 0.8, boost: 0.05, ramming: 0, damage: 0.6, catchUp: 0.04, sniper: 0.4 },
  semipro: { pace: 0.93, cornering: 0.9, boost: 0.12, ramming: 0.4, damage: 1, catchUp: 0.06, sniper: 0.6 },
  galactic: { pace: 0.98, cornering: 0.97, boost: 0.25, ramming: 1, damage: 1.3, catchUp: 0.08, sniper: 0.8 },
};

export type CameraMode = 'chase' | 'far' | 'cockpit';

export interface BestResult {
  /** Total race time (s). */
  time: number;
  /** Best single lap (s). */
  lap: number;
  /** Finishing position (1-based). */
  position: number;
}

export interface Settings {
  difficulty: Difficulty;
  quality: Quality;
  /** Master volume 0..1. */
  volume: number;
  camera: CameraMode;
  best: Partial<Record<Difficulty, BestResult>>;
}

const KEY = 'ipodracer.settings.v1';

const DEFAULTS: Settings = { difficulty: 'semipro', quality: 'high', volume: 0.8, camera: 'chase', best: {} };

export function loadSettings(): Settings {
  try {
    const s: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    if (!DIFFICULTIES.includes(s.difficulty)) s.difficulty = DEFAULTS.difficulty;
    return s;
  } catch {
    return { ...DEFAULTS, best: {} };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
