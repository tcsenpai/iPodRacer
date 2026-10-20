// Materials for the far horizon (see horizon.ts). Everything out there is kilometres away, so three's
// scene fog (tuned for the course) would swallow it whole: these materials apply their own gentler aerial
// perspective, thinning with altitude so peaks and flyers stay readable while their feet melt into the haze.
import * as THREE from 'three';

/** Shared haze uniforms (one set per horizon, referenced by every material below). */
export interface HazeUniforms {
  uHzFog: { value: THREE.Color };
  uHzSun: { value: THREE.Vector3 };
  uHzDensity: { value: number };
  uTime: { value: number };
}

/**
 * Haze GLSL usable in both stages (cameraPosition is declared in each). `hzFactor` is the in-scatter
 * fraction toward the camera, `hzColor` the haze tint, brighter toward the sun (forward scattering).
 */
const HAZE_PARS = /* glsl */ `
uniform vec3 uHzFog;
uniform vec3 uHzSun;
uniform float uHzDensity;
uniform float uTime;
float hzFactor(vec3 wp) {
  float dist = length(wp - cameraPosition);
  // Haze hugs the ground: the mean altitude along the ray thins it for high peaks and flyers.
  float alt = max(0.5 * (wp.y + cameraPosition.y), 0.0);
  return min(1.0 - exp(-dist * uHzDensity * exp(-alt / 2600.0)), 0.9);
}
vec3 hzColor(vec3 wp) {
  vec3 dir = normalize(wp - cameraPosition);
  return uHzFog * (1.0 + 0.3 * pow(max(dot(dir, uHzSun), 0.0), 5.0));
}
`;

/** Value noise for the procedural sky and dust shaders (no textures allowed). */
export const NOISE_GLSL = /* glsl */ `
float hzHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hzNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hzHash(i), hzHash(i + vec2(1.0, 0.0)), u.x), mix(hzHash(i + vec2(0.0, 1.0)), hzHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float hzFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * hzNoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s / 0.96875;
}
`;

export function hazeUniforms(fogColor: number, sunDir: readonly [number, number, number]): HazeUniforms {
  return {
    uHzFog: { value: new THREE.Color(fogColor) },
    uHzSun: { value: new THREE.Vector3(sunDir[0], sunDir[1], sunDir[2]).normalize() },
    // About 45 % haze at 8 km and 75 % at 18 km near the ground: the layered ranges separate by tone.
    uHzDensity: { value: 7.5e-5 },
    uTime: { value: 0 },
  };
}

/**
 * Lit, vertex-coloured standard material for mountains, landmarks, flyers and crawlers: three's lighting
 * and log depth stay intact, only the fog chunk is swapped for the horizon haze.
 */
export function farMaterial(haze: HazeUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, fog: false });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, haze);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vHzWorld;').replace(
      '#include <project_vertex>',
      `#include <project_vertex>
  vec4 hzW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  hzW = instanceMatrix * hzW;
  #endif
  vHzWorld = (modelMatrix * hzW).xyz;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vHzWorld;\n${HAZE_PARS}`)
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = mix(gl_FragColor.rgb, hzColor(vHzWorld), hzFactor(vHzWorld));');
  };
  mat.customProgramCacheKey = () => 'horizon-far';
  return mat;
}

const GLOW_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${HAZE_PARS}
uniform float uPx;
attribute vec3 aColor;
attribute float aSize;
attribute float aFlicker;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Fire flickers on two incommensurate beats seeded by position; engines (aFlicker 0) stay steady.
  float fl = 1.0 - aFlicker * (0.3 + 0.3 * sin(uTime * 17.0 + position.x * 0.37 + position.y * 1.3) * sin(uTime * 7.3 + position.z * 0.21));
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vColor = aColor * fl * (1.0 - 0.75 * hzFactor(wp));
  // World-size sprites, but never below 2 px so a distant engine still reads as a spark.
  gl_PointSize = clamp(aSize * projectionMatrix[1][1] * uPx / -mv.z, 2.0, 64.0);
  #include <logdepthbuf_vertex>
}`;

const GLOW_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor, exp(-r2 * 4.0) * (1.0 - r2));
}`;

const _vp = new THREE.Vector4();

/** Additive HDR sprites (engine glows, gas flares, lava): sized in metres, scaled to the current viewport. */
export function glowMaterial(haze: HazeUniforms): THREE.ShaderMaterial {
  const uPx = { value: 360 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...haze, uPx },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  // Split screen renders each view into its own viewport: size the sprites for the one being drawn.
  mat.onBeforeRender = (renderer) => {
    renderer.getCurrentViewport(_vp);
    uPx.value = _vp.w * 0.5;
  };
  return mat;
}

const COLUMN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uTime;
uniform float uSway;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec3 vTint;
void main() {
  vUv = uv;
  float h = uv.y;
  float seed = instanceMatrix[3].x * 0.0123 + instanceMatrix[3].z * 0.0071;
  // Narrow foot flaring into a wide crown; the column snakes as the gusts push its upper part around.
  vec3 p = position;
  float w = mix(0.22, 1.0, pow(h, 0.8));
  vec2 sway = vec2(sin(uTime * 0.31 + seed + h * 2.2), cos(uTime * 0.23 + seed * 1.7 + h * 1.6)) * uSway * h * h;
  p.xz = p.xz * w + sway;
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * vec3(position.x, 0.0, position.z));
  #ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
  #else
  vTint = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const COLUMN_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${HAZE_PARS}
${NOISE_GLSL}
uniform float uSpin;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec3 vTint;
void main() {
  #include <logdepthbuf_fragment>
  float h = vUv.y;
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(cameraPosition - vWorld);
  // Thin at the silhouette, dense through the middle: reads as a volume from a double-sided shell.
  float facing = pow(abs(dot(n, v)), 0.6);
  // Streaks wound around the axis (cos/sin keeps the uv seam invisible), twisting faster up high.
  float a = vUv.x * 6.2831853 - uTime * uSpin - h * 3.0;
  vec2 ring = vec2(cos(a), sin(a)) * 1.6;
  float streak = hzFbm(ring + vec2(h * 9.0 - uTime * 0.5, h * 2.0));
  float alpha = smoothstep(0.3, 0.75, streak) * facing * smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.55, 1.0, h));
  vec3 col = vTint * (0.72 + 0.45 * max(dot(n, uHzSun), 0.0));
  float f = hzFactor(vWorld);
  col = mix(col, hzColor(vWorld), f);
  gl_FragColor = vec4(col, alpha * uOpacity * (1.0 - 0.5 * f));
}`;

/** Twisting translucent columns (dust devils, volcanic smoke) for an InstancedMesh with instance colours. */
export function columnMaterial(haze: HazeUniforms, spin: number, sway: number, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...haze, uSpin: { value: spin }, uSway: { value: sway }, uOpacity: { value: opacity } },
    vertexShader: COLUMN_VERT,
    fragmentShader: COLUMN_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}
