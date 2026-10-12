// Tiny acoustic modem: 17-tone differential MFSK, 4 bits per tone, 1 or more parallel channels.
//
// Frame (all fields are nibbles after the preamble):
//   preamble (8 symbols) | head (1) | [id (3) | idx (4) | total (4)] | len (2) | payload (len) | CRC-16 (4)
//   head bits 0-1 = type (0 UTF-8, 1 lowercase hex, 2 deflate-raw UTF-8, 3 file), bit 2 = multi-frame (bracketed fields present).
// File payload bytes: flags (1, bit 0 = deflated) | name length (1) | name (UTF-8) | CRC-32 of the file (4) | data.
// Each nibble n is sent as tone (prev + 1 + n) % 17, so consecutive tones on a channel always differ and the
// decoder can ignore the previous tone, which is what room echo smears into the current symbol.
// With C channels, symbol t carries nibbles tC..tC+C-1 on C interleaved tone sets played simultaneously.
(function (root) {
  const NT = 17;
  const PREAMBLE = [0, 16, 0, 16, 3, 13, 6, 10];
  const HOPS_PER_SYMBOL = 6;
  const CHUNK_NIBBLES = 192;
  const MAX_CHUNKS = 65535;
  const REPAIR_SLOTS = 8; // 8 singles + 28 pairs: ~36 extra CRC checks, ~1 in 1800 chance of a false accept per damaged frame

  const MODES = {
    turbo: { label: "Turbo", channels: 4, base: 1200, spacing: 93.75, sym: 0.04 },
    fast: { label: "Fast", channels: 1, base: 1875, spacing: 187.5, sym: 0.04 },
    normal: { label: "Normal", channels: 1, base: 1875, spacing: 187.5, sym: 0.06 },
    robust: { label: "Robust", channels: 1, base: 1875, spacing: 187.5, sym: 0.1 },
  };
  const tonesOf = (m) =>
    Array.from({ length: m.channels }, (_, c) => Array.from({ length: NT }, (_, k) => m.base + (k * m.channels + c) * m.spacing));

  function crc16(nibbles) {
    let crc = 0xffff;
    for (const n of nibbles) {
      crc ^= n << 8;
      for (let i = 0; i < 4; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  const toNibbles = (value, count) =>
    Array.from({ length: count }, (_, i) => (value >> (4 * (count - 1 - i))) & 0xf);
  const fromNibbles = (ns) => ns.reduce((a, n) => (a << 4) | n, 0);
  const bytesToNibbles = (bytes) => [...bytes].flatMap((b) => toNibbles(b, 2));
  const nibblesToBytes = (ns) => Uint8Array.from({ length: ns.length >> 1 }, (_, i) => (ns[2 * i] << 4) | ns[2 * i + 1]);

  const CRC32_TABLE = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function pipe(bytes, stream) {
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
    return new Uint8Array(out);
  }

  // Text -> { type, nibbles }, picking the most compact representation that round-trips exactly.
  async function packMessage(text) {
    if (/^[0-9a-f]+$/.test(text)) return { type: 1, nibbles: [...text].map((c) => parseInt(c, 16)) };
    const raw = new TextEncoder().encode(text);
    const deflated = raw.length > 24 ? await pipe(raw, new CompressionStream("deflate-raw")) : null;
    return deflated && deflated.length < raw.length
      ? { type: 2, nibbles: bytesToNibbles(deflated) }
      : { type: 0, nibbles: bytesToNibbles(raw) };
  }

  async function packFile(name, data) {
    const deflated = await pipe(data, new CompressionStream("deflate-raw"));
    const useDeflate = deflated.length < data.length;
    let nameBytes = new TextEncoder().encode(name);
    while (nameBytes.length > 255) nameBytes = new TextEncoder().encode((name = name.slice(0, -1)));
    const crc = crc32(data);
    const body = useDeflate ? deflated : data;
    const out = new Uint8Array(2 + nameBytes.length + 4 + body.length);
    out.set([useDeflate ? 1 : 0, nameBytes.length]);
    out.set(nameBytes, 2);
    out.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], 2 + nameBytes.length);
    out.set(body, 6 + nameBytes.length);
    return { type: 3, nibbles: bytesToNibbles(out) };
  }

  // -> { text } or { file: { name, bytes } }
  async function unpackMessage(type, nibbles) {
    if (type === 1) return { text: nibbles.map((n) => n.toString(16)).join("") };
    const bytes = nibblesToBytes(nibbles);
    if (type !== 3)
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(type === 2 ? await pipe(bytes, new DecompressionStream("deflate-raw")) : bytes) };
    const nameLen = bytes[1];
    const name = new TextDecoder().decode(bytes.subarray(2, 2 + nameLen));
    const crc = ((bytes[2 + nameLen] << 24) | (bytes[3 + nameLen] << 16) | (bytes[4 + nameLen] << 8) | bytes[5 + nameLen]) >>> 0;
    const body = bytes.subarray(6 + nameLen);
    const data = bytes[0] & 1 ? await pipe(body, new DecompressionStream("deflate-raw")) : body;
    if (crc32(data) !== crc) throw new Error(`File "${name}" failed its checksum; listening for a resend`);
    return { file: { name, bytes: data } };
  }

  // Message -> list of frames, each a list of nibbles (without preamble).
  function frameMessage({ type, nibbles }) {
    if (nibbles.length <= 255) {
      const body = [type, ...toNibbles(nibbles.length, 2), ...nibbles];
      return [[...body, ...toNibbles(crc16(body), 4)]];
    }
    const id = crc16(nibbles) & 0xfff;
    const total = Math.ceil(nibbles.length / CHUNK_NIBBLES);
    if (total > MAX_CHUNKS) throw new Error(`Too large: ${total} chunks (max ${MAX_CHUNKS}, ~${Math.floor((MAX_CHUNKS * CHUNK_NIBBLES) / 2048)} KB after compression)`);
    return Array.from({ length: total }, (_, idx) => {
      const chunk = nibbles.slice(idx * CHUNK_NIBBLES, (idx + 1) * CHUNK_NIBBLES);
      const body = [type | 4, ...toNibbles(id, 3), ...toNibbles(idx, 4), ...toNibbles(total, 4), ...toNibbles(chunk.length, 2), ...chunk];
      return [...body, ...toNibbles(crc16(body), 4)];
    });
  }

  // Frame nibbles -> symbols: each symbol is an array of C tone indices (one per channel).
  function frameSymbols(nibbles, mode) {
    const C = mode.channels;
    const padded = [...nibbles, ...Array((C - (nibbles.length % C)) % C).fill(0)];
    const prev = Array(C).fill(PREAMBLE[PREAMBLE.length - 1]);
    const syms = PREAMBLE.map((k) => Array(C).fill(k));
    for (let t = 0; t < padded.length / C; t++)
      syms.push(prev.map((p, c) => (prev[c] = (p + 1 + padded[t * C + c]) % NT)));
    return syms;
  }

  // input: a string, or { name, bytes } for a file.
  async function encode(input, modeName) {
    const mode = MODES[modeName];
    const packed = typeof input === "string" ? await packMessage(input) : await packFile(input.name, input.bytes);
    return frameMessage(packed).map((f) => frameSymbols(f, mode));
  }

  const GAP_SEC = 0.05;
  const duration = (frames, modeName) =>
    GAP_SEC * (frames.length + 1) + frames.reduce((a, f) => a + f.length, 0) * MODES[modeName].sym;

  function synthesize(frames, sampleRate, modeName) {
    const mode = MODES[modeName];
    const tones = tonesOf(mode);
    const n = Math.round(mode.sym * sampleRate);
    const fade = Math.round(0.005 * sampleRate);
    const gap = Math.round(GAP_SEC * sampleRate);
    const amp = 0.85 / mode.channels;
    const out = new Float32Array(frames.reduce((a, f) => a + gap + f.length * n, gap));
    const phase = tones.map((_, c) => (c * Math.PI) / 2); // staggered phases to lower the peak
    let pos = gap;
    for (const syms of frames) {
      for (const sym of syms) {
        sym.forEach((k, c) => {
          const w = (2 * Math.PI * tones[c][k]) / sampleRate;
          for (let i = 0; i < n; i++) {
            out[pos + i] += amp * Math.min(1, i / fade, (n - 1 - i) / fade) * Math.sin(phase[c]);
            phase[c] += w;
          }
        });
        pos += n;
      }
      pos += gap;
    }
    return out;
  }

  // Streaming decoder for one mode. Feed it raw mic samples; it calls onFrame(frame) for every CRC-valid frame.
  class Decoder {
    constructor(sampleRate, modeName, onFrame, onDebug) {
      const mode = MODES[modeName];
      this.modeName = modeName;
      this.C = mode.channels;
      this.symLen = Math.round(mode.sym * sampleRate);
      this.hop = Math.round(this.symLen / HOPS_PER_SYMBOL);
      this.win = Math.round(this.symLen * 0.7);
      this.margin = Math.round((this.symLen - this.win) / 2);
      this.coeffs = tonesOf(mode).flat().map((f) => 2 * Math.cos((2 * Math.PI * f) / sampleRate));
      this.hann = Float32Array.from({ length: this.win }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.win - 1)));
      this.buf = new Float32Array(0);
      this.bufStart = 0; // absolute sample index of buf[0]
      this.nextHopAt = 0; // absolute sample index of next analysis window start
      this.frames = []; // per hop: { e: tone energies normalized per channel, rms }
      this.framesStart = 0; // absolute index of frames[0]
      this.cursor = 0; // absolute hop index of next preamble candidate
      this.onFrame = onFrame;
      this.onDebug = onDebug || (() => {});
    }

    push(samples) {
      const merged = new Float32Array(this.buf.length + samples.length);
      merged.set(this.buf);
      merged.set(samples, this.buf.length);
      this.buf = merged;
      while (this.nextHopAt + this.margin + this.win <= this.bufStart + this.buf.length) {
        this.frames.push(this.analyze(this.nextHopAt + this.margin - this.bufStart));
        this.nextHopAt += this.hop;
      }
      this.scan();
      this.trim();
    }

    analyze(offset) {
      const { win, buf, hann, coeffs } = this;
      const x = new Float32Array(win);
      let rms = 0;
      for (let i = 0; i < win; i++) {
        x[i] = buf[offset + i] * hann[i];
        rms += buf[offset + i] ** 2;
      }
      const e = new Float32Array(coeffs.length);
      for (let k = 0; k < coeffs.length; k++) {
        const c = coeffs[k];
        let s1 = 0, s2 = 0;
        for (let i = 0; i < win; i++) {
          const s0 = x[i] + c * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        e[k] = s1 * s1 + s2 * s2 - c * s1 * s2;
      }
      for (let ch = 0; ch < this.C; ch++) {
        let total = 0;
        for (let k = 0; k < NT; k++) total += e[ch * NT + k];
        if (total > 0) for (let k = 0; k < NT; k++) e[ch * NT + k] /= total;
      }
      return { e, rms: Math.sqrt(rms / win) };
    }

    frame(abs) {
      return this.frames[abs - this.framesStart];
    }

    preambleScore(abs) {
      let score = 0;
      for (let j = 0; j < PREAMBLE.length; j++) {
        const f = this.frame(abs + j * HOPS_PER_SYMBOL);
        if (f.rms < 1e-4) return 0;
        for (let ch = 0; ch < this.C; ch++) score += f.e[ch * NT + PREAMBLE[j]];
      }
      return score / (PREAMBLE.length * this.C);
    }

    // Decode the first n nibbles of the frame body starting at hop index `start`.
    // `flips` is a Set of "t:ch" keys where the runner-up tone is used instead of the best one.
    // Returns nibbles plus, per symbol slot, how close the runner-up was (1 = coin toss).
    readNibbles(start, n, flips) {
      const C = this.C;
      const prev = Array(C).fill(PREAMBLE[PREAMBLE.length - 1]);
      const out = [], doubt = [];
      for (let t = 0; out.length < n; t++) {
        const e = this.frame(start + t * HOPS_PER_SYMBOL).e;
        for (let ch = 0; ch < C && out.length < n; ch++) {
          let best = -1, second = -1;
          for (let k = 0; k < NT; k++) {
            if (k === prev[ch]) continue;
            const v = e[ch * NT + k];
            if (best < 0 || v > e[ch * NT + best]) { second = best; best = k; }
            else if (second < 0 || v > e[ch * NT + second]) second = k;
          }
          const key = `${t}:${ch}`;
          const pick = flips && flips.has(key) ? second : best;
          doubt.push({ key, r: e[ch * NT + second] / (e[ch * NT + best] || 1) });
          out.push((pick - prev[ch] - 1 + NT) % NT);
          prev[ch] = pick;
        }
      }
      return { nibbles: out, doubt };
    }

    // Try to decode a frame body at `start`. Returns "wait" if more audio is needed, null if invalid.
    tryFrame(start, flips) {
      const have = (n) => start + (Math.ceil(n / this.C) - 1) * HOPS_PER_SYMBOL < this.framesStart + this.frames.length;
      if (!have(1)) return "wait";
      const head = this.readNibbles(start, 1, flips).nibbles[0];
      if (head > 7) return null;
      const multi = (head & 4) !== 0;
      const hdrLen = multi ? 14 : 3;
      if (!have(hdrLen)) return "wait";
      const hdr = this.readNibbles(start, hdrLen, flips).nibbles;
      const len = fromNibbles(hdr.slice(hdrLen - 2));
      if (len === 0 || (multi && fromNibbles(hdr.slice(4, 8)) >= fromNibbles(hdr.slice(8, 12)))) return null;
      const total = hdrLen + len + 4;
      if (!have(total)) return "wait";
      const { nibbles: all, doubt } = this.readNibbles(start, total, flips);
      const body = all.slice(0, hdrLen + len);
      return {
        ok: fromNibbles(all.slice(-4)) === crc16(body),
        doubt,
        symbols: Math.ceil(total / this.C),
        frame: {
          type: head & 3,
          multi,
          id: multi ? fromNibbles(hdr.slice(1, 4)) : null,
          idx: multi ? fromNibbles(hdr.slice(4, 8)) : 0,
          total: multi ? fromNibbles(hdr.slice(8, 12)) : 1,
          nibbles: body.slice(hdrLen),
          mode: this.modeName,
        },
      };
    }

    // CRC failed: retry with the runner-up tone at the least confident slots, singly then in pairs.
    repair(start, first) {
      const weak = [...first.doubt].sort((a, b) => b.r - a.r).slice(0, REPAIR_SLOTS).map((d) => d.key);
      const tries = [];
      for (let i = 0; i < weak.length; i++) tries.push([weak[i]]);
      for (let i = 0; i < weak.length; i++) for (let j = i + 1; j < weak.length; j++) tries.push([weak[i], weak[j]]);
      for (const keys of tries) {
        const r = this.tryFrame(start, new Set(keys));
        if (r && r !== "wait" && r.ok) return r;
      }
      return null;
    }

    scan() {
      const H = HOPS_PER_SYMBOL;
      const preLen = PREAMBLE.length * H;
      while (this.cursor + preLen + 2 * H <= this.framesStart + this.frames.length) {
        const c = this.cursor;
        const score = this.preambleScore(c);
        if (score < 0.5) { this.cursor++; continue; }
        // Refine to the local maximum within ±half a symbol.
        let best = c, bestScore = score;
        for (let d = 1; d <= H / 2; d++) {
          if (c + d + preLen > this.framesStart + this.frames.length) return; // wait for more audio
          const s = this.preambleScore(c + d);
          if (s > bestScore) { best = c + d; bestScore = s; }
        }
        const start = best + preLen;
        let r = this.tryFrame(start);
        if (r === "wait") return;
        if (r && !r.ok && bestScore >= 0.65) r = this.repair(start, r) || r;
        this.onDebug({ ok: !!(r && r.ok), score: bestScore, frame: r && r.frame });
        if (r && r.ok) {
          this.onFrame(r.frame);
          this.cursor = start + r.symbols * H;
        } else {
          this.cursor = best + H / 2 + 1; // nearby offsets would decode the same way
        }
      }
    }

    trim() {
      const drop = Math.min(this.cursor - this.framesStart, this.frames.length);
      if (drop > 0) {
        this.frames.splice(0, drop);
        this.framesStart += drop;
      }
      const sampleDrop = this.nextHopAt - this.bufStart;
      if (sampleDrop > 0) {
        this.buf = this.buf.slice(sampleDrop);
        this.bufStart = this.nextHopAt;
      }
    }
  }

  // Collects frames from any decoder and reassembles multi-frame messages.
  // onProgress({ key, got, total }) while assembling; onMessage({ key, text } or { key, file }) when a message completes.
  class Receiver {
    constructor({ onMessage, onProgress, onError }) {
      this.partial = new Map();
      this.onMessage = onMessage;
      this.onProgress = onProgress || (() => {});
      this.onError = onError || (() => {});
    }

    push(frame) {
      if (!frame.multi) return this.finish(`s:${frame.type}:${frame.nibbles.join("")}`, frame.type, frame.nibbles);
      const key = `m:${frame.type}:${frame.id}:${frame.total}`;
      let p = this.partial.get(key);
      if (!p) this.partial.set(key, (p = { chunks: new Map(), total: frame.total, done: false }));
      if (p.done || p.chunks.has(frame.idx) || frame.idx >= frame.total) return;
      p.chunks.set(frame.idx, frame.nibbles);
      this.onProgress({ key, got: p.chunks.size, total: p.total });
      if (p.chunks.size < p.total) return;
      p.done = true;
      const nibbles = Array.from({ length: p.total }, (_, i) => p.chunks.get(i)).flat();
      if ((crc16(nibbles) & 0xfff) !== frame.id) {
        this.partial.delete(key);
        return this.onError(new Error("Reassembled message failed its checksum; listening for a resend"));
      }
      this.finish(key, frame.type, nibbles);
    }

    finish(key, type, nibbles) {
      unpackMessage(type, nibbles).then(
        (m) => this.onMessage({ key, ...m }),
        (e) => {
          this.partial.delete(key); // start over so the next pass can rebuild it
          this.onError(e);
        },
      );
    }
  }

  const api = { MODES, tonesOf, crc16, crc32, packMessage, unpackMessage, encode, duration, synthesize, Decoder, Receiver };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Modem = api;
})(typeof self !== "undefined" ? self : this);
