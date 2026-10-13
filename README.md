# Chirp

Send short text or small files between devices over sound: open the page on both, type (or pick a file) on one and press Play, press Listen on the other.

- 17-tone differential MFSK (4 bits/tone), CRC-16 per frame, soft-decision repair of up to 2 weak tones.
- Lowercase hex (gist IDs) packed as nibbles; other text deflate-compressed when that helps.
- Long messages and files are split into chunks (up to 65535); Loop resends and the receiver fills in missing chunks. Files carry their name and a CRC-32.
- Anything over 3 minutes per pass asks for confirmation (~7 KB on Turbo, ~2 KB on Fast for incompressible data).
- Modes: Turbo (4 parallel channels, ~400 bit/s raw), Fast (100), Normal (67), Robust (40). The receiver runs all of them at once.

Mic access needs HTTPS (or localhost). Run `node test.js` for the offline channel simulation.

## Camera mode (`camera/`)

Screen-to-camera file transfer, ported from Talaria: an animated stream of raw-byte QR codes (fast_qr wasm) carrying
RaptorQ fountain symbols, scanned with ZXing-C++ wasm in a Web Worker. Open `camera/#send` on the screen with the file
and `camera/#scan` on the phone. The receiver shows progress, live rate and ETA, and verifies every checksum before Save.

- **Fast · dual lane** (default): two V40-L codes side by side, 120 symbols/s on screen (2.8 Mbps); a phone camera at
  30–60 fps catches ~1.1–2 Mbps. Pick "Fast dual" on the receiver.
- **Fallback · single lane**: one V30-L code at 30 fps (0.4 Mbps), more forgiving.

Source lives in `camera-src/` (React + TypeScript, Vite); `camera/` is the committed build for GitHub Pages:

```bash
cd camera-src && npm install && npm run build   # typecheck + build into ../camera
```
