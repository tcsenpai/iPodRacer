// Procedural podracer in the style of Anakin's: two long turbine engines out front joined by a crackling
// energy binder, towing a small cockpit pod on control cables. Engines and cockpit are separate objects
// so gameplay can let them sway independently; update() re-fits the binder and cables every frame.
// Local frame: -Z forward, +Y up; the root origin sits between the engines.
import * as THREE from 'three';

export interface PodracerModel {
  readonly root: THREE.Group;
  readonly engineL: THREE.Group;
  readonly engineR: THREE.Group;
  readonly cockpit: THREE.Group;
  /** Chase-camera anchor (behind and above the cockpit) and pilot-eye anchor. */
  readonly chaseAnchor: THREE.Object3D;
  readonly eyeAnchor: THREE.Object3D;
  /** throttle 0..1 drives exhaust glow; call every frame after moving the parts. */
  update(dt: number, throttle: number): void;
}

const ENGINE_LEN = 7.2;
const ENGINE_GAP = 1.75; // centre offset of each engine from the root
const _X = new THREE.Vector3(1, 0, 0);
const COCKPIT_Z = 9.5; // cockpit trails this far behind the engines' rear

/** Painted engine skin: silver panels, blue racing band, panel lines, soot toward the nozzle. */
function engineTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 512; // v runs front (0) to back (1)
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b9bcc0';
  g.fillRect(0, 0, W, H);
  // Panel grid with slightly varied tones.
  for (let y = 0; y < H; y += 32) {
    for (let x = 0; x < W; x += 64) {
      const v = 175 + ((x * 7 + y * 13) % 23);
      g.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
      g.fillRect(x + 1, y + 1, 62, 30);
    }
  }
  g.strokeStyle = 'rgba(40,44,50,0.55)';
  g.lineWidth = 1.5;
  for (let y = 0; y < H; y += 32) g.strokeRect(0, y, W, 32);
  // Blue racing band and a thin gold pinstripe.
  g.fillStyle = '#1f4f9e';
  g.fillRect(0, H * 0.32, W, H * 0.12);
  g.fillStyle = '#e0b030';
  g.fillRect(0, H * 0.45, W, 5);
  // Soot toward the exhaust.
  const soot = g.createLinearGradient(0, H * 0.7, 0, H);
  soot.addColorStop(0, 'rgba(30,25,20,0)');
  soot.addColorStop(1, 'rgba(30,25,20,0.85)');
  g.fillStyle = soot;
  g.fillRect(0, H * 0.7, W, H * 0.3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function cockpitTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2257a8';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#e8b432';
  g.fillRect(0, 96, 256, 26);
  g.fillStyle = 'rgba(255,255,255,0.08)';
  for (let i = 0; i < 256; i += 32) g.fillRect(i, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Energy binder: additive arc with flickering filaments. Includes three's log-depth chunks (the engine
// uses a logarithmic depth buffer; custom shaders without them sort wrongly against other geometry).
const BINDER_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const BINDER_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uPower;
varying vec2 vUv;
float h(float n) { return fract(sin(n) * 43758.5453); }
float n1(float x) { float i = floor(x); float f = fract(x); return mix(h(i), h(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  #include <logdepthbuf_fragment>
  float x = vUv.x;
  float y = vUv.y * 2.0 - 1.0;
  float glow = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float off = (n1(x * 7.0 + uTime * (9.0 + fk * 3.0) + fk * 13.0) - 0.5) * 0.9 * sin(x * 3.14159);
    float d = abs(y - off);
    glow += 0.012 / (d * d + 0.004) * (0.6 + 0.4 * n1(uTime * 30.0 + fk * 7.0));
  }
  glow *= smoothstep(0.0, 0.08, x) * smoothstep(1.0, 0.92, x) * uPower;
  vec3 col = mix(vec3(0.35, 0.45, 1.0), vec3(0.85, 0.75, 1.0), clamp(glow * 0.15, 0.0, 1.0));
  gl_FragColor = vec4(col * glow * 0.35, 1.0);
}`;

function buildEngine(skin: THREE.Material, dark: THREE.Material, glowMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  // Lathe profile (radius, length): flared intake lip, fat turbine body, tapering to the nozzle.
  const prof: [number, number][] = [
    [0.5, 0],
    [0.68, 0.15],
    [0.8, 0.9],
    [0.82, 2.4],
    [0.76, 4.6],
    [0.62, 6.2],
    [0.5, ENGINE_LEN],
  ];
  const lathe = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 40);
  lathe.rotateX(Math.PI / 2); // lathe axis Y → +Z: intake lip at z = 0, nozzle at z = ENGINE_LEN
  const body = new THREE.Mesh(lathe, skin);
  body.castShadow = true;
  g.add(body);
  // Intake: dark throat and four radial stator vanes.
  const throat = new THREE.Mesh(new THREE.CircleGeometry(0.5, 32), dark);
  throat.position.z = -0.12;
  throat.rotation.y = Math.PI; // face forward, out of the intake
  g.add(throat);
  for (let i = 0; i < 4; i++) {
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.95, 0.5), skin);
    vane.rotation.z = (i * Math.PI) / 4;
    vane.position.z = -0.1;
    g.add(vane);
  }
  // Split air-brake plates either side of the intake (the classic open "mouth").
  for (const s of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.5, 1.4), skin);
    plate.position.set(s * 0.72, 0, 0.55);
    plate.rotation.y = s * 0.12;
    plate.castShadow = true;
    g.add(plate);
  }
  // Nozzle glow.
  const nozzle = new THREE.Mesh(new THREE.CircleGeometry(0.44, 24), glowMat);
  nozzle.position.z = ENGINE_LEN + 0.01;
  g.add(nozzle); // CircleGeometry faces +Z: already looking backward out of the nozzle
  return g;
}

export function createPodracer(): PodracerModel {
  const root = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ map: engineTexture(), metalness: 0.65, roughness: 0.38 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15161a, metalness: 0.4, roughness: 0.7 });
  const cable = new THREE.MeshStandardMaterial({ color: 0x2a2b30, metalness: 0.8, roughness: 0.35 });
  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.6, 0.6), toneMapped: true });

  // Engines: their own groups so gameplay can sway them; the origin of each is at its intake lip.
  const engineL = buildEngine(skin, dark, glowMat);
  const engineR = buildEngine(skin, dark, glowMat);
  engineL.position.set(-ENGINE_GAP, 0, -ENGINE_LEN / 2);
  engineR.position.set(ENGINE_GAP, 0, -ENGINE_LEN / 2);
  root.add(engineL, engineR);

  // Exhaust plumes: additive cones behind each nozzle, scaled by throttle.
  const plumeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.5, 0.28), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
  const plumeGeo = new THREE.ConeGeometry(0.42, 3.2, 20, 1, true);
  plumeGeo.translate(0, 1.6, 0); // base at the nozzle, apex 3.2 m behind
  plumeGeo.rotateX(Math.PI / 2); // point backward (+Z)
  const plumes = [engineL, engineR].map((e) => {
    const m = new THREE.Mesh(plumeGeo, plumeMat);
    m.position.z = ENGINE_LEN;
    e.add(m);
    return m;
  });

  // Cockpit tub with the pilot, side fins and a gold trim band.
  const cockpit = new THREE.Group();
  const tubGeo = new THREE.CapsuleGeometry(0.75, 1.5, 8, 24);
  tubGeo.rotateX(Math.PI / 2);
  tubGeo.scale(1, 0.62, 1);
  const tub = new THREE.Mesh(tubGeo, new THREE.MeshStandardMaterial({ map: cockpitTexture(), metalness: 0.45, roughness: 0.4 }));
  tub.castShadow = true;
  cockpit.add(tub);
  for (const s of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 1.1), skin);
    fin.position.set(s * 0.95, 0, 0.4);
    fin.rotation.z = s * -0.25;
    cockpit.add(fin);
  }
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.7 }));
  helmet.position.set(0, 0.42, 0.1);
  const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.12), new THREE.MeshStandardMaterial({ color: 0x0c0c10, metalness: 0.9, roughness: 0.15 }));
  goggles.position.set(0, 0.45, -0.1);
  cockpit.add(helmet, goggles);
  cockpit.position.set(0, -0.15, ENGINE_LEN / 2 + COCKPIT_Z);
  root.add(cockpit);

  const chaseAnchor = new THREE.Object3D();
  chaseAnchor.position.set(0, 3.4, 7.5);
  cockpit.add(chaseAnchor);
  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.position.set(0, 0.95, 0.05);
  cockpit.add(eyeAnchor);

  // Energy binder between the engines (two crossed quads so it reads from any angle).
  const binderMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 1 } },
    vertexShader: BINDER_VERT,
    fragmentShader: BINDER_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const binder = new THREE.Group();
  for (const rot of [0, Math.PI / 2]) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.9), binderMat);
    q.geometry.translate(0.5, 0, 0); // spans x 0..1, scaled to the gap each frame
    q.rotation.x = rot;
    binder.add(q);
  }
  root.add(binder);

  // Control cables: unit cylinders stretched between attachment points each frame.
  const cableGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
  cableGeo.translate(0, 0.5, 0);
  cableGeo.rotateX(Math.PI / 2); // unit length along +Z
  const cables = [0, 1].map(() => {
    const m = new THREE.Mesh(cableGeo, cable);
    m.castShadow = true;
    root.add(m);
    return m;
  });

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let time = 0;
  return {
    root,
    engineL,
    engineR,
    cockpit,
    chaseAnchor,
    eyeAnchor,
    update(dt, throttle) {
      time += dt;
      // Gameplay may have moved the parts since the last render: refresh their local matrices first.
      engineL.updateMatrix();
      engineR.updateMatrix();
      cockpit.updateMatrix();
      root.updateMatrixWorld();
      binderMat.uniforms.uTime.value = time;
      binderMat.uniforms.uPower.value = 0.6 + throttle * 0.6;
      // Binder: from the inner side of the left engine to the right one, just behind the intakes.
      a.set(0.7, 0.35, 1.3).applyMatrix4(engineL.matrix);
      b.set(-0.7, 0.35, 1.3).applyMatrix4(engineR.matrix);
      binder.position.copy(a);
      binder.scale.set(a.distanceTo(b), 1, 1);
      binder.quaternion.setFromUnitVectors(_X, b.sub(a).normalize());
      // Cables: engine tail → cockpit nose.
      for (let i = 0; i < 2; i++) {
        const e = i ? engineR : engineL;
        a.set(0, 0.2, ENGINE_LEN - 0.4).applyMatrix4(e.matrix);
        b.set(i ? 0.35 : -0.35, 0.1, -1.4).applyMatrix4(cockpit.matrix);
        cables[i].position.copy(a);
        cables[i].scale.set(1, 1, a.distanceTo(b));
        cables[i].lookAt(b.applyMatrix4(root.matrixWorld));
      }
      for (const p of plumes) {
        const k = 0.35 + throttle * 0.9 + Math.sin(time * 60 + p.id) * 0.05;
        p.scale.set(1, 1, k);
      }
      glowMat.color.setRGB(1.2 + throttle * 1.8, 0.6 + throttle * 0.7, 0.3 + throttle * 0.25);
    },
  };
}
