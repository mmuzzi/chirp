// Offline channel simulation: band-limited speaker, echo, noise, sample-rate drift, chunked delivery.
// Every case runs all decoders at once, exactly like the page does.  Run: node test.js
const M = require("./modem.js");

const PARAGRAPH =
  "Hey — here's the plan for Thursday. Pull the latest from main, run the migration script against staging first, " +
  "and check the dashboard numbers against last week's export before touching prod. If row counts are off by more " +
  "than a percent, stop and ping me. The gist with the SQL is 8f3a1c2e9b7d4f6a0e5c3b1d2a9f8e7c and the runbook is in " +
  "the team drive under Ops / Migrations / 2026-Q4. Thanks!";
const LONG = Array.from({ length: 6 }, (_, i) => `${i + 1}. ${PARAGRAPH}`).join("\n");
const CASES = ["8f3a1c2e9b7d4f6a0e5c3b1d2a9f8e7c", "https://gist.github.com/x/abc", "hello ✓", "a", "CAFE", PARAGRAPH, LONG];
const CONDITIONS = {
  clean: { snr: 25, echo: false, drift: 0, delay: 1234 },
  room: { snr: 10, echo: true, drift: 0.0005, delay: 777 },
  harsh: { snr: 3, echo: true, drift: -0.0003, delay: 5000 },
};

function onePole(x, sr, fc, high) {
  const a = Math.exp((-2 * Math.PI * fc) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y = (1 - a) * x[i] + a * y;
    const out = high ? x[i] - y : y;
    x[i] = out;
  }
  return x;
}

function channel(x, sr, { snr, echo, drift, delay }) {
  const y = new Float32Array(Math.round(x.length * (1 + Math.abs(drift))) + delay + 8000);
  for (let i = 0; i < x.length; i++) {
    const t = i * (1 + drift), i0 = Math.floor(t), f = t - i0;
    y[delay + i] = 0.2 * ((x[i0] || 0) * (1 - f) + (x[i0 + 1] || 0) * f);
  }
  onePole(y, sr, 700, true); // small phone speaker: weak lows
  onePole(y, sr, 7000, false); // and rolled-off highs
  if (echo) for (const [d, g] of [[0.01, 0.5], [0.027, 0.35], [0.06, 0.2], [0.085, 0.12]]) {
    const n = Math.round(d * sr);
    for (let i = y.length - 1; i >= n; i--) y[i] += g * y[i - n];
  }
  const sig = Math.sqrt(y.reduce((a, v) => a + v * v, 0) / y.length);
  const amp = (sig / Math.pow(10, snr / 20)) * Math.sqrt(3);
  for (let i = 0; i < y.length; i++) y[i] += amp * (Math.random() * 2 - 1);
  return y;
}

function listen(audio, sr) {
  return new Promise((resolve) => {
    const got = [], errors = [], modes = new Set();
    const rx = new M.Receiver({ onMessage: (m) => got.push(m.text ?? m.file), onError: (e) => errors.push(e.message) });
    const decoders = Object.keys(M.MODES).map((m) => new M.Decoder(sr, m, (f) => { modes.add(f.mode); rx.push(f); }));
    for (let i = 0; i < audio.length; i += 4096) for (const d of decoders) d.push(audio.subarray(i, i + 4096));
    setTimeout(() => resolve({ got, errors, modes: [...modes] }), 20); // let async decompression settle
  });
}

const concat = (parts) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

(async () => {
  let pass = 0, total = 0;
  const failures = {};
  for (const sr of [44100, 48000]) for (const mode of Object.keys(M.MODES)) for (const text of CASES)
    for (const [cname, cond] of Object.entries(CONDITIONS)) {
      total++;
      const audio = channel(M.synthesize(await M.encode(text, mode), sr, mode), sr, cond);
      const { got, modes } = await listen(audio, sr);
      if (got.length === 1 && got[0] === text && modes.join() === mode) pass++;
      else {
        const k = `${mode}/${cname}`;
        failures[k] = (failures[k] || 0) + 1;
        if (got.length && got[0] !== text) console.log("WRONG TEXT", sr, mode, cname, JSON.stringify(got[0]).slice(0, 60));
      }
    }
  console.log(`${pass}/${total} single-pass decodes (all modes listening)`, failures);

  // Lost chunk: the first pass has one frame blanked out, the loop's second pass fills it in.
  for (const mode of ["turbo", "fast"]) {
    const sr = 48000, frames = await M.encode(LONG, mode);
    const first = frames.map((f, i) => (i === 2 ? f.map((s) => s.map(() => 0)).slice(0, 3) : f));
    const audio = channel(concat([M.synthesize(first, sr, mode), new Float32Array(sr * 0.6), M.synthesize(frames, sr, mode)]), sr, CONDITIONS.room);
    const { got } = await listen(audio, sr);
    console.log(`lost chunk + resend (${mode}, ${frames.length} frames): ${got.length === 1 && got[0] === LONG ? "OK" : "FAIL " + got.length}`);
  }

  // Files: random binary (incompressible) and a text file (compressible), round-tripped byte for byte.
  {
    const bin = Uint8Array.from({ length: 1500 }, () => (Math.random() * 256) | 0);
    const txt = new TextEncoder().encode(LONG + "\n" + PARAGRAPH.repeat(3));
    for (const mode of ["turbo", "fast"]) for (const [name, bytes] of [["photo.bin", bin], ["notes – café.txt", txt]]) {
      const sr = 48000, frames = await M.encode({ name, bytes }, mode);
      const { got } = await listen(channel(M.synthesize(frames, sr, mode), sr, CONDITIONS.room), sr);
      const f = got[0];
      const ok = got.length === 1 && f.name === name && f.bytes.length === bytes.length && f.bytes.every((v, i) => v === bytes[i]);
      console.log(`file ${mode} ${name} ${bytes.length} B → ${frames.length} chunks, ${M.duration(frames, mode).toFixed(1)}s: ${ok ? "OK" : "FAIL"}`);
    }
  }

  // False positives: 60s of noise plus random tone bursts must decode nothing.
  {
    const sr = 48000, noise = new Float32Array(sr * 60);
    let ph = 0, f = 2000;
    for (let i = 0; i < noise.length; i++) {
      if (i % 2000 === 0) f = 1000 + Math.random() * 6500;
      ph += (2 * Math.PI * f) / sr;
      noise[i] = 0.3 * (Math.random() - 0.5) + 0.3 * Math.sin(ph);
    }
    const { got, errors } = await listen(noise, sr);
    console.log(`false positives in 60s noise: ${got.length}, errors: ${errors.length}`);
  }

  // Randomized messages at room conditions.
  for (const mode of Object.keys(M.MODES)) {
    let ok = 0;
    const N = 60;
    for (let t = 0; t < N; t++) {
      const len = 1 + Math.floor(Math.random() * 300);
      const text = t % 2
        ? [...Array(len)].map(() => "0123456789abcdef"[(Math.random() * 16) | 0]).join("")
        : [...Array(len)].map(() => String.fromCharCode(32 + ((Math.random() * 90) | 0))).join("");
      const audio = channel(M.synthesize(await M.encode(text, mode), 44100, mode), 44100, { ...CONDITIONS.room, drift: (Math.random() - 0.5) * 1e-3 });
      const { got } = await listen(audio, 44100);
      if (got.length === 1 && got[0] === text) ok++;
    }
    console.log(`randomized ${mode}: ${ok}/${N}`);
  }

  console.log("\nAirtime (one pass):");
  for (const [name, text] of [["gist id", CASES[0]], [`paragraph (${PARAGRAPH.length} chars)`, PARAGRAPH], [`long (${LONG.length} chars)`, LONG]]) {
    const row = [];
    for (const mode of Object.keys(M.MODES)) row.push(`${mode} ${M.duration(await M.encode(text, mode), mode).toFixed(1)}s`);
    console.log(`  ${name.padEnd(24)} ${row.join("  ")}`);
  }
})();
