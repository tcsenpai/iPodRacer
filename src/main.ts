// iPodRacer: title screen over a showcase pod on the selected course, circuit and pilot selection, then a
// race (one player, or two in split screen) on any of the planets, pause and results. Each course's world
// is generated when it is chosen. All rendering, sound and UI are procedural.
import '@fontsource/orbitron/600.css';
import './style.css';
import { Announcer } from './audio/announcer';
import { GameAudio } from './audio/audio';
import { Engine } from './core/engine';
import { Input } from './core/input';
import { bestKey, loadSettings, saveSettings, type Settings } from './core/settings';
import { CameraRig } from './game/camera';
import { Fx } from './game/fx';
import { Pod } from './game/pod';
import { Race } from './game/race';
import { checkUnlocks, pilotById, type PilotDef } from './game/roster';
import { t } from './i18n/i18n';
import { Hud, createSplitContainers, removeSplitContainers } from './ui/hud';
import { Menus } from './ui/menus';
import { DustTrail } from './world/dust';
import { trackById } from './world/tracks';
import { buildWorld, type World } from './world/world';

const app = document.getElementById('app')!;
const settings: Settings = loadSettings();
const engine = new Engine(app);
engine.setQuality(settings.quality);
const dust = new DustTrail();
const fx = new Fx();

const input = new Input();
const audio = new GameAudio();
audio.setVolume(settings.volume);
const announcer = new Announcer();
announcer.enabled = settings.announcer;

let world: World = buildWorld(trackById(settings.track), engine.renderer);
world.scene.add(dust.points, fx.group);
dust.tint.setRGB(...world.def.theme.dust);
engine.setScene(world.scene);

/** One rig per view (engine.cameras always holds both; the second only renders in split screen). */
const rigs = engine.cameras.map((camera) => new CameraRig(camera, world.track));
for (const r of rigs) r.mode = settings.camera;
/** Live race HUDs (one per view), rebuilt per race: the minimap depends on the course. */
let huds: Hud[] = [];

/** Title backdrop: player 1's pod idling on the grid, the camera circling it. Cached per pilot. */
const showcases = new Map<string, Pod>();
let showcase = showcasePod(settings.pilots[0]);
const showcaseList = [showcase];

type State = 'title' | 'race' | 'paused' | 'results';
let state: State = 'title';
let race: Race | null = null;
/** Rival selection seed: a new field per start from the menus, the same one on "race again". */
let seed = 1;

function showcasePod(id: string): Pod {
  let pod = showcases.get(id);
  if (!pod) {
    pod = new Pod(pilotById(id), true);
    showcases.set(id, pod);
  }
  pod.place(world.track, -80 / world.track.length, 0, 0);
  return pod;
}

/** Put `id`'s pod on the backdrop (title and selection screens only). */
function setShowcase(id: string): void {
  world.scene.remove(showcase.model.root);
  showcase = showcasePod(id);
  showcaseList[0] = showcase;
  if (race) return;
  world.scene.add(showcase.model.root);
  rigs[0].setShot({ kind: 'orbit', pod: showcase });
}

/** Build the course `id` if it is not the current world, behind the loading veil. */
async function selectTrack(id: string): Promise<void> {
  if (world.def.id === id) return;
  const def = trackById(id);
  menus.setLoading(t('menu.loading', { planet: def.planet }));
  // Two frames so the veil is on screen before the synchronous build blocks the thread.
  await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  const next = buildWorld(def, engine.renderer);
  // Shared pools and pods must leave the old scene first: setScene disposes everything still in it.
  world.scene.remove(dust.points, fx.group, showcase.model.root);
  world = next;
  world.scene.add(dust.points, fx.group);
  dust.tint.setRGB(...def.theme.dust);
  engine.setScene(world.scene);
  for (const r of rigs) r.track = world.track;
  setShowcase(settings.pilots[0]);
  menus.setLoading(null);
}

function disposeHuds(): void {
  for (const h of huds) h.dispose();
  huds = [];
  removeSplitContainers(app);
}

function showTitle(): void {
  race?.dispose();
  race = null;
  disposeHuds();
  state = 'title';
  engine.setViewCount(1);
  input.split = false;
  setShowcase(settings.pilots[0]);
  audio.setRacing(false);
  audio.music('menu');
  for (const v of engine.fx) v.speed = v.damage = v.flash = 0;
  menus.showTitle();
}

function startRace(): void {
  audio.unlock();
  race?.dispose();
  race = null;
  disposeHuds();
  world.scene.remove(showcase.model.root);
  menus.hide();
  input.clearPresses();
  const two = settings.players === 2;
  engine.setViewCount(two ? 2 : 1);
  input.split = two;
  const xz = world.track.centerXZ();
  if (two) {
    const [top, bottom] = createSplitContainers(app);
    huds = [new Hud(top, xz, { compact: true, label: t('split.tag1'), slot: 0 }), new Hud(bottom, xz, { compact: true, label: t('split.tag2'), slot: 1 })];
  } else huds = [new Hud(app, xz)];
  for (const r of rigs) r.mode = settings.camera;
  const pilots: PilotDef[] = huds.map((_, i) => pilotById(settings.pilots[i]));
  race = new Race(
    { scene: world.scene, engine, track: world.track, colliders: world.colliders, huds, rigs: rigs.slice(0, huds.length), audio, fx, dust, announcer },
    settings.difficulty,
    pilots,
    seed,
  );
  state = 'race';
}

function setPaused(on: boolean): void {
  if (!race) return;
  state = on ? 'paused' : 'race';
  audio.setRacing(!on);
  if (on) announcer.stop();
  input.clearPresses();
  if (on) menus.showPause();
  else menus.hide();
}

function showResults(r: Race): void {
  state = 'results';
  const def = world.def;
  const key = bestKey(def.id, r.difficulty);
  const positions = r.players.map((_, i) => r.position(i));
  let newBest = false;
  r.players.forEach((pod, i) => {
    // A split-screen straggler timed out before the line has no time to record.
    if (pod.finishTime === null) return;
    const pos = positions[i];
    const best = settings.best[key];
    if (best && (pos > best.position || (pos === best.position && pod.finishTime >= best.time))) return;
    settings.best[key] = { time: pod.finishTime, lap: Math.min(...pod.lapTimes), position: pos };
    newBest = true;
  });
  const unlocked: PilotDef[] = [];
  for (const position of positions) {
    for (const p of checkUnlocks(settings, { track: def.id, difficulty: r.difficulty, position })) if (!unlocked.includes(p)) unlocked.push(p);
  }
  settings.camera = rigs[0].mode;
  saveSettings(settings);
  audio.music('menu');
  for (const h of huds) h.setVisible(false);
  menus.showResults({ rows: r.results(), positions, newBest, difficulty: r.difficulty, track: def, unlocked });
}

const menus = new Menus(app, settings, {
  start() {
    seed = (Math.random() * 0x7fffffff) | 0;
    startRace();
  },
  selectTrack,
  previewPilot: setShowcase,
  settingsChanged(s) {
    engine.setQuality(s.quality);
    audio.setVolume(s.volume);
    for (const r of rigs) r.mode = s.camera;
    announcer.enabled = s.announcer;
    if (!s.announcer) announcer.stop();
    saveSettings(s);
  },
  resume: () => setPaused(false),
  restart: startRace,
  quit: () => {
    if (race) settings.camera = rigs[0].mode;
    saveSettings(settings);
    showTitle();
  },
  uiSound: (kind) => audio.ui(kind),
});

// Browsers only start audio from a user gesture.
const unlock = () => audio.unlock();
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

// Split screen renders the scene once per view: re-centre sky, horizon and shadows on each player.
engine.onView = (i, camera) => {
  if (race && race.players.length > 1) world.view(camera, race.players[i].pos);
};

let last = performance.now();
let time = 0;
function frame(now: number): void {
  const real = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += real;

  if (race && state !== 'paused') {
    // Pause from any player's keys or pad.
    if (state === 'race' && race.phase !== 'finished' && input.consume('pause')) setPaused(true);
    else {
      const dt = real * race.timeScale;
      race.update(dt, real, input);
      if (state === 'race' && race.phase === 'finished' && race.finishedFor > 6) showResults(race);
    }
  } else if (state === 'title') {
    showcase.syncModel(real);
    input.clearPresses();
  }
  const paused = state === 'paused';
  if (!paused) {
    const scaled = real * (race?.timeScale ?? 1);
    dust.update(scaled);
    fx.update(scaled, engine.viewHeight);
    if (race) for (let i = 0; i < race.players.length; i++) rigs[i].update(real, race.players[i]);
    else rigs[0].update(real, showcase);
  }
  world.update(paused ? 0 : real, engine.camera, race?.player.pos ?? showcase.pos, race?.pods ?? showcaseList);
  engine.render(time);
  requestAnimationFrame(frame);
}

showTitle();
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, {
    app: {
      engine,
      get scene() {
        return world.scene;
      },
      get track() {
        return world.track;
      },
      get world() {
        return world;
      },
      rig: rigs[0],
      rigs,
      /** Step the race headlessly (no rendering) for `seconds` of game time. */
      sim(seconds: number, dt = 1 / 60) {
        for (let s = 0; s < seconds && race; s += dt) race.update(dt, dt, input);
      },
      settings,
      start: startRace,
      /** Build another course (same path as the track-select screen). */
      selectTrack,
      get race() {
        return race;
      },
      get state() {
        return state;
      },
    },
  });
}
