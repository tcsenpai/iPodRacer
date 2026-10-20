// Tatooine sky: an analytic desert sky (deep zenith blue fading to a pale, dusty horizon), the twin suns
// Tatoo I and Tatoo II with HDR discs and forward-scattering glow, and image-based lighting rendered from
// the same sky (PMREM) so every material is lit by the scene's own sky.
// Values stay around 0..1.5 except the sun discs: the engine's bloom threshold (0.9) is tuned for that.
import * as THREE from 'three';

/** Direction toward the primary sun (Tatoo I). The engine's lens flare tracks this one. */
export const SUN_DIRECTION = new THREE.Vector3(0.45, 0.32, -0.83).normalize();
/** Tatoo II: smaller and oranger, a few degrees off the first. */
export const SUN2_DIRECTION = new THREE.Vector3(0.36, 0.27, -0.89).normalize();

export interface DesertSky {
  sunLight: THREE.DirectionalLight;
  /** Per frame: keep the sky dome on the camera, follow `focus` with the shadow frustum. */
  update(camera: THREE.Camera, focus: THREE.Vector3): void;
}

const SKY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const SKY_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uSun1;
uniform vec3 uSun2;
uniform float uDiscs; // 0 for the IBL capture (no HDR spikes in the environment map)
varying vec3 vDir;
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 zenith = vec3(0.16, 0.34, 0.66);
  vec3 horizon = vec3(0.86, 0.80, 0.70);
  vec3 ground = vec3(0.62, 0.50, 0.38);
  float up = pow(clamp(h, 0.0, 1.0), 0.45);
  vec3 col = mix(horizon, zenith, up);
  col = mix(col, ground, smoothstep(0.0, -0.08, h));
  // Dust glow around the suns (forward scattering), warmer for the second sun.
  float c1 = max(dot(d, uSun1), 0.0);
  float c2 = max(dot(d, uSun2), 0.0);
  col += vec3(1.0, 0.85, 0.6) * (pow(c1, 8.0) * 0.35 + pow(c1, 120.0) * 0.6);
  col += vec3(1.0, 0.6, 0.35) * (pow(c2, 10.0) * 0.18 + pow(c2, 160.0) * 0.4);
  // Sun discs: HDR so bloom and the lens flare pick them up.
  col += vec3(9.0, 8.0, 6.5) * smoothstep(0.99955, 0.99975, c1) * uDiscs;
  col += vec3(7.0, 4.2, 2.4) * smoothstep(0.99975, 0.99987, c2) * uDiscs;
  gl_FragColor = vec4(col, 1.0);
}`;

function skyDome(discs: number): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSun1: { value: SUN_DIRECTION }, uSun2: { value: SUN2_DIRECTION }, uDiscs: { value: discs } },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(400000, 48, 24), mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

export function buildDesertSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer, shadowExtent = 220): DesertSky {
  const sky = skyDome(1);
  scene.add(sky);

  // IBL from the sky alone (discs off: the direct lights below carry the sun).
  const skyOnly = new THREE.Scene();
  const capture = skyDome(0);
  skyOnly.add(capture);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(skyOnly, 0, 1, 1e6).texture;
  pmrem.dispose();
  capture.geometry.dispose();
  (capture.material as THREE.Material).dispose();
  scene.environmentIntensity = 0.7;

  // Hard desert key light from Tatoo I, warm fill from Tatoo II, and sand bounce from below.
  const sunLight = new THREE.DirectionalLight(0xfff0d8, 2.6);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const sc = sunLight.shadow.camera;
  sc.left = sc.bottom = -shadowExtent;
  sc.right = sc.top = shadowExtent;
  sc.near = 10;
  sc.far = 4000;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.8;
  sunLight.shadow.radius = 2;
  const sun2Light = new THREE.DirectionalLight(0xffb070, 0.7);
  sun2Light.position.copy(SUN2_DIRECTION).multiplyScalar(1000);
  scene.add(sunLight, sunLight.target, sun2Light, new THREE.HemisphereLight(0xbfd4ff, 0xc89060, 0.35));
  // Distant haze: the far mesas fade into the horizon colour.
  scene.fog = new THREE.FogExp2(0xdbcdb2, 0.00009);

  return {
    sunLight,
    update(camera, focus) {
      sky.position.copy(camera.position);
      // Texel-snapped shadow frustum around the focus to avoid shimmering.
      const step = (shadowExtent * 2) / 2048;
      const fx = Math.round(focus.x / step) * step;
      const fy = Math.round(focus.y / step) * step;
      const fz = Math.round(focus.z / step) * step;
      sunLight.target.position.set(fx, fy, fz);
      sunLight.position.set(fx, fy, fz).addScaledVector(SUN_DIRECTION, 1800);
    },
  };
}
