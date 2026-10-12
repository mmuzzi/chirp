# Chirp

Send short text between devices over sound: open the page on both, type on one and press Play, press Listen on the other.

- 17-tone differential MFSK (4 bits/tone), CRC-16 per frame, soft-decision repair of up to 2 weak tones.
- Lowercase hex (gist IDs) packed as nibbles; other text deflate-compressed when that helps.
- Long messages are split into chunks; Loop resends and the receiver fills in missing chunks.
- Modes: Turbo (4 parallel channels, ~400 bit/s raw), Fast (100), Normal (67), Robust (40). The receiver runs all of them at once.

Mic access needs HTTPS (or localhost). Run `node test.js` for the offline channel simulation.
