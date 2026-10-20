// The Episode I: Racer field: every pilot with species, pod make, livery, handling stats, AI traits and
// the rule that unlocks them for the player. Rivals race as AI whether or not they are unlocked.
//
// Balance rationale: Anakin is the reference pod (215 m/s, 55 m/s^2, every multiplier 1). Every other
// pilot trades roughly the same budget: a strength is paid for with a weakness of similar weight, so no
// pod dominates every track. Top speed rewards long straights (Boonta, Malastare), thrust and turn
// reward tight technical courses (Ando, Baroonda), cooling decides how much overdrive a lap can hold,
// durability and repair decide how much contact a pilot survives. The late unlocks (Sebulba, Ben
// Quadinaros) are the most extreme, not the strictly best: Ben is the fastest pod in the field and the
// most fragile one; Sebulba is fast and tough but overheats early.
import { DIFFICULTIES, type Difficulty, type Settings } from '../core/settings';
import { mulberry32 } from '../core/rng';
import { t } from '../i18n/i18n';
import type { StringKey } from '../i18n/i18n';
import { ANAKIN_LIVERY, type PodLivery } from '../models/podracer';
import type { PilotTraits } from './ai';

export interface PodStats {
  /** Terminal speed on full throttle (m/s); overdrive scales it by VBOOST / VMAX. */
  topSpeed: number;
  /** Full throttle thrust (m/s^2): acceleration out of corners and after hits. */
  thrust: number;
  /** Multiplier on the yaw rate available at any speed. */
  turn: number;
  /** Multiplier on the heat overdrive builds (<1 = cooler, longer boosts). */
  cooling: number;
  /** Multiplier on damage taken (<1 = tougher); difficulty multiplies on top. */
  durability: number;
  /** Multiplier on the repair droids' rate. */
  repair: number;
}

export interface UnlockRule {
  kind: 'win' | 'podium';
  /** Track id or 'any'. */
  track: string | 'any';
  /** Minimum difficulty: a result on a harder one counts too. */
  difficulty: Difficulty;
}

export interface PilotDef {
  id: string;
  name: string;
  species: string;
  make: string;
  livery: PodLivery;
  stats: PodStats;
  traits: PilotTraits;
  /** null = available from the start. */
  unlock: UnlockRule | null;
}

const livery = (skin: string, band: string, trim: string, cockpit: string, engineScale = 1): PodLivery => ({ skin, band, trim, cockpit, engineScale });
const stats = (topSpeed: number, thrust: number, turn: number, cooling: number, durability: number, repair: number): PodStats => ({ topSpeed, thrust, turn, cooling, durability, repair });

/** Order matters: the first entry is the default player pilot, and the menu lists pilots in this order. */
export const ROSTER: readonly PilotDef[] = [
  // Reference pod: balanced everywhere.
  { id: 'anakin', name: 'Anakin Skywalker', species: 'Human', make: 'Radon-Ulzer 620C', livery: ANAKIN_LIVERY, stats: stats(215, 55, 1, 1, 1, 1), traits: { lane: 0, pace: 1, aggression: 0 }, unlock: null },
  // Four arms on the controls: the best accelerator and corner carver, paid for with top speed.
  { id: 'gasgano', name: 'Gasgano', species: 'Xexto', make: 'Ord Pedrovia', livery: livery('#c8d8b0', '#2a6e3a', '#d8c060', '#3c7a46'), stats: stats(206, 62, 1.12, 1.05, 1.05, 0.95), traits: { lane: 10, pace: 1.0, aggression: 0.3 }, unlock: null },
  // Light, cool running pod: long boosts, a touch fragile.
  { id: 'mawhonic', name: 'Mawhonic', species: 'Gran', make: 'GPE-3130', livery: livery('#f2f6ff', '#2aa198', '#f0f0f0', '#2a8a80', 0.9), stats: stats(212, 56, 1.06, 0.88, 1.08, 1), traits: { lane: -14, pace: 0.98, aggression: 0.2 }, unlock: null },
  // Famous for his pit droids: slow but tough, and repairs very fast.
  { id: 'ody', name: 'Ody Mandrell', species: "Er'Kit", make: 'Exelbrok XL 5115', livery: livery('#d8d0c8', '#b02020', '#f0e0c0', '#8a1a1a', 1.08), stats: stats(205, 53, 0.95, 0.95, 0.88, 1.4), traits: { lane: 4, pace: 0.97, aggression: 0.6 }, unlock: null },
  // Straight line specialist with a lazy repair crew.
  { id: 'aldar', name: 'Aldar Beedo', species: 'Glymphid', make: 'Manta RamAir Mark II', livery: livery('#b8c890', '#3a5a2a', '#c09040', '#5a7a3a', 0.95), stats: stats(221, 52, 0.97, 1, 1, 0.88), traits: { lane: -2, pace: 0.96, aggression: 0.8 }, unlock: null },
  // First rung: an all rounder slightly quicker than the starters but heats up sooner.
  { id: 'elan', name: 'Elan Mak', species: 'Fluggrian', make: 'Plug-F Mammoth', livery: livery('#e8e0a0', '#5a3a8a', '#d0d0d0', '#6a4a9a', 1.1), stats: stats(218, 55, 0.98, 1.08, 0.95, 1), traits: { lane: 8, pace: 0.97, aggression: 0.5 }, unlock: { kind: 'podium', track: 'any', difficulty: 'amateur' } },
  // LongTail: high top speed, slow to turn in.
  { id: 'teemto', name: 'Teemto Pagalies', species: 'Veknoid', make: 'IPG-X1131 LongTail', livery: livery('#f0e8d8', '#c87018', '#404040', '#b06010', 1.05), stats: stats(222, 52, 0.9, 0.98, 1.05, 1), traits: { lane: -10, pace: 0.98, aggression: 0.4 }, unlock: { kind: 'win', track: 'boonta', difficulty: 'amateur' } },
  // Precise cornering and a cool engine, fragile hull.
  { id: 'ebe', name: 'Ebe Endocott', species: 'Triffian', make: 'JAK Racing J930 Dash-8', livery: livery('#d0e8f0', '#1878a8', '#f0c040', '#1a6890', 0.92), stats: stats(213, 57, 1.06, 0.92, 1.12, 1.05), traits: { lane: 12, pace: 0.97, aggression: 0.2 }, unlock: { kind: 'podium', track: 'ando', difficulty: 'amateur' } },
  // Brawler: shrugs off contact, sluggish and slow to fix.
  { id: 'dud', name: 'Dud Bolt', species: 'Vulptereen', make: 'Vokoff-Strood Plug-8G 927', livery: livery('#8a8a9a', '#3a3a6a', '#c0a040', '#4a4a7a', 1.12), stats: stats(214, 54, 0.93, 1.02, 0.82, 0.85), traits: { lane: 6, pace: 0.98, aggression: 1.3 }, unlock: { kind: 'win', track: 'malastare', difficulty: 'amateur' } },
  // Quick and tidy, but a hot engine.
  { id: 'bozzie', name: 'Bozzie Baranta', species: 'Shistavanen', make: 'Shelba 730S Razor', livery: livery('#a8c0d8', '#a02838', '#e8e8e8', '#8a2030', 0.96), stats: stats(219, 56, 1.02, 1.1, 1, 0.92), traits: { lane: -6, pace: 0.98, aggression: 0.7 }, unlock: { kind: 'podium', track: 'baroonda', difficulty: 'amateur' } },
  // Cockpit hung far ahead of the engines: twitchy and agile, easy to break.
  { id: 'neva', name: 'Neva Kee', species: 'Xamster', make: 'FG 8T8-Twin Block2 Special', livery: livery('#d8f0c0', '#407a20', '#e0e0a0', '#50902a', 0.9), stats: stats(214, 58, 1.1, 1, 1.15, 0.95), traits: { lane: 14, pace: 0.99, aggression: 0.3 }, unlock: { kind: 'win', track: 'ando', difficulty: 'semipro' } },
  // Wasp engines: lively acceleration and a good crew, slightly fragile.
  { id: 'clegg', name: 'Clegg Holdfast', species: 'Nosaurian', make: 'Keizar-Volvec KV9T9-B Wasp', livery: livery('#f0d8b0', '#2a5a3a', '#d8a040', '#3a6a4a', 0.98), stats: stats(217, 58, 1.04, 1, 1.1, 1.05), traits: { lane: -12, pace: 0.99, aggression: 0.4 }, unlock: { kind: 'win', track: 'boonta', difficulty: 'semipro' } },
  // Big slow tank that hardly heats and hardly breaks.
  { id: 'bumpy', name: "Ark 'Bumpy' Roose", species: 'Nuknog', make: 'Vokoff-Strood Plug-2 Behemoth', livery: livery('#c0a880', '#5a4020', '#808080', '#6a5030', 1.2), stats: stats(209, 51, 0.88, 0.82, 0.8, 1), traits: { lane: 2, pace: 0.98, aggression: 1 }, unlock: { kind: 'podium', track: 'malastare', difficulty: 'semipro' } },
  // Tiny Aleena in a tiny pod: the most agile in the field, made of paper.
  { id: 'ratts', name: 'Ratts Tyerell', species: 'Aleena', make: 'Vokoff-Strood Titan 2150', livery: livery('#b0d0f0', '#2050a0', '#f0f0f0', '#3060b0', 0.8), stats: stats(212, 61, 1.15, 1, 1.32, 1), traits: { lane: -4, pace: 1.0, aggression: 0.2 }, unlock: { kind: 'win', track: 'baroonda', difficulty: 'semipro' } },
  // Turbodyne: very fast and tough, poor in tight sections and slow to repair.
  { id: 'wan', name: 'Wan Sandage', species: 'Devlikk', make: 'Elsinore-Cordova Turbodyne 99-U', livery: livery('#e8c8a0', '#205060', '#c0c0c0', '#2a6070', 1.06), stats: stats(225, 54, 0.92, 1.08, 0.95, 0.88), traits: { lane: 10, pace: 1.0, aggression: 0.6 }, unlock: { kind: 'win', track: 'malastare', difficulty: 'galactic' } },
  // Quadrijet: raw speed with a hot engine and weak turn in.
  { id: 'boles', name: 'Boles Roor', species: 'Sneevel', make: 'Bin Gassi Quadrijet 4Barrel 904E', livery: livery('#f0f0e0', '#c09020', '#606060', '#a07a18', 1.14), stats: stats(227, 53, 0.9, 1.12, 1.05, 0.95), traits: { lane: -8, pace: 1.01, aggression: 0.5 }, unlock: { kind: 'podium', track: 'any', difficulty: 'galactic' } },
  // Four engine monster: the highest top speed in the field and the most fragile pod.
  { id: 'ben', name: 'Ben Quadinaros', species: 'Toong', make: 'Balta-Trabaat BT310 Quadra-Pod', livery: livery('#e0e0f0', '#808020', '#f0d040', '#9a9a28', 1.18), stats: stats(235, 50, 0.86, 1.15, 1.35, 0.8), traits: { lane: 6, pace: 1.02, aggression: 0.2 }, unlock: { kind: 'win', track: 'ando', difficulty: 'galactic' } },
  // The champion and final reward: fast and tough, overheats early. Only he carries the flame vent.
  { id: 'sebulba', name: 'Sebulba', species: 'Dug', make: 'Collor Pondrat Plug-F Mammoth', livery: livery('#ffb070', '#7a2e10', '#2a2a2a', '#c4601c', 1.22), stats: stats(228, 56, 0.95, 1.25, 0.82, 0.9), traits: { lane: -6, pace: 1.03, aggression: 1.6, flame: true }, unlock: { kind: 'win', track: 'boonta', difficulty: 'galactic' } },
];

export function pilotById(id: string): PilotDef {
  return ROSTER.find((p) => p.id === id) ?? ROSTER[0];
}

export function isUnlocked(p: PilotDef, settings: Settings): boolean {
  return p.unlock === null || settings.unlocked.includes(p.id);
}

/** Track names for unlock hints (own keys so the hint does not depend on the track list module). */
const TRACK_NAME: Record<string, StringKey> = {
  boonta: 'pilot.track.boonta',
  ando: 'pilot.track.ando',
  malastare: 'pilot.track.malastare',
  baroonda: 'pilot.track.baroonda',
};

const DIFF_NAME: Record<Difficulty, StringKey> = {
  amateur: 'diff.amateur',
  semipro: 'diff.semipro',
  galactic: 'diff.galactic',
};

/** Localised "how to unlock" line, '' for starting pilots. */
export function unlockHint(p: PilotDef): string {
  const u = p.unlock;
  if (!u) return '';
  const track = u.track === 'any' ? t('pilot.track.any') : t(TRACK_NAME[u.track] ?? 'pilot.track.any');
  return t(u.kind === 'win' ? 'pilot.unlock.win' : 'pilot.unlock.podium', { track, diff: t(DIFF_NAME[u.difficulty]) });
}

/** Apply a finished race to the unlocks. Mutates settings.unlocked; returns the newly unlocked pilots. */
export function checkUnlocks(settings: Settings, result: { track: string; difficulty: Difficulty; position: number }): PilotDef[] {
  const level = DIFFICULTIES.indexOf(result.difficulty);
  const fresh: PilotDef[] = [];
  for (const p of ROSTER) {
    const u = p.unlock;
    if (!u || settings.unlocked.includes(p.id)) continue;
    if (u.track !== 'any' && u.track !== result.track) continue;
    if (level < DIFFICULTIES.indexOf(u.difficulty)) continue;
    if (result.position > (u.kind === 'win' ? 1 : 3)) continue;
    settings.unlocked.push(p.id);
    fresh.push(p);
  }
  return fresh;
}

/** `count` distinct rivals not in `exclude`, shuffled deterministically by `seed`. */
export function pickRivals(exclude: readonly string[], count: number, seed: number): PilotDef[] {
  const pool = ROSTER.filter((p) => !exclude.includes(p.id));
  const rnd = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}
