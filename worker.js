// Runs every mode's decoder off the main thread. In: { sampleRate } once, then Float32Array chunks. Out: frames, plus { debug } events.
importScripts("modem.js");

let decoders = null;
self.onmessage = ({ data }) => {
  if (data.sampleRate) {
    // Debug events (every preamble the decoder locked onto, decoded or not) let the UI show "hearing it, but damaged".
    decoders = Object.keys(Modem.MODES).map(
      (m) =>
        new Modem.Decoder(
          data.sampleRate,
          m,
          (frame) => self.postMessage(frame),
          ({ ok, score }) => self.postMessage({ debug: true, ok, score, mode: m }),
        ),
    );
    return;
  }
  for (const d of decoders) d.push(data);
};
