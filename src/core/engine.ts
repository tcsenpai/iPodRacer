// Renderer, post-processing and the per-level scene container.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { MsaaRenderPass } from '../render/msaaRenderPass';
import { FinishShader } from '../render/finishShader';
import { SunFlarePass } from '../render/sunFlare';
import { SUN_DIRECTION } from '../world/sky';

export type Quality = 'low' | 'medium' | 'high';

interface QualityProfile {
  maxPixelRatio: number;
  /**
   * MSAA samples of the HDR scene render (0 = off, FXAA instead). 2× rather than 4× on 'high':
   * with the log-depth shaders 4× measured ~+45% GPU time on the surface level vs ~+18% for 2×,
   * and at Retina pixel ratios 2× already gives ~8 coverage samples per CSS pixel.
   */
  samples: number;
  bloom: boolean;
  flare: boolean;
  shadows: boolean;
}

const PROFILES: Record<Quality, QualityProfile> = {
  low: { maxPixelRatio: 1, samples: 0, bloom: false, flare: false, shadows: false },
  medium: { maxPixelRatio: 1.5, samples: 2, bloom: true, flare: true, shadows: true },
  high: { maxPixelRatio: 2, samples: 2, bloom: true, flare: true, shadows: true },
};

/**
 * Per-view gameplay overlays fed to that view's finish pass. Written by the game every frame
 * (`engine.fx[i]`), read once per view in render().
 */
export interface ViewFx {
  /** 0..1 white flash (impacts, crashes). */
  flash: number;
  /** 0..1 red edge tint and chromatic fringe. */
  damage: number;
  /** 0..1 fade to black. */
  fade: number;
  /** 0..1 zoom blur strength. */
  speed: number;
}

/**
 * One complete post chain. Split screen gives every view its own, so the sun-flare probe keeps a
 * temporal history per camera and the finish uniforms (sun position, aspect, fx) never leak between
 * views. Sized to the view, so two half-height chains cost about the memory of one full-screen chain.
 */
class ViewChain {
  readonly composer: EffectComposer;
  readonly renderPass: MsaaRenderPass;
  readonly sunFlare: SunFlarePass;
  readonly bloom: UnrealBloomPass;
  readonly fxaa: FXAAPass;
  readonly finish: ShaderPass;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
    samples: number,
  ) {
    this.composer = new EffectComposer(renderer);
    this.renderPass = new MsaaRenderPass(scene, camera, samples);
    this.sunFlare = new SunFlarePass(camera, SUN_DIRECTION);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.4, 0.9);
    this.fxaa = new FXAAPass();
    // Own uniform copies: ShaderPass clones its shader's uniforms, so each view's overlays are independent.
    this.finish = new ShaderPass(FinishShader);
    // Share the probe's uniform objects so the finish pass reads this frame's sun visibility.
    Object.assign(this.finish.uniforms, this.sunFlare.uniforms);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.sunFlare);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.fxaa);
    this.composer.addPass(this.finish);
  }

  apply(p: QualityProfile): void {
    this.renderPass.samples = p.samples;
    this.bloom.enabled = p.bloom;
    this.sunFlare.enabled = p.flare;
    if (!p.flare) this.sunFlare.uniforms.uFlare.value = 0;
    this.fxaa.enabled = p.samples === 0;
  }

  resize(w: number, h: number, ratio: number): void {
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    // Bloom at CSS resolution regardless of pixel ratio: its blur is resolution-relative, so this
    // keeps the glow radius identical on Retina and makes it 4× cheaper at ratio 2.
    this.bloom.setSize(w, h);
    this.finish.uniforms.uAspect.value = w / h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(time: number, fx: ViewFx): void {
    const u = this.finish.uniforms;
    u.uTime.value = time % 100;
    u.uFlash.value = fx.flash;
    u.uDamage.value = fx.damage;
    u.uFade.value = fx.fade;
    u.uSpeed.value = fx.speed;
    this.composer.render();
  }

  dispose(): void {
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
  }
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  /** View 0's camera (the only one in single-view mode); same object as cameras[0]. */
  readonly camera: THREE.PerspectiveCamera;
  /**
   * One camera per view, top view first. Both always exist so a second player's rig can be built
   * before split screen is switched on; cameras[1] is simply not rendered in single-view mode.
   */
  readonly cameras: readonly [THREE.PerspectiveCamera, THREE.PerspectiveCamera];
  /** Per-view overlays, same indexing as cameras (fx[1] is ignored in single-view mode). */
  readonly fx: readonly [ViewFx, ViewFx] = [
    { flash: 0, damage: 0, fade: 0, speed: 0 },
    { flash: 0, damage: 0, fade: 0, speed: 0 },
  ];
  /**
   * Called right before each view renders, with that view's camera: lets the world re-aim
   * camera-following work (the sun's shadow frustum) when two players are far apart.
   */
  onView: ((index: number, camera: THREE.PerspectiveCamera) => void) | null = null;
  private _scene = new THREE.Scene();
  private readonly chains: ViewChain[];
  private _viewCount: 1 | 2 = 1;
  private viewW = 1;
  private viewH = 1;
  quality: Quality = 'high';

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA lives on the HDR scene target instead (the canvas only gets the final pass)
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES kept after A/B against AgX and Neutral: those two flatten the image and turn the hot
    // engine/laser emissives pink, while ACES' warm roll-off reads like 1977 film stock. The finish
    // pass adds the grade (contrast, split tone) on top.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.3, 2e9);
    this.cameras = [this.camera, new THREE.PerspectiveCamera(68, 1, 0.3, 2e9)];
    this.chains = [new ViewChain(this.renderer, this._scene, this.camera, PROFILES[this.quality].samples)];
    this.applyProfile();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get scene(): THREE.Scene {
    return this._scene;
  }

  get viewCount(): 1 | 2 {
    return this._viewCount;
  }

  /** CSS pixel height of one view (point-sprite sizing, which scales with the viewport height). */
  get viewHeight(): number {
    return this.viewH;
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.applyProfile();
    this.resize();
  }

  /**
   * 1 = full screen (the single-player path), 2 = top/bottom split, each view full width and half
   * height with its own camera and post chain. The second chain is built on demand and freed when
   * going back to one view, so single player carries no extra GPU memory.
   */
  setViewCount(n: 1 | 2): void {
    if (n === this._viewCount) return;
    this._viewCount = n;
    if (n === 2) {
      const chain = new ViewChain(this.renderer, this._scene, this.cameras[1], PROFILES[this.quality].samples);
      chain.apply(PROFILES[this.quality]);
      this.chains.push(chain);
    } else {
      this.chains.pop()?.dispose();
      this.fx[1].flash = this.fx[1].damage = this.fx[1].fade = this.fx[1].speed = 0;
    }
    this.resize();
  }

  /** Replace the scene (each level owns a fresh scene). Disposes GPU resources of the old one unless it is persistent (menu backdrop). */
  setScene(scene: THREE.Scene): void {
    const old = this._scene;
    this._scene = scene;
    for (const c of this.chains) c.renderPass.scene = scene;
    if (old !== scene && !old.userData.persistent) disposeScene(old);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio, PROFILES[this.quality].maxPixelRatio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h);
    this.viewW = w;
    // Split views get equal heights; on an odd height the spare pixel row between them stays black.
    this.viewH = this._viewCount === 1 ? h : Math.floor(h / 2);
    for (const c of this.chains) c.resize(this.viewW, this.viewH, ratio);
  }

  render(time: number): void {
    if (this._viewCount === 1) {
      this.onView?.(0, this.camera);
      this.chains[0].render(time, this.fx[0]);
      return;
    }
    // The last pass of each chain draws to the canvas through the renderer's viewport and scissor
    // (offscreen passes use their own targets' viewports), so each chain lands in its half.
    const r = this.renderer;
    const w = this.viewW;
    const h = this.viewH;
    const full = window.innerHeight;
    r.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      // GL viewports grow upward: view 0 (top) starts at full - h.
      const y = i === 0 ? full - h : 0;
      r.setViewport(0, y, w, h);
      r.setScissor(0, y, w, h);
      this.onView?.(i, this.cameras[i]);
      this.chains[i].render(time, this.fx[i]);
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, w, full);
  }

  private applyProfile(): void {
    const p = PROFILES[this.quality];
    // three does not recompile programs when shadow mapping is toggled: force it, or shadows freeze/never appear.
    if (this.renderer.shadowMap.enabled !== p.shadows) {
      this._scene.traverse((o) => {
        const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (mm) for (const x of Array.isArray(mm) ? mm : [mm]) x.needsUpdate = true;
      });
    }
    this.renderer.shadowMap.enabled = p.shadows;
    for (const c of this.chains) c.apply(p);
  }
}

export function disposeScene(scene: THREE.Scene): void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  scene.traverse((o) => {
    // Lights own their shadow map render target (32 MB at 2048²): free it with the scene.
    if (o instanceof THREE.Light) o.dispose();
    const m = o as THREE.Mesh;
    if (m.geometry && !m.geometry.userData.shared) geos.add(m.geometry);
    const mm = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mm) for (const x of Array.isArray(mm) ? mm : [mm]) if (!x.userData.shared) mats.add(x);
  });
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
  // Procedural IBL maps are generated per level; disposing also frees three's PMREM copy.
  if (scene.environment && !scene.environment.userData.shared) scene.environment.dispose();
}
