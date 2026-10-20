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

/** A gorge section: the ground is raised to a plateau around (x, z) so the course cuts through rock. */
export interface Canyon {
  x: number;
  z: number;
  r: number;
  height: number;
}

/** A round dip in the ground (lake bed under the liquid level, or just a hollow). */
export interface Basin {
  x: number;
  z: number;
  r: number;
  /** Ground height at the bottom (m). */
  floor: number;
}

/**
 * Natural ground generator per planet. Every kind shares the canyons and basins; the kind picks the
 * relief (dune sea, alpine ridges, grass plains with mesas, coastal lowlands).
 */
export interface TerrainTheme {
  kind: 'dunes' | 'alpine' | 'plains' | 'coast';
  basins: readonly Basin[];
  /** Volcanic cone with a crater (coast kind only uses it, but any kind may). */
  volcano: { x: number; z: number; r: number; height: number } | null;
  /** Sea side: the ground drops under the liquid where nx * x + nz * z exceeds d. */
  coast: { nx: number; nz: number; d: number } | null;
  /** Distant mountain wall around the course: height (m) reached 2.5 km beyond the course's outer edge. */
  rim: number;
}

/** Visual liquid level. Physics hovers over max(ground, level), so pods skim it like solid ground. */
export interface LiquidTheme {
  kind: 'ice' | 'methane' | 'sea';
  level: number;
  /** Linear albedo (ice, sea) or glow colour (methane). */
  color: RGB;
  /** Deep / far tint. */
  deep: RGB;
}

/** Linear albedos and knobs for the shared procedural surface shader (./surface). */
export interface SurfaceTheme {
  /** Strata colours from soft to hard bands. */
  rock: readonly [RGB, RGB, RGB];
  /** Loose ground (sand, snow, grass, ash) and its darker variant. */
  ground: RGB;
  groundDark: RGB;
  /** Packed racing bed. */
  bed: RGB;
  /** Patches on flat open ground (grass tufts, moss, wind-polished ice), with coverage 0..1. */
  cover: RGB;
  coverAmount: number;
  /** Wind ripple strength (1 = Tatooine sand). */
  ripple: number;
  /** Grain glint strength (1 = sand, more for snow crystals) and tint. */
  glint: number;
  glintColor: RGB;
  /** Strata banding contrast (1 = sandstone, low for granite and basalt). */
  strata: number;
}

export interface SkyTheme {
  zenith: RGB;
  horizon: RGB;
  /** Below-horizon tint (seen past the terrain's edge and in the IBL from below). */
  ground: RGB;
  /** Forward-scattering glow around the sun and the HDR disc colour. */
  glow: RGB;
  disc: RGB;
  /** Optional second sun (Tatoo II): direction, glow and disc. */
  sun2: { dir: readonly [number, number, number]; glow: RGB; disc: RGB } | null;
}

export interface LightTheme {
  sun: number;
  sunIntensity: number;
  /** Second fill light along sky.sun2 (ignored without a second sun). */
  sun2: number;
  sun2Intensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Image-based lighting strength. */
  env: number;
  fogDensity: number;
}

/** Start area: Mos Espa (Tatooine only) or a smaller paddock of grandstands and flags. */
export interface VenueTheme {
  kind: 'mos-espa' | 'paddock';
  /** Stand tier tones, trim and wall colours (vertex colours over the plaster texture). */
  tones: readonly number[];
  trim: number;
  wall: number;
}

export interface Theme {
  /** Stable: horizon dressing. */
  horizon: HorizonTheme;
  /** Stable: fog colour (hex) used to blend far objects into the atmosphere. */
  fogColor: number;
  /** Stable: unit direction toward the main sun (lighting, flare, horizon shading). */
  sunDir: readonly [number, number, number];
  terrain: TerrainTheme;
  liquid: LiquidTheme | null;
  surface: SurfaceTheme;
  sky: SkyTheme;
  light: LightTheme;
  /** Repulsor dust colour (linear). */
  dust: RGB;
  /** Track-side rock set: sandstone hoodoos, ice spires, rock towers, basalt columns and ruins. */
  props: 'hoodoos' | 'ice' | 'towers' | 'basalt';
  venue: VenueTheme;
  /** Tusken snipers on the canyon rims, moisture farms, banthas (Tatooine). */
  tuskens: boolean;
  /** Flame geysers erupting from the racing bed (Malastare). */
  geysers: boolean;
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
  /** Closed centreline control points [x, z, floor height] (m), start/finish at the first one. */
  control: readonly (readonly [number, number, number])[];
  canyons: readonly Canyon[];
}
