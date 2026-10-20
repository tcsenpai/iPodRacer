// One race venue built from a TrackDef: sky and lights, carved terrain, liquids (frozen lakes, methane,
// sea, the volcano's lava lake), track-side props, the start area and its life, and the far horizon.
// The scene is rebuilt per course; the surface materials are cached across worlds (userData.shared).
import * as THREE from 'three';
import { buildHorizon } from './horizon';
import { buildLife } from './life';
import { buildProps, type Collider } from './props';
import { buildSky } from './sky';
import { SURFACE_NOISE_GLSL, inject } from './surface';
import { buildTerrain, groundHeight, terrainHeight } from './terrain';
import type { RGB, TrackDef } from './theme';
import { Track } from './track';

export interface World {
  def: TrackDef;
  scene: THREE.Scene;
  track: Track;
  colliders: Collider[];
  /** Per frame (dt 0 while paused): animation, life, horizon; also runs view() for this camera. */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3, pods: readonly { pos: THREE.Vector3; speed: number }[]): void;
  /** Per rendered view (split screen): sky dome to the camera, shadow frustum to `focus`. No allocations. */
  view(camera: THREE.Camera, focus: THREE.Vector3): void;
}

type LiquidKind = 'ice' | 'methane' | 'sea' | 'lava';

// Liquid surfaces: a MeshStandardMaterial patched like ./surface (three's lighting, fog, shadows and
// log depth stay intact). World-space noise gives ice crust and cracks, methane swirls that glow, sea
// swell, and slowly churning lava; every octave fades with the pixel footprint so far water stays calm.
const LIQUID_PARS = /* glsl */ `
uniform float uLqTime;
uniform vec3 uLqColor;
uniform vec3 uLqDeep;
varying vec3 vLqPos;
${SURFACE_NOISE_GLSL}
float lqFade(float fp, float wavelength) {
  return 1.0 - smoothstep(0.15, 0.5, fp / wavelength);
}
`;

const LIQUID_SAMPLE = /* glsl */ `
float lqFp = max(length(dFdx(vLqPos)), length(dFdy(vLqPos)));
vec3 lqGrad = vec3(0.0);
vec3 lqGlow = vec3(0.0);
float lqRough = 0.1;
{
  vec2 q = vLqPos.xz;
  float big = sfNoise(vec3(q * 0.004, 0.0)) * 0.6 + sfNoise(vec3(q * 0.02, 3.0)) * 0.4;
#if defined(LIQUID_ICE)
  // Frozen lake: clear dark ice with milky patches and white pressure cracks.
  vec4 c = sfNoised(vec3(q * 0.09, 1.7));
  float crack = smoothstep(0.035, 0.0, abs(c.x - 0.5)) * lqFade(lqFp, 0.6);
  float milky = smoothstep(0.35, 0.75, big);
  diffuseColor.rgb = mix(uLqDeep, uLqColor, milky) + crack * 0.35;
  // The noise input is (x, z, const): .y and .z of the gradient are the world x and z slopes.
  lqGrad = vec3(c.y, 0.0, c.z) * 0.09 * 0.02 * lqFade(lqFp, 2.0);
  lqRough = mix(0.12, 0.45, milky) + crack * 0.3;
#elif defined(LIQUID_METHANE)
  // Liquid methane: dark and glassy, lit from within by slow green swirls.
  float t = uLqTime * 0.15;
  float swirl = sfNoise(vec3(q * 0.012, t)) * 0.6 + sfNoise(vec3(q * 0.05, t * 1.7 + 5.0)) * 0.4;
  diffuseColor.rgb = uLqDeep;
  lqGlow = uLqColor * (0.35 + 0.75 * smoothstep(0.35, 0.8, swirl));
  vec4 w = sfNoised(vec3(q * 0.08, uLqTime * 0.4));
  lqGrad = vec3(w.y, 0.0, w.z) * 0.08 * 0.03 * lqFade(lqFp, 3.0);
  lqRough = 0.08;
#elif defined(LIQUID_SEA)
  // Sea: swell from two noise octaves drifting at different speeds, darker in the deep.
  vec4 w1 = sfNoised(vec3(q * 0.02, uLqTime * 0.12));
  vec4 w2 = sfNoised(vec3(q * 0.11 + 7.0, uLqTime * 0.5));
  lqGrad = vec3(w1.y, 0.0, w1.z) * 0.02 * 0.6 * lqFade(lqFp, 12.0) + vec3(w2.y, 0.0, w2.z) * 0.11 * 0.08 * lqFade(lqFp, 2.5);
  diffuseColor.rgb = mix(uLqColor, uLqDeep, big);
  lqRough = 0.05;
#else
  // Lava: a black crust broken by glowing veins, churning slowly.
  float t = uLqTime * 0.08;
  float m = sfNoise(vec3(q * 0.05, t)) * 0.65 + sfNoise(vec3(q * 0.2, t * 2.0 + 9.0)) * 0.35;
  float vein = smoothstep(0.12, 0.0, abs(m - 0.5));
  diffuseColor.rgb = uLqDeep;
  lqGlow = uLqColor * (0.25 + 2.2 * vein);
  lqRough = 0.85;
#endif
}
`;

const LIQUID_NORMAL = /* glsl */ `
{
  vec3 g = (viewMatrix * vec4(lqGrad, 0.0)).xyz;
  normal = normalize(normal - (g - normal * dot(normal, g)));
}
`;

function liquidMaterial(kind: LiquidKind, color: RGB, deep: RGB, time: { value: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.defines = { [`LIQUID_${kind.toUpperCase()}`]: '' };
  const uniforms = { uLqTime: time, uLqColor: { value: new THREE.Color().setRGB(...color) }, uLqDeep: { value: new THREE.Color().setRGB(...deep) } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader;
    vs = inject(vs, 'common', 'varying vec3 vLqPos;');
    vs = inject(vs, 'worldpos_vertex', 'vLqPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = inject(fs, 'common', LIQUID_PARS);
    fs = inject(fs, 'color_fragment', LIQUID_SAMPLE);
    fs = inject(fs, 'roughnessmap_fragment', 'roughnessFactor = lqRough;');
    fs = inject(fs, 'normal_fragment_maps', LIQUID_NORMAL);
    fs = inject(fs, 'emissivemap_fragment', 'totalEmissiveRadiance += lqGlow;');
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `liquid-${kind}`;
  return mat;
}

/** A flat horizontal liquid surface from an XY-plane geometry, at (x, y, z). */
function sheet(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geo.rotateX(-Math.PI / 2), mat);
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export function buildWorld(def: TrackDef, renderer: THREE.WebGLRenderer): World {
  const theme = def.theme;
  const scene = new THREE.Scene();
  const sky = buildSky(scene, renderer, theme);
  const track = new Track(def);
  const props = buildProps(track);
  const life = buildLife(track);
  const horizon = buildHorizon(theme, track.center, (x: number, z: number) => groundHeight(track, x, z));
  scene.add(buildTerrain(track), props.group, life.group, horizon.group);

  const time = { value: 0 };
  const liquid = theme.liquid;
  if (liquid) {
    // The sea runs out to the horizon; lakes only need to cover the terrain backdrop (14 km).
    const size = liquid.kind === 'sea' ? 80000 : 14000;
    const mat = liquidMaterial(liquid.kind, liquid.color, liquid.deep, time);
    scene.add(sheet(new THREE.PlaneGeometry(size, size), mat, track.center.x, liquid.level, track.center.z));
  }
  const v = theme.terrain.volcano;
  if (v) {
    // Lava lake in the crater bowl (radius a tenth of the cone's base, 12% of the height deep): filled
    // a bit over half way, so the disc's edge always stays under the bowl's walls.
    const level = terrainHeight(track, v.x, v.z) + v.height * 0.07;
    const mat = liquidMaterial('lava', [1, 0.32, 0.06], [0.03, 0.02, 0.02], time);
    scene.add(sheet(new THREE.CircleGeometry(v.r * 0.09, 32), mat, v.x, level, v.z));
  }

  return {
    def,
    scene,
    track,
    colliders: [...props.colliders, ...life.colliders],
    update(dt, camera, focus, pods) {
      time.value += dt;
      life.update(dt, camera, pods);
      horizon.update(dt, camera);
      sky.view(camera, focus);
    },
    view: sky.view,
  };
}
