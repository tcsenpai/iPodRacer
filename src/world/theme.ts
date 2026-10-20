// Shared contract for multiple tracks on different planets. A TrackDef is everything needed to build a
// race venue: course layout, canyons, planet look (Theme) and which set dressing / hazards apply.
// Owned by the world layer; game, UI and horizon code read only the fields documented as stable here.
import type { StringKey } from '../i18n/i18n';

export type RGB = readonly [number, number, number];

/** A distant body in the sky (moon, gas giant, second sun drawn as a body). Direction is world-space toward it. */
export interface SkyBody {
  dir: readonly [number, number, number];
  /** Angular radius in radians. */
  radius: number;
  color: RGB;
  /** 0..1 how much of the disc is lit (phase), 1 = full. */
  lit: number;
  /** Optional ring (gas giants). */
  ring?: boolean;
}

/** Horizon dressing (stable: read by world/horizon.ts). */
export interface HorizonTheme {
  /** Base colour of the far mountain silhouettes before aerial perspective. */
  mountains: RGB;
  /** Typical height (m) of the far ranges and how jagged they are 0..1. */
  mountainHeight: number;
  jagged: number;
  /** Cloud cover 0..1 and cloud tint. */
  clouds: number;
  cloudColor: RGB;
  bodies: readonly SkyBody[];
  /** Named landmarks to place on the horizon (implementation-defined ids, e.g. 'jabba-palace'). */
  landmarks: readonly string[];
  /** Ambient life in the sky: ships / birds flying over. */
  flyers: 'ships' | 'birds' | 'none';
  /** Ground-level atmospherics near the horizon. */
  dustDevils: boolean;
}

export interface Theme {
  /** Stable: horizon dressing. */
  horizon: HorizonTheme;
  /** Stable: fog colour (hex) used to blend far objects into the atmosphere. */
  fogColor: number;
  /** Stable: unit direction toward the main sun (lighting, flare, horizon shading). */
  sunDir: readonly [number, number, number];
  // The world layer may add further fields (sky gradient, palettes, surface kind, water, props, life...).
}

export interface TrackDef {
  /** Stable: id used for saves (best results per track) and selection. */
  id: string;
  /** Stable: planet name, a proper noun shown as is (not translated). */
  planet: string;
  /** Stable: i18n keys for the track name and a one-line description. */
  nameKey: StringKey;
  descKey: StringKey;
  /** Stable: laps per race. */
  laps: number;
  theme: Theme;
}
