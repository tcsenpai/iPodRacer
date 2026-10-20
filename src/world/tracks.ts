// The courses. Each TrackDef is a complete venue: layout (control points, gorges) plus the planet look
// (relief, liquids, surface palette, sky, lights, props, start area, hazards). Layout rules, checked
// numerically when a course is authored: closed loop 10-16 km, smoothed curve radius >= 250 m (the
// corridor mesh folds below that), no self-crossing, separate parts of the loop >= 800 m apart (two
// corridors never overlap), liquid levels at least 1 m under the track floor.
// Surface, sky, light and dust colours are linear; horizon colours are sRGB (read by ./horizon).
import type { RGB, Theme, TrackDef } from './theme';

/** Unit vector toward a sun from a rough direction (keeps the authored numbers readable). */
function unit(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

const NONE: RGB = [0, 0, 0];

// Tatooine: the original Boonta Eve look, value for value.
const TATOOINE: Theme = {
  horizon: {
    mountains: [0.78, 0.62, 0.46],
    mountainHeight: 380,
    jagged: 0.45,
    clouds: 0.05,
    cloudColor: [1, 0.97, 0.92],
    bodies: [
      { dir: unit(-0.55, 0.42, -0.72), radius: 0.012, color: [0.93, 0.9, 0.84], lit: 0.55 },
      { dir: unit(-0.3, 0.55, -0.78), radius: 0.008, color: [0.88, 0.84, 0.8], lit: 0.8 },
    ],
    landmarks: ['jundland-wastes', 'jabba-palace', 'krayt-skeleton', 'mushroom-mesa', 'mos-espa-spires', 'sandcrawler-convoy'],
    flyers: 'ships',
    dustDevils: true,
  },
  fogColor: 0xdbcdb2,
  sunDir: unit(0.45, 0.32, -0.83),
  terrain: { kind: 'dunes', basins: [], volcano: null, coast: null, rim: 0 },
  liquid: null,
  surface: {
    rock: [
      [0.33, 0.15, 0.075],
      [0.5, 0.3, 0.15],
      [0.64, 0.5, 0.34],
    ],
    ground: [0.62, 0.45, 0.28],
    groundDark: [0.5, 0.34, 0.2],
    bed: [0.42, 0.31, 0.21],
    cover: NONE,
    coverAmount: 0,
    ripple: 1,
    glint: 1,
    glintColor: [1, 0.92, 0.78],
    strata: 1,
  },
  sky: {
    zenith: [0.16, 0.34, 0.66],
    horizon: [0.86, 0.8, 0.7],
    ground: [0.62, 0.5, 0.38],
    glow: [1, 0.85, 0.6],
    disc: [9, 8, 6.5],
    sun2: { dir: unit(0.36, 0.27, -0.89), glow: [1, 0.6, 0.35], disc: [7, 4.2, 2.4] },
  },
  light: { sun: 0xfff0d8, sunIntensity: 2.6, sun2: 0xffb070, sun2Intensity: 0.7, hemiSky: 0xbfd4ff, hemiGround: 0xc89060, hemiIntensity: 0.35, env: 0.7, fogDensity: 0.00009 },
  dust: [0.86, 0.7, 0.5],
  props: 'hoodoos',
  venue: { kind: 'mos-espa', tones: [0xcdb08a, 0xc4a27c, 0xbb9870, 0xd3b994], trim: 0xe4d6ba, wall: 0xbf9c74 },
  tuskens: true,
  geysers: false,
};

// Ando Prime: a low white sun over snowfields, granite ridges and frozen lakes.
const ANDO: Theme = {
  horizon: {
    mountains: [0.74, 0.79, 0.88],
    mountainHeight: 1400,
    jagged: 0.85,
    clouds: 0.35,
    cloudColor: [0.96, 0.97, 1],
    bodies: [{ dir: unit(0.5, 0.38, 0.78), radius: 0.02, color: [0.86, 0.9, 0.96], lit: 0.4 }],
    landmarks: ['ice-peaks', 'frozen-falls'],
    flyers: 'ships',
    dustDevils: false,
  },
  fogColor: 0xa9b8c9,
  sunDir: unit(-0.5, 0.3, -0.81),
  terrain: {
    kind: 'alpine',
    basins: [
      { x: 250, z: 2950, r: 760, floor: 0 },
      { x: -250, z: 1800, r: 700, floor: 0 },
      { x: 1500, z: 3800, r: 700, floor: 0 },
    ],
    volcano: null,
    coast: null,
    rim: 650,
  },
  liquid: { kind: 'ice', level: 8, color: [0.56, 0.7, 0.8], deep: [0.18, 0.32, 0.46] },
  surface: {
    rock: [
      [0.2, 0.21, 0.24],
      [0.32, 0.33, 0.36],
      [0.46, 0.47, 0.5],
    ],
    ground: [0.66, 0.71, 0.79],
    groundDark: [0.5, 0.57, 0.68],
    bed: [0.44, 0.5, 0.6],
    cover: [0.55, 0.68, 0.8],
    coverAmount: 0.35,
    ripple: 0.45,
    glint: 1.6,
    glintColor: [0.85, 0.92, 1],
    strata: 0.25,
  },
  sky: { zenith: [0.16, 0.3, 0.56], horizon: [0.6, 0.68, 0.78], ground: [0.55, 0.6, 0.68], glow: [0.6, 0.66, 0.75], disc: [8.5, 8.5, 8], sun2: null },
  light: { sun: 0xf4f6ff, sunIntensity: 2.0, sun2: 0, sun2Intensity: 0, hemiSky: 0xc8dcff, hemiGround: 0x9aa8b8, hemiIntensity: 0.4, env: 0.65, fogDensity: 0.00008 },
  dust: [0.92, 0.95, 1],
  props: 'ice',
  venue: { kind: 'paddock', tones: [0x9aa4b0, 0x8c96a4, 0xa8b2bc, 0x7e8896], trim: 0xd8dde4, wall: 0x6e7884 },
  tuskens: false,
  geysers: false,
};

// Malastare: grey-green grass plains, table mountains, glowing methane lakes, a ringed giant overhead.
const MALASTARE: Theme = {
  horizon: {
    mountains: [0.5, 0.55, 0.47],
    mountainHeight: 700,
    jagged: 0.5,
    clouds: 0.5,
    cloudColor: [0.88, 0.9, 0.84],
    bodies: [{ dir: unit(-0.4, 0.35, -0.85), radius: 0.09, color: [0.84, 0.74, 0.58], lit: 0.6, ring: true }],
    landmarks: ['methane-flares', 'gran-city'],
    flyers: 'ships',
    dustDevils: false,
  },
  fogColor: 0xb9c0aa,
  sunDir: unit(0.55, 0.38, 0.74),
  terrain: {
    kind: 'plains',
    basins: [
      { x: 2600, z: 650, r: 750, floor: -6 },
      { x: 1300, z: 2000, r: 650, floor: -6 },
      { x: -650, z: 1600, r: 900, floor: -6 },
      { x: 1500, z: -650, r: 650, floor: -6 },
      { x: 3000, z: 3500, r: 650, floor: -6 },
      { x: -2000, z: 2500, r: 800, floor: -6 },
    ],
    volcano: null,
    coast: null,
    rim: 280,
  },
  liquid: { kind: 'methane', level: 3, color: [0.25, 0.9, 0.7], deep: [0.03, 0.16, 0.14] },
  surface: {
    rock: [
      [0.26, 0.24, 0.2],
      [0.38, 0.35, 0.29],
      [0.52, 0.48, 0.4],
    ],
    ground: [0.24, 0.33, 0.12],
    groundDark: [0.15, 0.23, 0.08],
    bed: [0.38, 0.32, 0.24],
    cover: [0.14, 0.3, 0.06],
    coverAmount: 0.6,
    ripple: 0.15,
    glint: 0.2,
    glintColor: [1, 1, 0.9],
    strata: 0.6,
  },
  sky: { zenith: [0.18, 0.32, 0.52], horizon: [0.8, 0.78, 0.66], ground: [0.45, 0.48, 0.38], glow: [0.95, 0.9, 0.7], disc: [8.5, 7.8, 6], sun2: null },
  light: { sun: 0xfff2dc, sunIntensity: 2.5, sun2: 0, sun2Intensity: 0, hemiSky: 0xc0d4d8, hemiGround: 0x6e7a52, hemiIntensity: 0.4, env: 0.7, fogDensity: 0.00007 },
  dust: [0.55, 0.55, 0.45],
  props: 'towers',
  venue: { kind: 'paddock', tones: [0xc8bfa8, 0xb8ae96, 0xd2cab4, 0xa89e88], trim: 0xe8e2d0, wall: 0x8a8270 },
  tuskens: false,
  geysers: true,
};

// Baroonda: humid haze over black volcanic sand, jungle, a smoking volcano and the sea to the south.
const BAROONDA: Theme = {
  horizon: {
    mountains: [0.3, 0.36, 0.3],
    mountainHeight: 900,
    jagged: 0.6,
    clouds: 0.6,
    cloudColor: [0.9, 0.9, 0.88],
    bodies: [],
    landmarks: ['volcano', 'jungle-ruins'],
    flyers: 'birds',
    dustDevils: false,
  },
  fogColor: 0xc4c8bc,
  sunDir: unit(-0.35, 0.5, 0.79),
  terrain: { kind: 'coast', basins: [], volcano: { x: 900, z: -1300, r: 1100, height: 420 }, coast: { nx: 0, nz: 1, d: 200 }, rim: 350 },
  liquid: { kind: 'sea', level: 0, color: [0.04, 0.14, 0.16], deep: [0.02, 0.06, 0.09] },
  surface: {
    rock: [
      [0.07, 0.07, 0.075],
      [0.12, 0.115, 0.11],
      [0.2, 0.18, 0.16],
    ],
    ground: [0.17, 0.16, 0.15],
    groundDark: [0.11, 0.105, 0.1],
    bed: [0.22, 0.2, 0.18],
    cover: [0.07, 0.24, 0.05],
    coverAmount: 0.85,
    ripple: 0.35,
    glint: 0.7,
    glintColor: [1, 0.95, 0.85],
    strata: 0.2,
  },
  sky: { zenith: [0.24, 0.4, 0.6], horizon: [0.8, 0.8, 0.74], ground: [0.35, 0.38, 0.3], glow: [1, 0.88, 0.7], disc: [8.8, 8, 6.4], sun2: null },
  light: { sun: 0xfff0dc, sunIntensity: 2.3, sun2: 0, sun2Intensity: 0, hemiSky: 0xc8dcf0, hemiGround: 0x4a5a3a, hemiIntensity: 0.45, env: 0.75, fogDensity: 0.0001 },
  dust: [0.35, 0.33, 0.3],
  props: 'basalt',
  venue: { kind: 'paddock', tones: [0x8a8a78, 0x7c7e6c, 0x96968a, 0x6e705e], trim: 0xb8b6a0, wall: 0x5c5e4e },
  tuskens: false,
  geysers: false,
};

export const TRACKS: readonly TrackDef[] = [
  {
    id: 'boonta',
    planet: 'Tatooine',
    nameKey: 'track.boonta.name',
    descKey: 'track.boonta.desc',
    laps: 3,
    theme: TATOOINE,
    // 15.1 km, tightest radius ~246 m (the original course, unchanged).
    control: [
      [0, 0, 8],
      [900, -300, 10],
      [1900, -200, 14],
      [2700, 500, 20],
      [2900, 1500, 18],
      [2400, 2400, 12],
      [1500, 2800, 10],
      [700, 2300, 6],
      [400, 1500, 4],
      [-500, 1200, 6],
      [-1300, 1800, 10],
      [-2200, 1300, 14],
      [-2400, 300, 12],
      [-1700, -600, 9],
      [-800, -500, 8],
    ],
    canyons: [
      { x: 2850, z: 1000, r: 650, height: 95 },
      { x: -1850, z: 1550, r: 600, height: 80 },
    ],
  },
  {
    id: 'ando',
    planet: 'Ando Prime',
    nameKey: 'track.ando.name',
    descKey: 'track.ando.desc',
    laps: 3,
    theme: ANDO,
    // 15.4 km, tightest radius ~340 m: a climb into the eastern ice gorge, down past the frozen lakes,
    // then the western gorge.
    control: [
      [0, 0, 20],
      [1000, -150, 24],
      [2000, -100, 30],
      [2900, 300, 40],
      [3500, 1100, 48],
      [3600, 2100, 44],
      [3100, 2900, 36],
      [2200, 3300, 28],
      [1300, 3100, 20],
      [700, 2500, 14],
      [0, 2300, 10],
      [-800, 2700, 14],
      [-1600, 2500, 20],
      [-2100, 1800, 26],
      [-2000, 900, 24],
      [-1300, 300, 22],
      [-700, 0, 20],
    ],
    canyons: [
      { x: 3550, z: 1600, r: 650, height: 115 },
      { x: -1950, z: 1500, r: 600, height: 100 },
    ],
  },
  {
    id: 'malastare',
    planet: 'Malastare',
    nameKey: 'track.malastare.name',
    descKey: 'track.malastare.desc',
    laps: 3,
    theme: MALASTARE,
    // 15.4 km, tightest radius ~274 m: long flat-out straights between methane lakes, one gorge.
    control: [
      [0, 0, 6],
      [1200, -100, 6],
      [2400, -50, 8],
      [3500, 300, 10],
      [4200, 1100, 12],
      [4300, 2100, 10],
      [3700, 2800, 8],
      [2700, 2900, 6],
      [1900, 2400, 6],
      [1200, 2700, 8],
      [300, 3100, 10],
      [-600, 2900, 8],
      [-1300, 2200, 6],
      [-1500, 1200, 6],
      [-1100, 400, 6],
    ],
    canyons: [{ x: 4250, z: 1600, r: 650, height: 90 }],
  },
  {
    id: 'baroonda',
    planet: 'Baroonda',
    nameKey: 'track.baroonda.name',
    descKey: 'track.baroonda.desc',
    laps: 3,
    theme: BAROONDA,
    // 13.7 km, tightest radius ~313 m: along the shore, through a basalt gorge, around the volcano.
    control: [
      [0, 0, 4],
      [1000, 200, 4],
      [2000, 100, 5],
      [2900, -300, 8],
      [3500, -1100, 14],
      [3400, -2000, 22],
      [2700, -2600, 28],
      [1800, -2700, 30],
      [1000, -2300, 26],
      [300, -2600, 20],
      [-600, -2800, 16],
      [-1400, -2300, 12],
      [-1700, -1400, 8],
      [-1300, -600, 6],
      [-700, -150, 4],
    ],
    canyons: [{ x: 3500, z: -1550, r: 600, height: 95 }],
  },
];

/** Course by id; unknown ids (old saves, removed courses) fall back to the first one. */
export function trackById(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
