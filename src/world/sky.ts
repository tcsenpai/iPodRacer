// Planet sky: an analytic gradient (zenith fading to a hazy horizon), the sun with an HDR disc and
// forward-scattering glow (Tatooine adds Tatoo II), and image-based lighting rendered from the same sky
// (PMREM) so every material is lit by the scene's own sky. Colours, lights and fog come from the Theme.
// Values stay around 0..1.5 except the sun discs: the engine's bloom threshold (0.9) is tuned for that.
import * as THREE from 'three';
import type { Theme } from './theme';

/**
 * Direction toward the primary sun. The engine's lens flare and the surface glints hold this exact
 * object: buildSky updates it in place (copy), never reassign it.
 */
export const SUN_DIRECTION = new THREE.Vector3(0.45, 0.32, -0.83).normalize();
/** Second sun (Tatoo II on Tatooine); unused where the theme has a single sun. */
export const SUN2_DIRECTION = new THREE.Vector3(0.36, 0.27, -0.89).normalize();

export interface Sky {
  sunLight: THREE.DirectionalLight;
  /** Per view: keep the sky dome on the camera, follow `focus` with the shadow frustum. */
  view(camera: THREE.Camera, focus: THREE.Vector3): void;
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
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uGlow1;
uniform vec3 uGlow2;
uniform vec3 uDisc1;
uniform vec3 uDisc2;
uniform float uDiscs; // 0 for the IBL capture (no HDR spikes in the environment map)
varying vec3 vDir;
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  float h = d.y;
  float up = pow(clamp(h, 0.0, 1.0), 0.45);
  vec3 col = mix(uHorizon, uZenith, up);
  col = mix(col, uGround, smoothstep(0.0, -0.08, h));
  // Haze glow around the suns (forward scattering); a black glow switches the second sun off.
  float c1 = max(dot(d, uSun1), 0.0);
  float c2 = max(dot(d, uSun2), 0.0);
  col += uGlow1 * (pow(c1, 8.0) * 0.35 + pow(c1, 120.0) * 0.6);
  col += uGlow2 * (pow(c2, 10.0) * 0.18 + pow(c2, 160.0) * 0.4);
  // Sun discs: HDR so bloom and the lens flare pick them up.
  col += uDisc1 * smoothstep(0.99955, 0.99975, c1) * uDiscs;
  col += uDisc2 * smoothstep(0.99975, 0.99987, c2) * uDiscs;
  gl_FragColor = vec4(col, 1.0);
}`;

function skyDome(theme: Theme, discs: number): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  const s = theme.sky;
  const rgb = (c: readonly [number, number, number]) => ({ value: new THREE.Color().setRGB(c[0], c[1], c[2]) });
  const black = [0, 0, 0] as const;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSun1: { value: SUN_DIRECTION },
      uSun2: { value: SUN2_DIRECTION },
      uZenith: rgb(s.zenith),
      uHorizon: rgb(s.horizon),
      uGround: rgb(s.ground),
      uGlow1: rgb(s.glow),
      uDisc1: rgb(s.disc),
      uGlow2: rgb(s.sun2?.glow ?? black),
      uDisc2: rgb(s.sun2?.disc ?? black),
      uDiscs: { value: discs },
    },
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

export function buildSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer, theme: Theme, shadowExtent = 220): Sky {
  // In place: the flare pass and the surface shader keep references to these vectors.
  SUN_DIRECTION.set(...theme.sunDir).normalize();
  const sun2 = theme.sky.sun2;
  if (sun2) SUN2_DIRECTION.set(...sun2.dir).normalize();
  const sky = skyDome(theme, 1);
  scene.add(sky);

  // IBL from the sky alone (discs off: the direct lights below carry the sun).
  const skyOnly = new THREE.Scene();
  const capture = skyDome(theme, 0);
  skyOnly.add(capture);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(skyOnly, 0, 1, 1e6).texture;
  pmrem.dispose();
  capture.geometry.dispose();
  capture.material.dispose();
  const L = theme.light;
  scene.environmentIntensity = L.env;

  // Hard key light from the sun, an optional fill from the second sun, and ground bounce from below.
  const sunLight = new THREE.DirectionalLight(L.sun, L.sunIntensity);
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
  scene.add(sunLight, sunLight.target, new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemiIntensity));
  if (sun2) {
    const sun2Light = new THREE.DirectionalLight(L.sun2, L.sun2Intensity);
    sun2Light.position.copy(SUN2_DIRECTION).multiplyScalar(1000);
    scene.add(sun2Light);
  }
  // Distant haze: far relief fades into the horizon colour.
  scene.fog = new THREE.FogExp2(theme.fogColor, L.fogDensity);

  const step = (shadowExtent * 2) / 2048;
  return {
    sunLight,
    view(camera, focus) {
      sky.position.copy(camera.position);
      // Texel-snapped shadow frustum around the focus to avoid shimmering.
      const fx = Math.round(focus.x / step) * step;
      const fy = Math.round(focus.y / step) * step;
      const fz = Math.round(focus.z / step) * step;
      sunLight.target.position.set(fx, fy, fz);
      sunLight.position.set(fx, fy, fz).addScaledVector(SUN_DIRECTION, 1800);
    },
  };
}
