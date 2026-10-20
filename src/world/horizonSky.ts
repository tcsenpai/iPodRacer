// Sky layers of the horizon: moons and ringed gas giants painted just inside the sky dome, and drifting
// cloud bands. Both meshes ride on whichever camera is rendering (split screen safe) and never write depth,
// so the far ranges, landmarks and the course all draw over them.
import * as THREE from 'three';
import type { HorizonTheme, RGB } from './theme';
import type { HazeUniforms } from './horizonShaders';
import { NOISE_GLSL } from './horizonShaders';

const BODY_RADIUS = 300000; // m: inside the sky dome (400 km), far beyond everything else
const CLOUD_RADIUS = 250000;
const RING_EXTENT = 2.4; // quad half size in body radii for ringed giants (fits the ring)

/** sRGB 0..1 theme colour to a linear THREE.Color. */
export function themeColor(c: RGB, out = new THREE.Color()): THREE.Color {
  return out.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
}

/** Keeps a camera-centred shell on the camera being rendered (runs before three builds modelViewMatrix). */
function followCamera(mesh: THREE.Mesh): void {
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.onBeforeRender = (_r, _s, camera) => {
    mesh.position.setFromMatrixPosition(camera.matrixWorld);
    mesh.updateMatrix();
    mesh.matrixWorld.copy(mesh.matrix);
  };
}

const BODY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 aQuad;
attribute vec3 aColor;
attribute vec3 aLight;
attribute vec2 aKind;
varying vec2 vQuad;
varying vec3 vColor;
varying vec3 vLight;
varying vec2 vKind;
varying float vElev;
void main() {
  vQuad = aQuad;
  vColor = aColor;
  vLight = aLight;
  vKind = aKind;
  vElev = normalize(position).y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const BODY_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
varying vec2 vQuad;
varying vec3 vColor;
varying vec3 vLight;
varying vec2 vKind; // x: ringed giant, y: per-body seed
varying float vElev;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vQuad;
  float r2 = dot(p, p);
  float disc = 1.0 - smoothstep(0.93, 1.0, r2);
  vec3 n = vec3(p, sqrt(max(1.0 - r2, 0.0)));
  float lam = max(dot(n, vLight), 0.0);
  float shade = smoothstep(0.0, 0.2, lam);
  bool giant = vKind.x > 0.5;
  // Ring plane tilt: the same frame drives the giant's cloud belts so they run parallel to the ring.
  vec2 q = mat2(0.93, -0.36, 0.36, 0.93) * p;
  vec3 base;
  if (giant) {
    float lat = q.y + 0.05 * sin(q.x * 6.0 + vKind.y) + 0.04 * (hzNoise(q * 6.0 + vKind.y) - 0.5);
    base = vColor * (0.78 + 0.18 * sin(lat * 19.0) + 0.12 * sin(lat * 47.0 + 1.3));
  } else {
    base = vColor * (0.7 + 0.45 * hzFbm(p * 3.2 + vKind.y));
  }
  // Daylight: the night side vanishes into the blue, a giant's stays faintly visible.
  vec3 col = base * (0.18 + 0.95 * lam);
  float a = disc * mix(giant ? 0.4 : 0.12, 0.92, shade);
  if (giant) {
    float e = length(vec2(q.x, q.y / 0.24));
    float rb = smoothstep(1.3, 1.36, e) * (1.0 - smoothstep(2.2, 2.3, e));
    rb *= 0.5 + 0.5 * hzNoise(vec2(e * 26.0, vKind.y));
    rb *= 1.0 - 0.75 * smoothstep(1.72, 1.76, e) * (1.0 - smoothstep(1.84, 1.88, e));
    vec3 rc = vColor * vec3(1.05, 0.97, 0.88) * (0.45 + 0.6 * max(vLight.z * 0.5 + 0.5, 0.0));
    float ra = rb * 0.8;
    vec3 pc;
    float pa;
    if (q.y < 0.0) {
      // Near half of the ring crosses in front of the globe.
      pc = rc * ra + col * a * (1.0 - ra);
      pa = ra + a * (1.0 - ra);
    } else {
      pc = col * a + rc * ra * (1.0 - a);
      pa = a + ra * (1.0 - a);
    }
    col = pc / max(pa, 1e-4);
    a = pa;
  }
  // Extinction low in the sky: bodies sink into the haze rather than clip at the horizon.
  a *= smoothstep(-0.01, 0.07, vElev);
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
}`;

const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _c = new THREE.Color();

/** All sky bodies of the theme as camera-facing quads in one draw call (null when there are none). */
export function buildBodies(h: HorizonTheme, sunDir: readonly [number, number, number]): THREE.Mesh | null {
  if (h.bodies.length === 0) return null;
  const n = h.bodies.length * 4;
  const pos = new Float32Array(n * 3);
  const quad = new Float32Array(n * 2);
  const color = new Float32Array(n * 3);
  const light = new Float32Array(n * 3);
  const kind = new Float32Array(n * 2);
  const index: number[] = [];
  const sun = new THREE.Vector3(sunDir[0], sunDir[1], sunDir[2]).normalize();
  h.bodies.forEach((b, i) => {
    _d.set(b.dir[0], b.dir[1], b.dir[2]).normalize();
    _r.crossVectors(_d, THREE.Object3D.DEFAULT_UP);
    if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
    _r.normalize();
    _u.crossVectors(_r, _d);
    const k = b.ring ? RING_EXTENT : 1.05;
    const half = BODY_RADIUS * Math.tan(b.radius);
    // The lit limb faces the sun across the sky, with the phase from the theme (lit 1 = full disc).
    let sx = sun.dot(_r);
    let sy = sun.dot(_u);
    const sl = Math.hypot(sx, sy);
    if (sl < 1e-4) {
      sx = 1;
      sy = 0;
    } else {
      sx /= sl;
      sy /= sl;
    }
    const cosT = THREE.MathUtils.clamp(2 * b.lit - 1, -1, 1);
    const sinT = Math.sqrt(1 - cosT * cosT);
    themeColor(b.color, _c);
    for (let v = 0; v < 4; v++) {
      const qx = (v & 1 ? 1 : -1) * k;
      const qy = (v & 2 ? 1 : -1) * k;
      const o = i * 4 + v;
      pos[o * 3] = _d.x * BODY_RADIUS + (_r.x * qx + _u.x * qy) * half;
      pos[o * 3 + 1] = _d.y * BODY_RADIUS + (_r.y * qx + _u.y * qy) * half;
      pos[o * 3 + 2] = _d.z * BODY_RADIUS + (_r.z * qx + _u.z * qy) * half;
      quad[o * 2] = qx;
      quad[o * 2 + 1] = qy;
      color.set([_c.r, _c.g, _c.b], o * 3);
      light.set([sx * sinT, sy * sinT, cosT], o * 3);
      kind.set([b.ring ? 1 : 0, i * 7.31 + 3.1], o * 2);
    }
    const o = i * 4;
    index.push(o, o + 1, o + 2, o + 2, o + 1, o + 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aQuad', new THREE.BufferAttribute(quad, 2));
  geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('aLight', new THREE.BufferAttribute(light, 3));
  geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 2));
  geo.setIndex(index);
  const mat = new THREE.ShaderMaterial({
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Right after the sky dome (-1000), before the clouds.
  mesh.renderOrder = -999;
  followCamera(mesh);
  return mesh;
}

const CLOUD_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const CLOUD_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
uniform vec3 uHzFog;
uniform vec3 uHzSun;
uniform float uTime;
uniform vec3 uCloud;
uniform float uCover;
uniform vec2 uWind;
varying vec3 vDir;
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  if (d.y < 0.0) discard;
  // Project onto a cloud deck: perspective packs the bands into thin streaks toward the horizon.
  vec2 p = d.xz / (d.y + 0.08);
  vec2 q = vec2(dot(p, uWind), dot(p, vec2(-uWind.y, uWind.x)));
  q.x += uTime * 0.006;
  // Long along the wind, narrow across it: bands rather than puffs.
  float n = hzFbm(q * vec2(0.45, 1.9)) * 0.8 + hzFbm(q * vec2(2.2, 6.0) + vec2(uTime * 0.012, 0.0)) * 0.2;
  float thr = mix(0.8, 0.36, uCover);
  float a = smoothstep(thr, thr + 0.22, n);
  float thick = smoothstep(thr, thr + 0.45, n);
  float s = max(dot(d, uHzSun), 0.0);
  // Thin edges glow toward the suns, thick cores go grey underneath.
  vec3 col = uCloud * mix(1.04, 0.72, thick) + uCloud * (pow(s, 6.0) * 0.45 + pow(s, 40.0) * 0.5) * (1.0 - 0.6 * thick);
  col = mix(uHzFog, col, 0.35 + 0.65 * smoothstep(0.0, 0.28, d.y));
  a *= smoothstep(0.0, 0.06, d.y) * 0.85;
  if (a < 0.003) discard;
  gl_FragColor = vec4(min(col, vec3(1.3)), a);
}`;

/** Drifting cloud bands (null when the theme is cloudless). */
export function buildClouds(h: HorizonTheme, haze: HazeUniforms): THREE.Mesh | null {
  if (h.clouds <= 0.01) return null;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uHzFog: haze.uHzFog,
      uHzSun: haze.uHzSun,
      uTime: haze.uTime,
      uCloud: { value: themeColor(h.cloudColor) },
      uCover: { value: THREE.MathUtils.clamp(h.clouds, 0, 1) },
      // A fixed prevailing wind across the sun direction keeps the bands from streaming at the camera.
      uWind: { value: new THREE.Vector2(0.8, 0.6) },
    },
    vertexShader: CLOUD_VERT,
    fragmentShader: CLOUD_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(CLOUD_RADIUS, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  mesh.renderOrder = -998;
  followCamera(mesh);
  return mesh;
}
