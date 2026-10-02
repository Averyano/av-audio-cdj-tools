// Listen: runs on the audio thread. Mixes the input to mono and hands the page ~85 ms chunks
// (4096 frames), transferred, not copied. Loaded by listen.js via audioWorklet.addModule.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels?.length) {
      for (let i = 0; i < channels[0].length; i++) {
        let v = 0;
        for (const c of channels) v += c[i];
        this.buf[this.n++] = v / channels.length;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', Capture);
