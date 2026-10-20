// Pooled particle effects: sparks off scrapes, fireballs and smoke for crashes, steam for overheats.
// One additive pool (fire, sparks: they glow through bloom) and one alpha pool (smoke).
import * as THREE from 'three';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
uniform float uScale;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;
const FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec4 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(d));
  if (vColor.a * a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb * a, vColor.a * a);
}`;

interface Kind {
  /** Start and end colour (linear, may exceed 1 to bloom) and alpha. */
  c0: THREE.Color;
  c1: THREE.Color;
  a0: number;
  size0: number;
  size1: number;
  life: number;
  drag: number;
  gravity: number;
}

const KINDS = {
  spark: { c0: new THREE.Color(6, 3.5, 1.2), c1: new THREE.Color(1.5, 0.3, 0.05), a0: 1, size0: 0.16, size1: 0.05, life: 0.5, drag: 1.5, gravity: 14 },
  fire: { c0: new THREE.Color(5, 2.6, 0.9), c1: new THREE.Color(0.8, 0.15, 0.02), a0: 1, size0: 7, size1: 16, life: 1.0, drag: 2.5, gravity: -3 },
  flash: { c0: new THREE.Color(5, 3.8, 2.6), c1: new THREE.Color(2, 0.8, 0.2), a0: 1, size0: 16, size1: 26, life: 0.22, drag: 0, gravity: 0 },
  smoke: { c0: new THREE.Color(0.18, 0.15, 0.13), c1: new THREE.Color(0.45, 0.4, 0.34), a0: 0.65, size0: 6, size1: 22, life: 3.2, drag: 1.4, gravity: -4 },
  steam: { c0: new THREE.Color(0.85, 0.85, 0.85), c1: new THREE.Color(0.7, 0.68, 0.65), a0: 0.4, size0: 1.2, size1: 5, life: 1.2, drag: 2, gravity: -2 },
} satisfies Record<string, Kind>;

export type FxKind = keyof typeof KINDS;
const _carry = new THREE.Vector3();

class Pool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private kind: Kind[];
  private next = 0;
  private mat: THREE.ShaderMaterial;

  constructor(
    private max: number,
    additive: boolean,
  ) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max).fill(1e9);
    this.kind = new Array<Kind>(max).fill(KINDS.spark);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = (this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // Premultiplied colour: additive glows add, smoke blends over.
      blending: additive ? THREE.AdditiveBlending : THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  emit(kind: Kind, at: THREE.Vector3, vx: number, vy: number, vz: number, spread: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.kind[i] = kind;
    this.age[i] = Math.random() * 0.05;
    this.pos[i * 3] = at.x + (Math.random() - 0.5) * spread * 0.3;
    this.pos[i * 3 + 1] = at.y + (Math.random() - 0.5) * spread * 0.3;
    this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * spread * 0.3;
    this.vel[i * 3] = vx + (Math.random() - 0.5) * spread;
    this.vel[i * 3 + 1] = vy + (Math.random() - 0.5) * spread;
    this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * spread;
  }

  update(dt: number, viewportH: number): void {
    this.mat.uniforms.uScale.value = viewportH * 0.9;
    for (let i = 0; i < this.max; i++) {
      const k = this.kind[i];
      const a = (this.age[i] += dt);
      const t = a / k.life;
      if (t >= 1) {
        this.col[i * 4 + 3] = 0;
        this.size[i] = 0;
        continue;
      }
      const dr = Math.exp(-k.drag * dt);
      this.vel[i * 3] *= dr;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dr - k.gravity * dt;
      this.vel[i * 3 + 2] *= dr;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const fade = (1 - t) * Math.min(1, t * 12 + 0.3);
      this.col[i * 4] = k.c0.r + (k.c1.r - k.c0.r) * t;
      this.col[i * 4 + 1] = k.c0.g + (k.c1.g - k.c0.g) * t;
      this.col[i * 4 + 2] = k.c0.b + (k.c1.b - k.c0.b) * t;
      this.col[i * 4 + 3] = k.a0 * fade;
      // Premultiply here so the shader stays one path for both blend modes.
      this.col[i * 4] *= this.col[i * 4 + 3];
      this.col[i * 4 + 1] *= this.col[i * 4 + 3];
      this.col[i * 4 + 2] *= this.col[i * 4 + 3];
      this.size[i] = k.size0 + (k.size1 - k.size0) * t;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}

export class Fx {
  readonly group = new THREE.Group();
  private glow = new Pool(1600, true);
  private smoke = new Pool(700, false);

  constructor() {
    // Smoke first so the additive fire draws over it.
    this.smoke.points.renderOrder = 1;
    this.glow.points.renderOrder = 2;
    this.group.add(this.smoke.points, this.glow.points);
  }

  burst(kind: FxKind, at: THREE.Vector3, vel: THREE.Vector3, n: number, spread: number): void {
    const pool = kind === 'smoke' || kind === 'steam' ? this.smoke : this.glow;
    for (let i = 0; i < n; i++) pool.emit(KINDS[kind], at, vel.x, vel.y, vel.z, spread);
  }

  /** A pod going up: flash, fireball carried along by the wreck's momentum, sparks and a smoke column. */
  explosion(at: THREE.Vector3, vel: THREE.Vector3): void {
    const carry = _carry.copy(vel).multiplyScalar(0.35);
    this.burst('flash', at, carry, 3, 2);
    this.burst('fire', at, carry, 70, 30);
    this.burst('spark', at, carry, 120, 70);
    carry.multiplyScalar(0.4);
    this.burst('smoke', at, carry, 60, 14);
  }

  update(dt: number, viewportH: number): void {
    this.glow.update(dt, viewportH);
    this.smoke.update(dt, viewportH);
  }
}
