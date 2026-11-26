import {pcm16} from './core.mjs';
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(Math.round(sampleRate / 10));
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i=0;i<channels[0].length;i++) {
      let v=0;
      for (const c of channels) v += c[i] || 0;
      this.frame[this.offset++] = v/channels.length;
      if (this.offset === this.frame.length) {
        let square = 0;
        for (const x of this.frame) square += x*x;
        const buffer = pcm16(this.frame);
        this.port.postMessage({buffer, rms: Math.sqrt(square/this.frame.length)}, [buffer]);
        this.offset=0;
      }
    }
    return true; // The output stays silent; never feed meeting sound back into the call.
  }
}
registerProcessor('pcm-processor', PCMProcessor);
