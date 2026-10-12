# Chirp

Send short text or small files between devices over sound: open the page on both, type (or pick a file) on one and press Play, press Listen on the other.

- 17-tone differential MFSK (4 bits/tone), CRC-16 per frame, soft-decision repair of up to 2 weak tones.
- Lowercase hex (gist IDs) packed as nibbles; other text deflate-compressed when that helps.
- Long messages and files are split into chunks (up to 65535); Loop resends and the receiver fills in missing chunks. Files carry their name and a CRC-32.
- Anything over 3 minutes per pass asks for confirmation (~7 KB on Turbo, ~2 KB on Fast for incompressible data).
- Modes: Turbo (4 parallel channels, ~400 bit/s raw), Fast (100), Normal (67), Robust (40). The receiver runs all of them at once.

Mic access needs HTTPS (or localhost). Run `node test.js` for the offline channel simulation.

## Camera mode (`camera.html`)

Screen-to-camera file transfer aimed at the realistic ceiling for a 120 Hz laptop and a phone camera in a browser:
a custom black/white cell grid (not QR) with 9 markers + 14 alignment dots, Reed-Solomon (255,223) per row-band
packet so half-blended frames still yield their clean rows, and RaptorQ (vendored wasm, MIT) as the fountain code.
The receiver samples cells on the GPU (WebGL) and fits a homography + cubic lens correction.

| Preset | Cells | Raw rate @ 60 screens/s | Simulated (720p / 1080p camera) |
|---|---|---|---|
| Safe | 256×144 | 1.5 Mbps | — |
| Fast | 320×180 | 2.5 Mbps | 2.5 / — |
| Max | 384×216 | 3.8 Mbps | 3.45 / 3.7 |
| Ultra | 480×270 | 6.0 Mbps | — / 5.9 |

`node sim/optical-sim.mjs <preset> <camHeight> <fileKB> [--harsh 1] [--y4m out.y4m]` runs the physical channel model
(display scan-out, LCD response, rolling shutter, exposure, blur, distortion, shake, noise) through the real decoder.
