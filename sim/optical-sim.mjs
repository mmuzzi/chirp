// Screen-to-camera channel simulator for Chirp Camera, driving the real decoder.
// Models: 120 Hz display with row scan-out and LCD response, rolling-shutter camera with exposure, perspective,
// barrel distortion, hand shake, optical blur, vignetting, sensor noise, and a bright room around the laptop.
//
//   node sim/optical-sim.mjs [preset] [cameraHeight] [fileKB] [--y4m out.y4m] [--seconds N] [--screens 60]
import fs from "node:fs";
import { createRequire } from "node:module";
import { initSync, encode_packets, RaptorQDecoder } from "../vendor/raptorq/raptorqr_raptorq_wasm.js";

const require = createRequire(import.meta.url);
const O = require("../optical.js");
initSync({ module: fs.readFileSync(new URL("../vendor/raptorq/raptorqr_raptorq_wasm_bg.wasm", import.meta.url)) });

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const y4mPath = flag("--y4m", null);
const maxSeconds = Number(flag("--seconds", 20));
const screensPerSec = Number(flag("--screens", 60));
const seed = Number(flag("--seed", 1));
const [presetKey = "fast", camH = "720", fileKB = "200"] = args;

let rngState = seed >>> 0 || 1;
const rand = () => { rngState ^= rngState << 13; rngState >>>= 0; rngState ^= rngState >>> 17; rngState ^= rngState << 5; rngState >>>= 0; return rngState / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const CH = Number(camH), CW = Math.round((CH * 16) / 9);
const harsh = flag("--harsh", "0") === "1";
const P = {
  displayHz: 120, hold: Math.round(120 / screensPerSec), camFps: 59.94, readout: CH >= 1080 ? 0.016 : 0.012,
  exposure: 0.004, lcdTau: 0.003, blur: 0.75, noise: 3.5, black: 22, white: 228, fill: 0.86,
  tiltDeg: 2.5, keystone: 0.04, barrel: -0.015, shakePx: 0.6, room: 150,
};
if (harsh) Object.assign(P, { exposure: 0.008, blur: 1.0, noise: 6, black: 40, white: 200, shakePx: 1.2, tiltDeg: 6, keystone: 0.08, barrel: -0.03, lcdTau: 0.005 });

// ---------- Sender ----------
const fileBytes = Uint8Array.from({ length: Number(fileKB) * 1024 }, () => (rand() * 256) | 0); // incompressible
const savePath = flag("--save", null);
if (savePath) fs.writeFileSync(savePath, fileBytes);
const prep = await O.prepareSend({ encode_packets }, { name: "test.bin", bytes: fileBytes }, { repairPercent: 100 });
const L = O.layout(presetKey);
const screens = new Map();
const screen = (s) => {
  if (s < 0) s = 0;
  let c = screens.get(s);
  if (!c) { c = O.renderScreen(prep, presetKey, s); screens.set(s, c); if (screens.size > 8) screens.delete(screens.keys().next().value); }
  return c;
};

// ---------- Geometry: code cells (with quiet zone) -> camera px ----------
const q = L.quiet;
const totalW = L.W + 2 * q, totalH = L.H + 2 * q;
const codeWpx = CW * P.fill, codeHpx = (codeWpx * totalH) / totalW;
const cx = CW / 2, cy = CH / 2;
const rot = (P.tiltDeg * Math.PI) / 180;
const corner = (sx, sy) => {
  const kx = sx * (codeWpx / 2) * (1 - (sy < 0 ? P.keystone : 0)), ky = sy * (codeHpx / 2);
  return [cx + kx * Math.cos(rot) - ky * Math.sin(rot), cy + kx * Math.sin(rot) + ky * Math.cos(rot)];
};
const Hbase = O.fitHomography(
  [[-q, -q], [L.W + q, -q], [L.W + q, L.H + q], [-q, L.H + q]],
  [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
);
const inv3 = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
};
const Hinv = inv3(Hbase);
const R2 = (CW / 2) ** 2;
const undistort = (x, y) => {
  let ux = x, uy = y;
  for (let it = 0; it < 4; it++) {
    const r2 = ((ux - cx) ** 2 + (uy - cy) ** 2) / R2, k = 1 + P.barrel * r2;
    ux = cx + (x - cx) / k; uy = cy + (y - cy) / k;
  }
  return [ux, uy];
};
// Screen extends beyond the quiet zone (black background), then a bezel, then the room.
const screenMarginCells = 30, bezelCells = 8;

// ---------- Camera frame synthesis ----------
const img = new Float32Array(CW * CH), tmp = new Float32Array(CW * CH);
const out8 = new Uint8Array(CW * CH);
const rowFrac = (v) => 0.1 + 0.8 * Math.min(1, Math.max(0, (v + q) / totalH)); // code rows -> display scan position
function displayValue(cellIdx, u, v, t) {
  // Which screen state is visible at this display row at time t, and how far along the LCD transition is.
  const rf = rowFrac(v);
  const i = Math.floor((t - rf / P.displayHz) * P.displayHz);
  const s = Math.floor(i / P.hold);
  const tSwitch = (s * P.hold) / P.displayHz + rf / P.displayHz;
  const cur = screen(s)[cellIdx] ? P.black : P.white;
  const prev = screen(s - 1)[cellIdx] ? P.black : P.white;
  return cur + (prev - cur) * Math.exp(-(t - tSwitch) / P.lcdTau);
}
function renderFrame(n) {
  const t0 = n / P.camFps + 0.0031;
  const sx = gauss() * P.shakePx + 2 * Math.sin(n / 40), sy = gauss() * P.shakePx + 1.5 * Math.cos(n / 55);
  for (let y = 0; y < CH; y++) {
    const tRow = t0 + (y / CH) * P.readout;
    for (let x = 0; x < CW; x++) {
      const [ux, uy] = undistort(x - sx, y - sy);
      const w = Hinv[6] * ux + Hinv[7] * uy + Hinv[8];
      const u = (Hinv[0] * ux + Hinv[1] * uy + Hinv[2]) / w, v = (Hinv[3] * ux + Hinv[4] * uy + Hinv[5]) / w;
      let val;
      if (u >= 0 && v >= 0 && u < L.W && v < L.H) {
        const k = Math.floor(v) * L.W + Math.floor(u);
        val = (displayValue(k, u, v, tRow) + displayValue(k, u, v, tRow + P.exposure / 2) + displayValue(k, u, v, tRow + P.exposure)) / 3;
      } else if (u >= -q && v >= -q && u < L.W + q && v < L.H + q) val = P.white;
      else if (u >= -q - screenMarginCells && v >= -q - screenMarginCells && u < L.W + q + screenMarginCells && v < L.H + q + screenMarginCells) val = P.black;
      else if (u >= -q - screenMarginCells - bezelCells && v >= -q - screenMarginCells - bezelCells && u < L.W + q + screenMarginCells + bezelCells && v < L.H + q + screenMarginCells + bezelCells) val = 12;
      else val = P.room + 40 * Math.sin(x / 37) * Math.cos(y / 53);
      img[y * CW + x] = val;
    }
  }
  // Separable Gaussian blur.
  const r = Math.ceil(P.blur * 3), kern = [];
  for (let i = -r; i <= r; i++) kern.push(Math.exp(-(i * i) / (2 * P.blur * P.blur)));
  const ks = kern.reduce((a, b) => a + b);
  for (let y = 0; y < CH; y++)
    for (let x = 0; x < CW; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += kern[i + r] * img[y * CW + Math.min(CW - 1, Math.max(0, x + i))];
      tmp[y * CW + x] = s / ks;
    }
  for (let y = 0; y < CH; y++)
    for (let x = 0; x < CW; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += kern[i + r] * tmp[Math.min(CH - 1, Math.max(0, y + i)) * CW + x];
      const vig = 1 - 0.25 * (((x - cx) ** 2 + (y - cy) ** 2) / (cx * cx + cy * cy));
      out8[y * CW + x] = Math.max(0, Math.min(255, Math.round((s / ks) * vig + gauss() * P.noise)));
    }
  return out8;
}

// ---------- Decoder (CPU mirror of the WebGL path) ----------
const DS = 4;
function lowres(full) {
  const w = Math.floor(CW / DS), h = Math.floor(CH / DS), data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < DS; j++) for (let i = 0; i < DS; i++) s += full[(y * DS + j) * CW + x * DS + i];
      data[y * w + x] = s / (DS * DS);
    }
  return { w, h, data };
}
const bilinear = (full, x, y) => {
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  if (x0 < 0 || y0 < 0 || x0 >= CW - 1 || y0 >= CH - 1) return 0;
  const i = y0 * CW + x0;
  return (full[i] * (1 - fx) + full[i + 1] * fx) * (1 - fy) + (full[i + CW] * (1 - fx) + full[i + CW + 1] * fx) * fy;
};
function sampleCells(full, warp) {
  const lum = new Uint8Array(L.W * L.H);
  for (let v = 0; v < L.H; v++)
    for (let u = 0; u < L.W; u++) {
      let s = 0;
      for (const [du, dv] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) {
        const [x, y] = O.warpPoint(warp, u + du, v + dv);
        s += bilinear(full, x, y);
      }
      lum[v * L.W + u] = s / 5;
    }
  return lum;
}

// ---------- Run ----------
let y4m = null;
if (y4mPath) {
  y4m = fs.openSync(y4mPath, "w");
  fs.writeSync(y4m, `YUV4MPEG2 W${CW} H${CH} F60000:1001 Ip A1:1 C420jpeg\n`);
}
const chroma = new Uint8Array((CW / 2) * (CH / 2)).fill(128);
let done = null, locked = 0, cwOk = 0, cwBad = 0, lastUnique = 0, worstResidual = 0;
const asm = new O.Assembler({ RaptorQDecoder }, {
  onDone: (r) => (done = r),
  onProgress: (p) => (lastUnique = p.unique),
  onError: (e) => console.log("assembler error:", e.message),
});
const t0 = Date.now();
const frames = Math.round(maxSeconds * P.camFps);
let n = 0;
for (; n < frames && (!done || y4m); n++) {
  const full = renderFrame(n);
  if (y4m) { fs.writeSync(y4m, "FRAME\n"); fs.writeSync(y4m, full); fs.writeSync(y4m, chroma); fs.writeSync(y4m, chroma); }
  const loc = O.locate(lowres(full), DS, (x0, y0, w, h) => {
    if (x0 < 0 || y0 < 0 || x0 + w > CW || y0 + h > CH) return null;
    const p = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) p.set(full.subarray((y0 + y) * CW + x0, (y0 + y) * CW + x0 + w), y * w);
    return p;
  }, L);
  if (!loc.warp) { if (n < 3) console.log(`frame ${n}: ${loc.reason}`); continue; }
  locked++;
  worstResidual = Math.max(worstResidual, loc.warp.residual);
  const r = O.decodeCells(L, sampleCells(full, loc.warp));
  cwOk += r.ok; cwBad += r.bad;
  for (const p of r.packets) asm.push(p);
  if (n % 30 === 0) console.log(`frame ${n}: locked, ${loc.warp.pxPerCell.toFixed(2)} px/cell, align ${loc.warp.alignFound}/${L.align.length}, codewords ${r.ok}/${r.ok + r.bad} (fixed ${r.fixed} bytes), unique packets ${lastUnique}/${prep.sourcePackets}`);
}
await new Promise((r) => setTimeout(r, 50));
const simSec = n / P.camFps;
console.log(`\n${harsh ? "HARSH " : ""}preset ${presetKey} · camera ${CW}x${CH}@${P.camFps} · ${screensPerSec} screens/s · file ${fileKB} KB`);
console.log(`frames ${n}, locked ${locked}, codewords ok ${cwOk} bad ${cwBad} (${((100 * cwOk) / Math.max(1, cwOk + cwBad)).toFixed(1)}%), worst marker residual ${worstResidual.toFixed(2)} px`);
if (done) {
  const ok = done.bytes.length === fileBytes.length && done.bytes.every((v, i) => v === fileBytes[i]);
  console.log(`RESULT: ${ok ? "file verified" : "MISMATCH"} in ${simSec.toFixed(2)} s of camera time → ${((fileBytes.length * 8) / simSec / 1e6).toFixed(2)} Mbps (sim wall ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
} else console.log(`RESULT: not complete after ${simSec.toFixed(1)} s (${lastUnique}/${prep.sourcePackets} packets)`);
if (y4m) fs.closeSync(y4m);
