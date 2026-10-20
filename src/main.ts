// iPodRacer: title screen over a showcase of Anakin's pod, then the Boonta Eve race (three laps, five
// rivals, three circuit difficulties), pause and results. All rendering, sound and UI are procedural.
import '@fontsource/orbitron/600.css';
import './style.css';
import * as THREE from 'three';
import { GameAudio } from './audio/audio';
import { Engine } from './core/engine';
import { Input } from './core/input';
import { loadSettings, saveSettings, type Settings } from './core/settings';
import { CameraRig } from './game/camera';
import { Fx } from './game/fx';
import { Pod } from './game/pod';
import { Race } from './game/race';
import { ANAKIN_LIVERY } from './models/podracer';
import { Hud } from './ui/hud';
import { Menus } from './ui/menus';
import { DustTrail } from './world/dust';
import { buildLife } from './world/life';
import { buildProps } from './world/props';
import { buildDesertSky } from './world/sky';
import { buildTerrain } from './world/terrain';
import { Track } from './world/track';

const app = document.getElementById('app')!;
const settings: Settings = loadSettings();
const engine = new Engine(app);
engine.setQuality(settings.quality);
const scene = new THREE.Scene();
const sky = buildDesertSky(scene, engine.renderer);
const track = new Track();
const props = buildProps(track);
const life = buildLife(track);
const colliders = [...props.colliders, ...life.colliders];
scene.add(buildTerrain(track), props.group, life.group);
const dust = new DustTrail();
const fx = new Fx();
scene.add(dust.points, fx.group);
engine.setScene(scene);

const input = new Input();
const audio = new GameAudio();
audio.setVolume(settings.volume);
const hud = new Hud(app, track.centerXZ());
hud.setVisible(false);
const rig = new CameraRig(engine.camera, track);
rig.mode = settings.camera;

// Title backdrop: Anakin's pod idling on the grid, the camera circling it.
const showcase = new Pod({ name: 'Anakin Skywalker', species: 'Human', make: 'Radon-Ulzer 620C', livery: ANAKIN_LIVERY }, true);
showcase.place(track, -80 / track.length, 0, 0);
const showcaseList = [showcase];

type State = 'title' | 'race' | 'paused' | 'results';
let state: State = 'title';
let race: Race | null = null;

function showTitle(): void {
  race?.dispose();
  race = null;
  state = 'title';
  scene.add(showcase.model.root);
  rig.setShot({ kind: 'orbit', pod: showcase });
  hud.setVisible(false);
  audio.setRacing(false);
  audio.music('menu');
  engine.speed = engine.damage = 0;
  menus.showTitle();
}

function startRace(): void {
  audio.unlock();
  race?.dispose();
  scene.remove(showcase.model.root);
  menus.hide();
  input.clearPresses();
  rig.mode = settings.camera;
  race = new Race({ scene, engine, track, colliders, hud, audio, fx, dust, rig }, settings.difficulty);
  state = 'race';
}

function setPaused(on: boolean): void {
  if (!race) return;
  state = on ? 'paused' : 'race';
  audio.setRacing(!on);
  input.clearPresses();
  if (on) menus.showPause();
  else menus.hide();
}

function showResults(r: Race): void {
  state = 'results';
  const rows = r.results();
  const me = r.player;
  const pos = r.playerPosition;
  const best = settings.best[r.difficulty];
  const time = me.finishTime ?? Infinity;
  const newBest = !best || pos < best.position || (pos === best.position && time < best.time);
  if (newBest) settings.best[r.difficulty] = { time, lap: Math.min(...me.lapTimes), position: pos };
  settings.camera = rig.mode;
  saveSettings(settings);
  audio.music('menu');
  hud.setVisible(false);
  menus.showResults(rows, pos, newBest, r.difficulty);
}

const menus = new Menus(app, settings, {
  start: startRace,
  settingsChanged(s) {
    engine.setQuality(s.quality);
    audio.setVolume(s.volume);
    rig.mode = s.camera;
    saveSettings(s);
  },
  resume: () => setPaused(false),
  restart: startRace,
  quit: () => {
    if (race) settings.camera = rig.mode;
    saveSettings(settings);
    showTitle();
  },
  uiSound: (kind) => audio.ui(kind),
});

// Browsers only start audio from a user gesture.
const unlock = () => audio.unlock();
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

let last = performance.now();
let time = 0;
function frame(now: number): void {
  const real = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += real;

  if (race && state !== 'paused') {
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
  if (state !== 'paused') {
    dust.update(real * (race?.timeScale ?? 1));
    fx.update(real * (race?.timeScale ?? 1), engine.renderer.domElement.clientHeight);
    rig.update(real, race?.player ?? showcase);
    life.update(real, engine.camera, race?.pods ?? showcaseList);
  }
  sky.update(engine.camera, race?.player.pos ?? showcase.pos);
  engine.render(time);
  requestAnimationFrame(frame);
}

showTitle();
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, {
    app: {
      engine,
      scene,
      track,
      rig,
      /** Step the race headlessly (no rendering) for `seconds` of game time. */
      sim(seconds: number, dt = 1 / 60) {
        for (let s = 0; s < seconds && race; s += dt) race.update(dt, dt, input);
      },
      settings,
      start: startRace,
      get race() {
        return race;
      },
      get state() {
        return state;
      },
    },
  });
}
