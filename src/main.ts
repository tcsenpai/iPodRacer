// Graphics prototype: Anakin's podracer flies the Boonta-style loop on autopilot over the procedural
// Tatooine dune sea. C cycles cameras (chase / cockpit / trackside), 1-3 set quality.
// Gameplay (input, physics, rivals, laps, HUD, menus, audio) is still to be built: see AGENTS.md.
import '@fontsource/orbitron/600.css';
import './style.css';
import * as THREE from 'three';
import { Engine, type Quality } from './core/engine';
import { clamp, damp } from './core/rng';
import { t } from './i18n/i18n';
import { createPodracer } from './models/podracer';
import { DustTrail } from './world/dust';
import { buildProps } from './world/props';
import { buildDesertSky } from './world/sky';
import { buildTerrain, groundHeight } from './world/terrain';
import { Track } from './world/track';

const app = document.getElementById('app')!;
const engine = new Engine(app);
const scene = new THREE.Scene();
const sky = buildDesertSky(scene, engine.renderer);
const track = new Track();
scene.add(buildTerrain(track), buildProps(track));
const pod = createPodracer();
scene.add(pod.root);
const dust = new DustTrail();
scene.add(dust.points);
engine.setScene(scene);

const label = document.createElement('div');
label.className = 'label';
app.appendChild(label);
const CAMERAS = ['chase', 'cockpit', 'trackside', 'showcase'] as const;
let camMode: (typeof CAMERAS)[number] = 'chase';
const showLabel = () => (label.textContent = `${t('demo.title')} · ${t(`demo.cam.${camMode}`)} · ${t('demo.keys')}`);
showLabel();

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyC') {
    camMode = CAMERAS[(CAMERAS.indexOf(camMode) + 1) % CAMERAS.length];
    showLabel();
  }
  const q: Record<string, Quality> = { Digit1: 'low', Digit2: 'medium', Digit3: 'high' };
  if (q[e.code]) engine.setQuality(q[e.code]);
});

const SPEED = 190; // m/s (~680 km/h)
const HOVER = 2.4;
let u = 0;
const p = new THREE.Vector3();
const tng = new THREE.Vector3();
const right = new THREE.Vector3();
const ahead = new THREE.Vector3();
const prevTng = new THREE.Vector3(0, 0, -1);
const m = new THREE.Matrix4();
const qRoll = new THREE.Quaternion();
const camTarget = new THREE.Vector3();
const trackside = new THREE.Vector3();
let roll = 0;
const wash = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
let time = 0;
let last = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  u = (u + (SPEED * dt) / track.length) % 1;

  // Autopilot: weave a little around the racing line, hover over the sand, bank into the turns.
  track.frame(u, p, tng, right);
  const weave = Math.sin(time * 0.7) * 9;
  p.addScaledVector(right, weave);
  p.y = groundHeight(track, p.x, p.z) + HOVER;
  track.frame(u + 40 / track.length, ahead, tng, right);
  ahead.addScaledVector(right, Math.sin((time + 0.2) * 0.7) * 9);
  ahead.y = groundHeight(track, ahead.x, ahead.z) + HOVER;
  const turn = prevTng.x * tng.z - prevTng.z * tng.x; // signed heading change this frame
  prevTng.copy(tng);
  roll += (clamp((turn / Math.max(dt, 1e-3)) * 2.2, -0.9, 0.9) - roll) * damp(3, dt);
  pod.root.position.copy(p);
  m.lookAt(p, ahead, THREE.Object3D.DEFAULT_UP);
  pod.root.quaternion.setFromRotationMatrix(m).multiply(qRoll.setFromAxisAngle(Z_AXIS, -roll));

  // Engines ride independently: small lag and bob; the cockpit swings on its cables.
  pod.engineL.position.y = Math.sin(time * 9) * 0.06;
  pod.engineR.position.y = Math.sin(time * 9 + 1.3) * 0.06;
  pod.engineL.rotation.z = pod.engineR.rotation.z = roll * 0.3;
  pod.cockpit.position.x = -roll * 1.2;
  pod.cockpit.rotation.z = roll * 0.5;
  pod.update(dt, 0.85);

  // Repulsor wash: sand thrown up under each engine.
  for (const e of [pod.engineL, pod.engineR]) {
    camTarget.set(0, 0, 4).applyMatrix4(e.matrixWorld);
    camTarget.y = groundHeight(track, camTarget.x, camTarget.z) + 0.5;
    dust.emit(camTarget, wash.copy(tng).multiplyScalar(SPEED * 0.25), 3);
  }
  dust.update(dt);

  // Cameras.
  const cam = engine.camera;
  if (camMode === 'chase') {
    pod.chaseAnchor.getWorldPosition(camTarget);
    cam.position.lerp(camTarget, 1 - Math.exp(-dt * 30)); // stiff follow: at 190 m/s a soft spring trails ~20 m
    const look = pod.root.localToWorld(ahead.set(0, 0.8, -12));
    cam.up.set(0, 1, 0);
    cam.lookAt(look);
  } else if (camMode === 'cockpit') {
    pod.eyeAnchor.getWorldPosition(cam.position);
    cam.quaternion.copy(pod.root.quaternion);
  } else if (camMode === 'showcase') {
    // Slow orbit around the pod: the beauty shot for checking the model and materials.
    const a = time * 0.35;
    cam.position.copy(pod.root.localToWorld(camTarget.set(Math.sin(a) * 16, 3.5, 4 + Math.cos(a) * 16)));
    cam.up.set(0, 1, 0);
    cam.lookAt(pod.root.localToWorld(ahead.set(0, 0, 4)));
  } else {
    // Trackside: a camera planted 300 m ahead beside the track, re-planted as the pod passes it.
    if (trackside.lengthSq() === 0 || trackside.distanceTo(p) > 420) {
      track.frame(u + 300 / track.length, trackside, tng, right);
      trackside.addScaledVector(right, 55);
      trackside.y = groundHeight(track, trackside.x, trackside.z) + 4;
    }
    cam.position.copy(trackside);
    cam.up.set(0, 1, 0);
    cam.lookAt(p);
  }
  const fov = camMode === 'cockpit' ? 82 : 72;
  if (cam.fov !== fov) {
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }
  sky.update(cam, p);
  engine.render(time);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { app: { engine, scene, track, pod, seek: (v: number) => (u = v) } });
