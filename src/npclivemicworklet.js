class NpcLiveMicProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.frame = new Float32Array(Math.round(sampleRate * 0.02)); this.offset = 0; }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) for (const sample of samples) {
      this.frame[this.offset++] = sample;
      if (this.offset === this.frame.length) {
        this.port.postMessage({ samples: this.frame, sampleRate });
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('npc-live-mic', NpcLiveMicProcessor);
