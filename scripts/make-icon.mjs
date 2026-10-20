// Procedural app icon (no image assets): Anakin's podracer seen head-on, two turbine engines joined by a
// crackling energy binder, the cockpit tucked behind, racing toward you over Tatooine's dunes under the
// twin suns, framed by an amber ring. Rendered in software with 3x3 supersampling and written as a
// 1024x1024 PNG to build/icon.png, which electron-builder turns into .icns / .ico.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = 1024;
const SS = 3;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function roundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// ------------------------------------------------------------------ scene
const C = { x: 512, y: 512 };
const RING = 470; // outer radius of the badge
const HORIZON = 600;
const SUNS = [
  { x: 360, y: 300, r: 62, col: [1, 0.93, 0.72] },
  { x: 470, y: 352, r: 40, col: [1, 0.78, 0.5] },
];
// Engines, seen nose-on: big intake circles with a cowling ring and a blue band.
const ENGINES = [
  { x: 330, y: 610, r: 118 },
  { x: 694, y: 610, r: 118 },
];
const COCKPIT = { x: 512, y: 700, hw: 70, hh: 36 };

function dunes(x) {
  return HORIZON + Math.sin(x * 0.006 + 1.3) * 22 + Math.sin(x * 0.017) * 9 + (noise(x * 0.01, 3) - 0.5) * 14;
}

function shade(px, py) {
  // Sky: deep teal-blue high up to hot amber at the horizon.
  const sky = mix([0.95, 0.62, 0.32], [0.18, 0.32, 0.55], smooth(HORIZON, 120, py));
  let col = sky;
  // Twin suns with soft glow.
  for (const s of SUNS) {
    const d = Math.hypot(px - s.x, py - s.y);
    col = mix(col, s.col, Math.exp(-Math.max(0, d - s.r) / 60) * 0.55);
    if (d < s.r) col = mix(col, [1, 1, 0.95], smooth(s.r, s.r - 3, d));
  }
  // Dunes: two layers, the near one with wind ripples.
  const far = dunes(px) - 40 + Math.sin(px * 0.004) * 30;
  if (py > far) col = mix([0.86, 0.55, 0.3], [0.7, 0.42, 0.22], smooth(far, far + 60, py));
  const near = dunes(px);
  if (py > near) {
    const ripple = 0.5 + 0.5 * Math.sin(py * 0.25 + px * 0.04 + noise(px * 0.02, py * 0.02) * 4);
    col = mix([0.93, 0.68, 0.4], [0.62, 0.38, 0.2], smooth(near, 1000, py) * 0.8 + ripple * 0.08);
  }
  // Dust trail behind the pod, along the ground.
  const dust = Math.exp(-((py - 720) ** 2) / 3000) * smooth(470, 0, Math.abs(px - 512)) * 0.35;
  col = mix(col, [0.96, 0.82, 0.62], dust);

  // Control cables from the engines back to the cockpit.
  for (const e of ENGINES) {
    const ax = e.x + (e.x < 512 ? 40 : -40);
    const ay = e.y + 60;
    const bx = COCKPIT.x + (e.x < 512 ? -40 : 40);
    const by = COCKPIT.y;
    const dx = bx - ax;
    const dy = by - ay;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (d < 4) col = [0.12, 0.12, 0.14];
  }
  // Cockpit tub: blue with a gold stripe, pilot's helmet on top.
  const cb = roundedBox(px, py, COCKPIT.x, COCKPIT.y, COCKPIT.hw, COCKPIT.hh, 30);
  if (cb < 0) {
    col = py < COCKPIT.y - 4 ? [0.16, 0.36, 0.72] : [0.1, 0.24, 0.52];
    if (Math.abs(py - COCKPIT.y + 2) < 6) col = [0.9, 0.68, 0.2];
  }
  const helm = Math.hypot(px - 512, py - (COCKPIT.y - 40));
  if (helm < 22) col = mix([0.55, 0.4, 0.26], [0.75, 0.58, 0.38], (COCKPIT.y - 40 - py + 22) / 44);

  // Energy binder: a jagged violet-white arc between the engines.
  const bx0 = ENGINES[0].x + 70;
  const bx1 = ENGINES[1].x - 70;
  if (px > bx0 && px < bx1) {
    const t = (px - bx0) / (bx1 - bx0);
    for (let k = 0; k < 3; k++) {
      const yArc = 545 + Math.sin(t * Math.PI) * -10 + (noise(t * 9 + k * 5, k) - 0.5) * 34 * Math.sin(t * Math.PI);
      const d = Math.abs(py - yArc);
      const glow = Math.exp(-d / 5) * (0.5 + 0.5 * Math.sin(t * Math.PI));
      col = mix(col, [0.8, 0.82, 1], clamp(glow * 0.9, 0, 1));
      if (d < 1.6) col = [0.97, 0.97, 1];
    }
  }

  // Engines head-on: dark intake, stator spokes, cowling lip, painted shell with a blue band.
  for (const e of ENGINES) {
    const d = Math.hypot(px - e.x, py - e.y);
    if (d < e.r) {
      const a = Math.atan2(py - e.y, px - e.x);
      if (d < e.r * 0.68) {
        // Intake: dark throat with radial vanes and a bright hub.
        col = [0.07, 0.07, 0.09];
        const spoke = Math.abs(Math.sin(a * 6.5)) < 0.12 && d > e.r * 0.18;
        if (spoke) col = [0.42, 0.43, 0.46];
        if (d < e.r * 0.18) col = mix([0.75, 0.76, 0.8], [0.35, 0.36, 0.4], d / (e.r * 0.18));
      } else if (d < e.r * 0.8) {
        // Rolled lip, lit from the upper left.
        const lit = 0.55 + 0.45 * Math.cos(a + 2.3);
        col = mix([0.35, 0.36, 0.4], [0.92, 0.93, 0.95], lit);
      } else {
        const lit = 0.5 + 0.5 * Math.cos(a + 2.3);
        col = mix([0.45, 0.46, 0.5], [0.85, 0.86, 0.88], lit);
        if (d > e.r * 0.88 && d < e.r * 0.95) col = mix([0.08, 0.2, 0.45], [0.2, 0.42, 0.85], lit);
        // Rivets around the cowling.
        if (Math.abs(d - e.r * 0.84) < 3.5 && Math.abs(Math.sin(a * 18)) > 0.96) col = [0.25, 0.25, 0.27];
      }
      // Soft outline.
      if (d > e.r - 3) col = mix(col, [0.1, 0.1, 0.12], 0.7);
    }
  }

  // Amber ring frame and vignette inside it.
  const r = Math.hypot(px - C.x, py - C.y);
  col = col.map((v) => v * (1 - smooth(300, RING, r) * 0.35));
  if (r > RING - 26 && r < RING) {
    const lit = 0.6 + 0.4 * Math.cos(Math.atan2(py - C.y, px - C.x) + 2.3);
    col = mix([0.65, 0.38, 0.08], [1, 0.75, 0.3], lit);
    if (Math.abs(r - (RING - 13)) < 2) col = [1, 0.88, 0.55];
  }
  const alpha = smooth(RING + 1, RING - 1, r);
  return [col[0], col[1], col[2], alpha];
}

// ------------------------------------------------------------------ render
const rgba = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += c[0] * c[3];
        g += c[1] * c[3];
        b += c[2] * c[3];
        a += c[3];
      }
    }
    const i = (y * N + x) * 4;
    const k = a > 0 ? 1 / a : 0;
    // Un-premultiply, then gamma-encode the linear-ish colours for display.
    rgba[i] = Math.round(Math.pow(clamp(r * k, 0, 1), 1 / 1.15) * 255);
    rgba[i + 1] = Math.round(Math.pow(clamp(g * k, 0, 1), 1 / 1.15) * 255);
    rgba[i + 2] = Math.round(Math.pow(clamp(b * k, 0, 1), 1 / 1.15) * 255);
    rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

// ------------------------------------------------------------------ PNG
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log(`build/icon.png ${N}x${N}, ${(png.length / 1024).toFixed(0)} KB`);
