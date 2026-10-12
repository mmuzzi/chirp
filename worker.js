// Runs every mode's decoder off the main thread. In: { sampleRate } once, then Float32Array chunks. Out: frames.
importScripts("modem.js");

let decoders = null;
self.onmessage = ({ data }) => {
  if (data.sampleRate) {
    decoders = Object.keys(Modem.MODES).map((m) => new Modem.Decoder(data.sampleRate, m, (frame) => self.postMessage(frame)));
    return;
  }
  for (const d of decoders) d.push(data);
};
