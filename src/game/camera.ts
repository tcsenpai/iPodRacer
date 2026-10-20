// Camera rig: in-race views (chase, far chase, cockpit) with speed FOV, lag-swing in corners and shake,
// plus the cinematic shots used by the intro, crashes and the finish.
import * as THREE from 'three';
import { clamp, damp } from '../core/rng';
import type { CameraMode } from '../core/settings';
import { groundHeight } from '../world/terrain';
import type { Track } from '../world/track';
import { VBOOST, type Pod } from './pod';

export type Shot =
  | { kind: 'race' }
  /** High sweeping crane over a point (the starting grid). */
  | { kind: 'crane'; at: THREE.Vector3; heading: number }
  /** Close orbit around a pod (rival introductions). */
  | { kind: 'orbit'; pod: Pod }
  /** Planted low on the sand ahead of a pod, looking back at it. */
  | { kind: 'low'; pod: Pod }
  /** Camera stops where it is and watches the wreck. */
  | { kind: 'crash'; pod: Pod }
  /** Wide slow orbit around the winner. */
  | { kind: 'finish'; pod: Pod };

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _prev = new THREE.Vector3();

export class CameraRig {
  mode: CameraMode = 'chase';
  shot: Shot = { kind: 'race' };
  /** World velocity of the camera (for doppler). */
  readonly velocity = new THREE.Vector3();
  private t = 0;
  private yaw = 0;
  private camY = 0;
  private shakeAmt = 0;
  private fovKick = 0;
  private time = 0;
  private snap = true;
  private readonly fixed = new THREE.Vector3();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    /** Swapped by main when a new course is built (the rigs outlive worlds). */
    public track: Track,
  ) {}

  setShot(shot: Shot): void {
    this.shot = shot;
    this.t = 0;
    this.snap = true;
    if (shot.kind === 'crash') this.fixed.copy(this.camera.position);
  }

  /** Add trauma (0..1); decays quickly. */
  shake(amount: number): void {
    this.shakeAmt = Math.min(1.2, this.shakeAmt + amount);
  }

  /** FOV punch in degrees (boost ignition). */
  kick(deg: number): void {
    this.fovKick = Math.max(this.fovKick, deg);
  }

  /** `dt` is real time (shots keep moving smoothly during slow motion). */
  update(dt: number, player: Pod): void {
    this.time += dt;
    this.t += dt;
    const cam = this.camera;
    _prev.copy(cam.position);
    const s = this.shot;
    let fov = 70;
    let shake = this.shakeAmt;
    cam.up.set(0, 1, 0);

    if (s.kind === 'race') {
      const pod = player;
      const v = pod.speed;
      const sp = clamp(v / VBOOST, 0, 1.1);
      if (this.snap) this.yaw = pod.heading;
      // Lagging yaw: in a corner the pod swings across the frame before the camera catches up.
      let dy = pod.heading - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += dy * damp(this.mode === 'far' ? 3 : 4.5, dt);
      if (this.mode === 'cockpit') {
        pod.model.eyeAnchor.getWorldPosition(cam.position);
        pod.model.cockpit.getWorldQuaternion(cam.quaternion);
        fov = 80 + sp * 18;
        shake += sp * sp * 0.25 + (pod.boosting ? 0.25 : 0);
      } else {
        const far = this.mode === 'far';
        const dist = (far ? 36 : 23) - sp * 3;
        const h = (far ? 10 : 5.2) - sp * 1.2;
        const fx = Math.sin(this.yaw);
        const fz = -Math.cos(this.yaw);
        cam.position.set(pod.pos.x - fx * dist, 0, pod.pos.z - fz * dist);
        const ground = groundHeight(this.track, cam.position.x, cam.position.z);
        const wantY = Math.max(pod.pos.y + h, ground + 1.8);
        this.camY = this.snap ? wantY : this.camY + (wantY - this.camY) * damp(7, dt);
        cam.position.y = Math.max(this.camY, ground + 1.2);
        _a.set(pod.pos.x + Math.sin(pod.heading) * 22, pod.pos.y + 1.2, pod.pos.z - Math.cos(pod.heading) * 22);
        cam.lookAt(_a);
        // Lean the horizon into the bank a little: the frame tilts with the pod.
        cam.rotateZ(-clamp(pod.bank, -0.9, 0.9) * 0.22);
        fov = 70 + sp * 24;
        shake += sp * sp * 0.12 + (pod.boosting ? 0.18 : 0) + (pod.offTrack > 0 ? 0.12 * pod.offTrack * sp : 0);
      }
    } else if (s.kind === 'crane') {
      const a = -0.5 + this.t * 0.12;
      const r = 120 - this.t * 12;
      _a.set(Math.sin(s.heading + Math.PI + a) * r, 55 - this.t * 7, -Math.cos(s.heading + Math.PI + a) * r);
      cam.position.copy(s.at).add(_a);
      cam.lookAt(s.at);
      fov = 55;
    } else if (s.kind === 'orbit' || s.kind === 'finish') {
      const pod = s.pod;
      const fin = s.kind === 'finish';
      // Centre on the whole machine (engines to cockpit), start from a front three-quarter view.
      const a = (fin ? 0.4 : 2.3) + this.t * (fin ? 0.35 : 0.3);
      const r = fin ? 26 : 17;
      _a.set(Math.sin(a) * r, fin ? 5 : 2.6, Math.cos(a) * r + 5);
      _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -pod.heading);
      _a.applyQuaternion(_q);
      cam.position.copy(pod.pos).add(_a);
      const g = groundHeight(this.track, cam.position.x, cam.position.z) + 1;
      if (cam.position.y < g) cam.position.y = g;
      _b.set(0, 0.5, 5).applyQuaternion(_q).add(pod.pos);
      cam.lookAt(_b);
      fov = fin ? 58 : 48;
    } else if (s.kind === 'low') {
      const pod = s.pod;
      if (this.snap) {
        const fx = Math.sin(pod.heading);
        const fz = -Math.cos(pod.heading);
        this.fixed.set(pod.pos.x + fx * 26 + fz * 7, 0, pod.pos.z + fz * 26 - fx * 7);
        this.fixed.y = groundHeight(this.track, this.fixed.x, this.fixed.z) + 0.8;
      }
      cam.position.copy(this.fixed);
      cam.position.y += this.t * 0.25;
      _a.copy(pod.pos);
      _a.y += 0.8;
      cam.lookAt(_a);
      fov = 40 - this.t * 2;
    } else {
      // Crash: hold position, track the wreck.
      cam.position.copy(this.fixed);
      cam.lookAt(s.pod.pos);
      fov = 60 - Math.min(this.t * 6, 12);
    }

    // Trauma shake: smooth pseudo-noise rotation, quadratic in trauma so small bumps stay subtle.
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 1.6);
    const k = shake * shake * 0.03;
    if (k > 0) {
      const tt = this.time * 31;
      cam.rotateX((Math.sin(tt * 1.3) + Math.sin(tt * 2.9 + 1.1) * 0.5) * k);
      cam.rotateY((Math.sin(tt * 1.7 + 2.3) + Math.sin(tt * 3.3) * 0.5) * k);
      cam.rotateZ(Math.sin(tt * 1.1 + 0.7) * k * 0.6);
    }
    this.fovKick = Math.max(0, this.fovKick - dt * 22);
    fov += this.fovKick;
    if (this.snap) cam.fov = fov;
    else cam.fov += (fov - cam.fov) * damp(5, dt);
    cam.updateProjectionMatrix();
    if (!this.snap && dt > 0) this.velocity.copy(cam.position).sub(_prev).divideScalar(dt);
    else this.velocity.set(0, 0, 0);
    this.snap = false;
  }
}
