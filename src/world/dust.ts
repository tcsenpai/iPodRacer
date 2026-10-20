// Sand kicked up by the engines' repulsors: a pooled point cloud with per-particle alpha (RGBA colours).
import * as THREE from 'three';

const MAX = 700;
const LIFE = 1.6;

export class DustTrail {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel = new Float32Array(MAX * 3);
  private age = new Float32Array(MAX).fill(LIFE);
  private next = 0;

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 4);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const g = sprite.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const mat = new THREE.PointsMaterial({ size: 1.8, map: new THREE.CanvasTexture(sprite), vertexColors: true, transparent: true, depthWrite: false });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  /** Spawn `n` grains at `at` drifting with velocity `v` (m/s) plus random spread. */
  emit(at: THREE.Vector3, v: THREE.Vector3, n: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      this.age[i] = 0;
      this.pos.set([at.x + (Math.random() - 0.5) * 3, at.y, at.z + (Math.random() - 0.5) * 3], i * 3);
      this.vel.set([v.x + (Math.random() - 0.5) * 8, v.y + Math.random() * 4, v.z + (Math.random() - 0.5) * 8], i * 3);
    }
  }

  update(dt: number): void {
    const drag = Math.exp(-2.2 * dt);
    const c = this.col;
    for (let i = 0; i < MAX; i++) {
      const a = (this.age[i] = Math.min(LIFE, this.age[i] + dt));
      const t = a / LIFE;
      for (let k = 0; k < 3; k++) {
        this.vel[i * 3 + k] *= drag;
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      }
      c[i * 4] = 0.86;
      c[i * 4 + 1] = 0.7;
      c[i * 4 + 2] = 0.5;
      c[i * 4 + 3] = t >= 1 ? 0 : 0.35 * (1 - t) * Math.min(1, t * 8);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}
