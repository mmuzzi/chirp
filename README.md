# Chirp

Send short text or small files between devices over sound: open the page on both, type (or pick a file) on one and press Play, press Listen on the other.

- 17-tone differential MFSK (4 bits/tone), CRC-16 per frame, soft-decision repair of up to 2 weak tones.
- Lowercase hex (gist IDs) packed as nibbles; other text deflate-compressed when that helps.
- Long messages and files are split into chunks (up to 4095); Loop resends and the receiver fills in missing chunks. Files carry their name and a CRC-32.
- Anything over 3 minutes per pass asks for confirmation (~7 KB on Turbo, ~2 KB on Fast for incompressible data).
- Modes: Turbo (4 parallel channels, ~400 bit/s raw), Fast (100), Normal (67), Robust (40). The receiver runs all of them at once.

Mic access needs HTTPS (or localhost). Run `node test.js` for the offline channel simulation.
