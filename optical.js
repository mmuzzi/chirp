// Chirp Camera: high-density screen-to-camera file transfer.
//
// Screen: a W×H grid of black/white cells (16:9) inside a white quiet zone, with nine solid black markers
// (3×3 grid; the top-left one has a white hole for orientation). Every other cell is data.
// Data cells, read row-major and XOR-whitened, carry consecutive Reed-Solomon (255,223) codewords. Each codeword
// is one self-contained packet (header + RaptorQ symbol + CRC-16), so a frame that is half blended (rolling shutter,
// screen refresh) still yields every codeword in its clean rows. Codeword 0 of each screen is file metadata.
// RaptorQ (vendored wasm) makes the packet stream a fountain: any ~k distinct packets rebuild the file.
(function (root) {
  // ---------- Presets ----------
  const PRESETS = {
    safe: { label: "Safe · 256×144", W: 256, H: 144 },
    fast: { label: "Fast · 320×180", W: 320, H: 180 },
    max: { label: "Max · 384×216", W: 384, H: 216 },
    ultra: { label: "Ultra · 480×270 (1080p camera)", W: 480, H: 270 },
  };
  const RS_N = 255, RS_K = 223, RS_PARITY = RS_N - RS_K;
  const CW_BITS = RS_N * 8;
  const RQ_PACKET = 216; // RaptorQ serialized packet: 4-byte payload id + 212-byte symbol
  const T_META = 0x11, T_DATA = 0x21;

  // ---------- GF(256) and Reed-Solomon (after wikiversity "Reed–Solomon codes for coders") ----------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
  const pow = (x, p) => EXP[(((LOG[x] * p) % 255) + 255) % 255];
  const inv = (x) => EXP[255 - LOG[x]];
  const polyScale = (p, x) => p.map((c) => mul(c, x));
  function polyAdd(p, q) {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }
  function polyMul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
    return r;
  }
  function polyEval(p, x) {
    let y = p[0];
    for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
    return y;
  }
  let GEN = [1];
  for (let i = 0; i < RS_PARITY; i++) GEN = polyMul(GEN, [1, pow(2, i)]);

  function rsEncode(msg) {
    // msg: Uint8Array(RS_K) -> Uint8Array(RS_N)
    const out = new Uint8Array(RS_N);
    out.set(msg);
    for (let i = 0; i < RS_K; i++) {
      const c = out[i];
      if (!c) continue;
      const lc = LOG[c];
      for (let j = 1; j < GEN.length; j++) if (GEN[j]) out[i + j] ^= EXP[LOG[GEN[j]] + lc];
    }
    out.set(msg);
    return out;
  }

  function syndromes(cw) {
    const s = new Array(RS_PARITY + 1).fill(0);
    let any = 0;
    for (let i = 0; i < RS_PARITY; i++) {
      const lx = i; // log of alpha^i
      let y = cw[0];
      for (let k = 1; k < cw.length; k++) y = (y ? EXP[LOG[y] + lx] : 0) ^ cw[k];
      s[i + 1] = y;
      any |= y;
    }
    return any ? s : null;
  }

  // Corrects in place. Returns number of corrected bytes, or -1 if uncorrectable.
  function rsDecode(cw) {
    const synd = syndromes(cw);
    if (!synd) return 0;
    // Berlekamp-Massey
    let errLoc = [1], oldLoc = [1];
    for (let i = 0; i < RS_PARITY; i++) {
      const K = i + 1;
      let delta = synd[K];
      for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
      oldLoc = oldLoc.concat([0]);
      if (delta) {
        if (oldLoc.length > errLoc.length) {
          const newLoc = polyScale(oldLoc, delta);
          oldLoc = polyScale(errLoc, inv(delta));
          errLoc = newLoc;
        }
        errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    const errs = errLoc.length - 1;
    if (errs * 2 > RS_PARITY) return -1;
    // Chien search
    const rev = errLoc.slice().reverse();
    const pos = [];
    for (let i = 0; i < RS_N; i++) if (polyEval(rev, pow(2, i)) === 0) pos.push(RS_N - 1 - i);
    if (pos.length !== errs) return -1;
    // Forney
    const coefPos = pos.map((p) => RS_N - 1 - p);
    let eLoc = [1];
    for (const i of coefPos) eLoc = polyMul(eLoc, polyAdd([1], [pow(2, i), 0]));
    const sr = synd.slice().reverse();
    const prod = polyMul(sr, eLoc);
    const divisorLen = eLoc.length; // [1] + zeros(nsym+1) with nsym = eLoc.length-1
    const rem = prod.slice(prod.length - (divisorLen));
    const errEval = rem.slice().reverse();
    const X = coefPos.map((c) => pow(2, -(255 - c)));
    for (let i = 0; i < X.length; i++) {
      const Xi = X[i], XiInv = inv(Xi);
      let prime = 1;
      for (let j = 0; j < X.length; j++) if (j !== i) prime = mul(prime, 1 ^ mul(XiInv, X[j]));
      if (!prime) return -1;
      const y = mul(Xi, polyEval(errEval.slice().reverse(), XiInv));
      cw[pos[i]] ^= div(y, prime);
    }
    return syndromes(cw) ? -1 : errs;
  }

  // ---------- Checksums ----------
  function crc16(bytes, start, end) {
    let crc = 0xffff;
    for (let i = start; i < end; i++) {
      crc ^= bytes[i] << 8;
      for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }
  const CRC32_TABLE = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- Layout ----------
  const layoutCache = new Map();
  function layout(key) {
    if (layoutCache.has(key)) return layoutCache.get(key);
    const { W, H } = PRESETS[key];
    const m = Math.round(H * 0.075); // marker side, cells
    const ring = Math.max(2, Math.round(m / 4));
    const quiet = ring + 2; // white border drawn around the grid on screen
    const hole = Math.max(2, Math.round(m * 0.4));
    const reserved = new Uint8Array(W * H);
    const cell = new Uint8Array(W * H); // fixed pattern: 1 = black (markers), 0 = white
    const xs = [0, Math.round((W - m) / 2), W - m];
    const ys = [0, Math.round((H - m) / 2), H - m];
    const markers = [];
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 3; i++) {
        const x0 = xs[i], y0 = ys[j];
        markers.push({ i, j, x0, y0, cx: x0 + m / 2, cy: y0 + m / 2 });
        for (let y = y0 - ring; y < y0 + m + ring; y++)
          for (let x = x0 - ring; x < x0 + m + ring; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            reserved[y * W + x] = 1;
            const inside = x >= x0 && x < x0 + m && y >= y0 && y < y0 + m;
            const h0 = (m - hole) / 2;
            const inHole = i === 0 && j === 0 && x >= x0 + Math.floor(h0) && x < x0 + Math.floor(h0) + hole && y >= y0 + Math.floor(h0) && y < y0 + Math.floor(h0) + hole;
            cell[y * W + x] = inside && !inHole ? 1 : 0;
          }
      }
    // Small alignment dots (a×a black, 1-cell white ring) between the markers, for the fine warp.
    const a = Math.max(3, Math.round(m / 4));
    const align = [];
    const fx = [1 / 8, 1 / 4, 3 / 8, 5 / 8, 3 / 4, 7 / 8];
    for (const [px, py] of [...fx.map((x) => [x, 1 / 4]), ...fx.map((x) => [x, 3 / 4]), [1 / 4, 1 / 2], [3 / 4, 1 / 2]]) {
      const x0 = Math.round(px * W - a / 2), y0 = Math.round(py * H - a / 2);
      align.push({ x0, y0, cx: x0 + a / 2, cy: y0 + a / 2 });
      for (let y = y0 - 1; y < y0 + a + 1; y++)
        for (let x = x0 - 1; x < x0 + a + 1; x++) {
          reserved[y * W + x] = 1;
          cell[y * W + x] = x >= x0 && x < x0 + a && y >= y0 && y < y0 + a ? 1 : 0;
        }
    }
    const data = [];
    for (let k = 0; k < W * H; k++) if (!reserved[k]) data.push(k);
    const dataCells = Int32Array.from(data);
    const whiten = new Uint8Array(dataCells.length);
    let s = 0x9e3779b9 >>> 0;
    for (let k = 0; k < whiten.length; k++) {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      whiten[k] = s & 1;
    }
    const codewords = Math.floor(dataCells.length / CW_BITS);
    const L = { key, W, H, m, ring, quiet, hole, a, align, markers, reserved, cell, dataCells, whiten, codewords };
    layoutCache.set(key, L);
    return L;
  }

  const bytesPerScreen = (key) => (layout(key).codewords - 1) * (RQ_PACKET - 4);

  // ---------- Packets (223-byte RS message) ----------
  function metaPacket(session, info) {
    const p = new Uint8Array(RS_K);
    const dv = new DataView(p.buffer);
    p[0] = T_META;
    dv.setUint16(1, session);
    dv.setUint32(3, info.transferLen);
    dv.setUint32(7, info.fileLen);
    p[11] = info.deflated ? 1 : 0;
    dv.setUint32(12, info.crc);
    let name = new TextEncoder().encode(info.name);
    if (name.length > 190) name = name.slice(0, 190);
    p[16] = name.length;
    p.set(name, 17);
    dv.setUint16(RS_K - 2, crc16(p, 0, RS_K - 2));
    return p;
  }
  function dataPacket(session, rq) {
    const p = new Uint8Array(RS_K);
    const dv = new DataView(p.buffer);
    p[0] = T_DATA;
    dv.setUint16(1, session);
    dv.setUint16(3, rq.length);
    p.set(rq, 5);
    dv.setUint16(RS_K - 2, crc16(p, 0, RS_K - 2));
    return p;
  }
  function parsePacket(p) {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (dv.getUint16(RS_K - 2) !== crc16(p, 0, RS_K - 2)) return null;
    const session = dv.getUint16(1);
    if (p[0] === T_META) {
      const nameLen = p[16];
      return {
        type: "meta", session,
        transferLen: dv.getUint32(3), fileLen: dv.getUint32(7), deflated: p[11] === 1, crc: dv.getUint32(12),
        name: new TextDecoder().decode(p.subarray(17, 17 + nameLen)),
      };
    }
    if (p[0] === T_DATA) {
      const len = dv.getUint16(3);
      if (len > RS_K - 7) return null;
      return { type: "data", session, rq: p.slice(5, 5 + len) };
    }
    return null;
  }

  // ---------- Sender ----------
  async function pipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  }

  // rq: { encode_packets } from the RaptorQ wasm module (already initialised).
  async function prepareSend(rq, { name, bytes }, { repairPercent = 100 } = {}) {
    let payload = bytes, deflated = false;
    if (bytes.length > 64) {
      const d = await pipe(bytes, new CompressionStream("deflate-raw"));
      if (d.length < bytes.length * 0.97) { payload = d; deflated = true; }
    }
    const packets = Array.from(rq.encode_packets(payload, RQ_PACKET, repairPercent), (p) => new Uint8Array(p));
    const session = (Math.random() * 65536) | 0;
    const meta = rsEncode(metaPacket(session, { transferLen: payload.length, fileLen: bytes.length, deflated, crc: crc32(bytes), name }));
    const cache = new Map();
    const codeword = (i) => {
      let cw = cache.get(i);
      if (!cw) {
        cw = rsEncode(dataPacket(session, packets[i]));
        if (cache.size > 20000) cache.clear();
        cache.set(i, cw);
      }
      return cw;
    };
    return { session, packets: packets.length, sourcePackets: Math.ceil(payload.length / (RQ_PACKET - 4)), transferLen: payload.length, deflated, meta, codeword };
  }

  // Screen n as a Uint8Array of W*H cells (1 = black).
  function renderScreen(prep, key, n, out) {
    const L = layout(key);
    const cells = out || new Uint8Array(L.W * L.H);
    cells.set(L.cell);
    const perScreen = L.codewords - 1;
    const { dataCells, whiten } = L;
    let bit = 0;
    for (let c = 0; c < L.codewords; c++) {
      const cw = c === 0 ? prep.meta : prep.codeword((n * perScreen + c - 1) % prep.packets);
      for (let b = 0; b < RS_N; b++) {
        const v = cw[b];
        for (let k = 7; k >= 0; k--, bit++) cells[dataCells[bit]] = ((v >> k) & 1) ^ whiten[bit];
      }
    }
    for (; bit < dataCells.length; bit++) cells[dataCells[bit]] = whiten[bit];
    return cells;
  }

  // ---------- Geometry ----------
  function solve(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]];
      [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    return b.map((v, i) => v / A[i][i]);
  }
  function normalizer(pts) {
    let mx = 0, my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    mx /= pts.length; my /= pts.length;
    let d = 0;
    for (const [x, y] of pts) d += Math.hypot(x - mx, y - my);
    const s = Math.SQRT2 / (d / pts.length || 1);
    return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
  }
  const m3mul = (a, b) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
  function m3inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  }
  const apply = (Hm, x, y) => {
    const w = Hm[6] * x + Hm[7] * y + Hm[8];
    return [(Hm[0] * x + Hm[1] * y + Hm[2]) / w, (Hm[3] * x + Hm[4] * y + Hm[5]) / w];
  };
  // Least-squares homography src -> dst (>= 4 point pairs).
  function fitHomography(src, dst) {
    const Ts = normalizer(src), Td = normalizer(dst);
    const A = Array.from({ length: 8 }, () => new Array(8).fill(0)), b = new Array(8).fill(0);
    for (let k = 0; k < src.length; k++) {
      const [x, y] = apply(Ts, ...src[k]), [X, Y] = apply(Td, ...dst[k]);
      for (const [row, rhs] of [[[x, y, 1, 0, 0, 0, -X * x, -X * y], X], [[0, 0, 0, x, y, 1, -Y * x, -Y * y], Y]])
        for (let i = 0; i < 8; i++) {
          b[i] += row[i] * rhs;
          for (let j = 0; j < 8; j++) A[i][j] += row[i] * row[j];
        }
    }
    const h = solve(A, b);
    if (!h) return null;
    return m3mul(m3inv(Td), m3mul([...h, 1], Ts));
  }
  // Warp = homography + polynomial residual correction (cubic with >= 16 points, quadratic with >= 8),
  // in cell coords -> camera px. q holds 10 coefficients per axis (unused ones are 0).
  const NQ = 10;
  const basis = (u, v, W, H) => {
    const a = u / W - 0.5, b = v / H - 0.5;
    return [1, a, b, a * a, a * b, b * b, a * a * a, a * a * b, a * b * b, b * b * b];
  };
  function fitWarp(src, dst, W, H) {
    const Hm = fitHomography(src, dst);
    if (!Hm) return null;
    const q = new Array(2 * NQ).fill(0);
    const n = src.length >= 16 ? 10 : src.length >= 8 ? 6 : 0;
    for (const axis of [0, 1]) {
      if (!n) break;
      const A = Array.from({ length: n }, () => new Array(n).fill(0)), rhs = new Array(n).fill(0);
      src.forEach((s, k) => {
        const r = dst[k][axis] - apply(Hm, ...s)[axis], f = basis(s[0], s[1], W, H);
        for (let i = 0; i < n; i++) { rhs[i] += f[i] * r; for (let j = 0; j < n; j++) A[i][j] += f[i] * f[j]; }
      });
      for (let i = 0; i < n; i++) A[i][i] += 1e-6;
      const c = solve(A, rhs);
      if (c) for (let i = 0; i < n; i++) q[axis * NQ + i] = c[i];
    }
    return { H: Hm, q, W, H_: H };
  }
  function warpPoint(w, u, v) {
    const [x, y] = apply(w.H, u, v);
    const f = basis(u, v, w.W, w.H_);
    let dx = 0, dy = 0;
    for (let i = 0; i < NQ; i++) { dx += w.q[i] * f[i]; dy += w.q[NQ + i] * f[i]; }
    return [x + dx, y + dy];
  }

  // ---------- Marker detection on a downscaled luminance image ----------
  function findBlobs(img) {
    const { w, h, data } = img;
    const ii = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += data[y * w + x];
        ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
      }
    }
    const box = (x0, y0, x1, y1) => {
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
      const n = (x1 - x0) * (y1 - y0);
      if (n <= 0) return 0;
      return (ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0]) / n;
    };
    const R = Math.max(6, Math.round(Math.min(w, h) / 14));
    const dark = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) dark[y * w + x] = data[y * w + x] < box(x - R, y - R, x + R + 1, y + R + 1) * 0.72 ? 1 : 0;
    const label = new Int32Array(w * h);
    const blobs = [];
    const stack = new Int32Array(w * h);
    const maxArea = (Math.min(w, h) / 3) ** 2;
    for (let start = 0; start < w * h; start++) {
      if (!dark[start] || label[start]) continue;
      let sp = 0, area = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, border = false;
      stack[sp++] = start;
      label[start] = blobs.length + 1;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        area++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
        for (const q of [p - 1, p + 1, p - w, p + w]) {
          if (q < 0 || q >= w * h || label[q] || !dark[q]) continue;
          if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
          label[q] = blobs.length + 1;
          stack[sp++] = q;
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const blob = { area, cx: sx / area + 0.5, cy: sy / area + 0.5, x0, y0, bw, bh };
      blobs.push(blob);
      if (border || area < 12 || area > maxArea || bw < 3 || bh < 3) continue;
      const aspect = bw / bh;
      if (aspect < 0.45 || aspect > 2.2 || area / (bw * bh) < 0.5) continue;
      const inner = box(x0, y0, x1 + 1, y1 + 1);
      const ex = Math.max(2, Math.round(bw * 0.35)), ey = Math.max(2, Math.round(bh * 0.35));
      const outerSum = box(x0 - ex, y0 - ey, x1 + 1 + ex, y1 + 1 + ey) * (bw + 2 * ex) * (bh + 2 * ey) - inner * bw * bh;
      const ringMean = outerSum / ((bw + 2 * ex) * (bh + 2 * ey) - bw * bh);
      if (ringMean - inner < 40) continue;
      blob.size = Math.sqrt(area);
      blob.candidate = true;
    }
    return blobs.filter((b) => b.candidate);
  }

  // Assign candidates to the 9 markers of layout L. Returns [{marker, x, y, size}] in image coords, or null.
  // Candidates include alignment dots and data speckles, so try each size cluster and keep the best 3×3 fit.
  function matchMarkers(cands, L) {
    if (cands.length < 4) return null;
    const byIJ = (i, j) => L.markers.find((m) => m.i === i && m.j === j);
    const refs = [...new Set(cands.map((c) => Math.round(c.size * 4) / 4))].sort((a, b) => b - a);
    let best = null;
    for (const ref of refs) {
      const pool = cands.filter((c) => c.size > ref * 0.7 && c.size < ref * 1.45);
      if (pool.length < 6) continue;
      const pick = (f) => pool.reduce((a, b) => (f(b) > f(a) ? b : a));
      const tl = pick((c) => -(c.cx + c.cy)), br = pick((c) => c.cx + c.cy);
      const tr = pick((c) => c.cx - c.cy), bl = pick((c) => c.cy - c.cx);
      if (new Set([tl, br, tr, bl]).size < 4) continue;
      const corners = [[byIJ(0, 0), tl], [byIJ(2, 0), tr], [byIJ(2, 2), br], [byIJ(0, 2), bl]];
      const Hm = fitHomography(corners.map(([m]) => [m.cx, m.cy]), corners.map(([, c]) => [c.cx, c.cy]));
      if (!Hm) continue;
      const out = corners.map(([marker, c]) => ({ marker, x: c.cx, y: c.cy, size: c.size }));
      let err = 0;
      for (const marker of L.markers) {
        if (out.some((o) => o.marker === marker)) continue;
        const [px, py] = apply(Hm, marker.cx, marker.cy);
        let hit = null, bd = ref * 0.6;
        for (const c of pool) {
          const d = Math.hypot(c.cx - px, c.cy - py);
          if (d < bd) { bd = d; hit = c; }
        }
        if (hit) { out.push({ marker, x: hit.cx, y: hit.cy, size: hit.size }); err += bd; }
      }
      if (out.length >= 6 && (!best || out.length > best.length || (out.length === best.length && err < best.err))) {
        best = out;
        best.err = err;
        if (out.length === 9) break;
      }
    }
    return best;
  }

  // Sub-pixel marker centre from a full-resolution luminance patch.
  function refineCenter(patch, pw, ph) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < patch.length; i++) hist[patch[i]]++;
    const q = (f) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= f * patch.length) return v; } return 255; };
    const lo = q(0.05), hi = q(0.95);
    if (hi - lo < 40) return null;
    const thr = (lo + hi) / 2;
    let sw = 0, sx = 0, sy = 0;
    for (let y = 0; y < ph; y++)
      for (let x = 0; x < pw; x++) {
        const wgt = Math.max(0, thr - patch[y * pw + x]);
        sw += wgt; sx += wgt * (x + 0.5); sy += wgt * (y + 0.5);
      }
    if (!sw) return null;
    const cx = sx / sw, cy = sy / sw;
    // Hole check: centre region brighter than threshold.
    const r = Math.max(1, Math.round(Math.min(pw, ph) * 0.07));
    let s = 0, n = 0;
    for (let y = Math.round(cy) - r; y <= Math.round(cy) + r; y++)
      for (let x = Math.round(cx) - r; x <= Math.round(cx) + r; x++)
        if (x >= 0 && y >= 0 && x < pw && y < ph) { s += patch[y * pw + x]; n++; }
    return { x: cx, y: cy, hole: n > 0 && s / n > thr };
  }

  // Full locate: low-res candidates + patch refinement -> warp (cell coords -> full-res px), or a reason string.
  // getPatch(x0, y0, w, h) returns a Uint8Array luminance patch from the full-res image.
  function locate(low, scale, getPatch, L, cands = findBlobs(low)) {
    const matched = matchMarkers(cands, L);
    if (!matched) return { reason: `markers: ${cands.length} candidates` };
    const pts = [];
    let holeAt = null;
    for (const mk of matched) {
      const s = mk.size * scale * (1 + (2 * L.ring) / L.m) * 1.05;
      const x0 = Math.round(mk.x * scale - s / 2), y0 = Math.round(mk.y * scale - s / 2), side = Math.max(8, Math.round(s));
      const patch = getPatch(x0, y0, side, side);
      if (!patch) continue;
      const r = refineCenter(patch, side, side);
      if (!r) continue;
      pts.push({ marker: mk.marker, x: x0 + r.x, y: y0 + r.y });
      if (r.hole && mk.marker.i !== 1 && mk.marker.j !== 1) holeAt = mk.marker;
    }
    if (pts.length < 6) return { reason: "refine failed" };
    if (holeAt && !(holeAt.i === 0 && holeAt.j === 0)) {
      if (holeAt.i === 2 && holeAt.j === 2) {
        // Upside down: rotate the marker assignment by 180°.
        for (const p of pts) p.marker = L.markers.find((m) => m.i === 2 - p.marker.i && m.j === 2 - p.marker.j);
      } else return { reason: "hold the phone in landscape" };
    }
    let warp = fitWarp(pts.map((p) => [p.marker.cx, p.marker.cy]), pts.map((p) => [p.x, p.y]), L.W, L.H);
    if (!warp) return { reason: "warp failed" };
    // Fine stage: find each alignment dot near its predicted spot (twice, re-centring), then refit.
    const src = pts.map((p) => [p.marker.cx, p.marker.cy]), dst = pts.map((p) => [p.x, p.y]);
    const [qx0, qy0] = warpPoint(warp, 0, 0), [qx1, qy1] = warpPoint(warp, L.W, 0);
    const cellPx = Math.hypot(qx1 - qx0, qy1 - qy0) / L.W;
    const side = Math.max(5, Math.round((L.a + 2) * cellPx));
    for (const al of L.align) {
      let [x, y] = warpPoint(warp, al.cx, al.cy), found = null;
      for (let it = 0; it < 2; it++) {
        const x0 = Math.round(x - side / 2), y0 = Math.round(y - side / 2);
        const patch = getPatch(x0, y0, side, side);
        const r = patch && refineCenter(patch, side, side);
        if (!r) { found = null; break; }
        x = x0 + r.x; y = y0 + r.y; found = [x, y];
      }
      if (found) { src.push([al.cx, al.cy]); dst.push(found); }
    }
    if (src.length > pts.length + 4) warp = fitWarp(src, dst, L.W, L.H) || warp;
    pts.alignFound = src.length - pts.length;
    let err = 0;
    for (const p of pts) { const [x, y] = warpPoint(warp, p.marker.cx, p.marker.cy); err = Math.max(err, Math.hypot(x - p.x, y - p.y)); }
    const [ax, ay] = warpPoint(warp, 0, 0), [bx, by] = warpPoint(warp, L.W, 0);
    warp.pxPerCell = Math.hypot(bx - ax, by - ay) / L.W;
    warp.residual = err;
    warp.points = pts;
    warp.alignFound = pts.alignFound;
    return { warp };
  }

  // ---------- Cell decode ----------
  // lum: Uint8Array(W*H) sampled cell centres. Returns { packets, ok, bad }.
  function decodeCells(L, lum) {
    const { W, H, reserved, dataCells, whiten } = L;
    // Local threshold = mean of data cells in a window (whitened data is balanced).
    const ii = new Float64Array((W + 1) * (H + 1)), cnt = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let r = 0, c = 0;
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        if (!reserved[k]) { r += lum[k]; c++; }
        ii[(y + 1) * (W + 1) + x + 1] = ii[y * (W + 1) + x + 1] + r;
        cnt[(y + 1) * (W + 1) + x + 1] = cnt[y * (W + 1) + x + 1] + c;
      }
    }
    const R = 7;
    const bits = new Uint8Array(dataCells.length);
    for (let b = 0; b < dataCells.length; b++) {
      const k = dataCells[b], x = k % W, y = (k / W) | 0;
      const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(W, x + R + 1), y1 = Math.min(H, y + R + 1);
      const s = ii[y1 * (W + 1) + x1] - ii[y0 * (W + 1) + x1] - ii[y1 * (W + 1) + x0] + ii[y0 * (W + 1) + x0];
      const n = cnt[y1 * (W + 1) + x1] - cnt[y0 * (W + 1) + x1] - cnt[y1 * (W + 1) + x0] + cnt[y0 * (W + 1) + x0];
      bits[b] = (lum[k] < s / n ? 1 : 0) ^ whiten[b];
    }
    const packets = [];
    let ok = 0, bad = 0, fixed = 0;
    const cw = new Uint8Array(RS_N);
    for (let c = 0; c < L.codewords; c++) {
      for (let i = 0; i < RS_N; i++) {
        let v = 0;
        const base = (c * RS_N + i) * 8;
        for (let k = 0; k < 8; k++) v = (v << 1) | bits[base + k];
        cw[i] = v;
      }
      const r = rsDecode(cw);
      if (r < 0) { bad++; continue; }
      const p = parsePacket(cw.slice(0, RS_K));
      if (!p) { bad++; continue; }
      ok++;
      fixed += r;
      packets.push(p);
    }
    return { packets, ok, bad, fixed };
  }

  // ---------- Reassembly ----------
  // rq: { RaptorQDecoder }. onDone({ name, bytes, session }) / onProgress({ unique, needed, name, fileLen }).
  class Assembler {
    constructor(rq, { onDone, onProgress, onError }) {
      Object.assign(this, { rq, onDone, onProgress: onProgress || (() => {}), onError: onError || (() => {}) });
      this.sessions = new Map();
    }
    push(p) {
      let s = this.sessions.get(p.session);
      if (!s) this.sessions.set(p.session, (s = { pending: [], seen: new Set(), meta: null, decoder: null, done: false, unique: 0, firstAt: Date.now() }));
      if (s.done) return;
      if (p.type === "meta") {
        if (s.meta) return;
        s.meta = p;
        s.decoder = new this.rq.RaptorQDecoder(p.transferLen, RQ_PACKET);
        s.needed = Math.ceil(p.transferLen / (RQ_PACKET - 4));
        const pend = s.pending;
        s.pending = [];
        for (const q of pend) this.pushData(s, q);
        return;
      }
      if (!s.meta) { if (s.pending.length < 100000) s.pending.push(p); return; }
      this.pushData(s, p);
    }
    pushData(s, p) {
      const id = (p.rq[0] << 24) | (p.rq[1] << 16) | (p.rq[2] << 8) | p.rq[3];
      if (s.seen.has(id)) return;
      s.seen.add(id);
      s.unique++;
      const out = s.decoder.push(p.rq);
      this.onProgress({ session: s.meta.session, unique: s.unique, needed: s.needed, name: s.meta.name, fileLen: s.meta.fileLen, startedAt: s.firstAt });
      if (out) this.finish(s, new Uint8Array(out));
    }
    async finish(s, payload) {
      s.done = true;
      try {
        s.decoder.free?.();
        const bytes = s.meta.deflated ? await pipe(payload, new DecompressionStream("deflate-raw")) : payload;
        if (bytes.length !== s.meta.fileLen || crc32(bytes) !== s.meta.crc) throw new Error("file checksum mismatch");
        this.onDone({ name: s.meta.name, bytes, session: s.meta.session, seconds: (Date.now() - s.firstAt) / 1000 });
      } catch (e) {
        this.sessions.delete(s.meta.session);
        this.onError(e);
      }
    }
  }

  const api = {
    NQ, PRESETS, RS_N, RS_K, RQ_PACKET, layout, bytesPerScreen, rsEncode, rsDecode, crc16, crc32,
    metaPacket, dataPacket, parsePacket, prepareSend, renderScreen,
    fitHomography, fitWarp, warpPoint, findBlobs, matchMarkers, refineCenter, locate, decodeCells, Assembler,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Optical = api;
})(typeof self !== "undefined" ? self : this);
