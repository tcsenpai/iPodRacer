// 2D value noise and fractal sums for the terrain (CPU side, deterministic).
import { hash2 } from '../core/rng';

/** Smooth value noise in [0,1). With `period` > 0 the lattice wraps, so the noise tiles every `period` units. */
export function noise2(x: number, y: number, seed = 0, period = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  let x0 = ix;
  let y0 = iy;
  let x1 = ix + 1;
  let y1 = iy + 1;
  if (period > 0) {
    x0 = ((x0 % period) + period) % period;
    y0 = ((y0 % period) + period) % period;
    x1 = (x0 + 1) % period;
    y1 = (y0 + 1) % period;
  }
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal Brownian motion in roughly [0,1). */
export function fbm2(x: number, y: number, octaves: number, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, y, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    x = x * 2.03 + 11.7;
    y = y * 2.03 - 5.3;
  }
  return sum / norm;
}

/** Ridged noise in [0,1]: sharp crests, used for dune ridges. */
export function ridge2(x: number, y: number, seed = 0): number {
  return 1 - Math.abs(noise2(x, y, seed) * 2 - 1);
}
