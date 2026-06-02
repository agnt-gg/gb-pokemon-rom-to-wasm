/**
 * gb-recomp audio worklet.
 *
 * Runs on the audio render thread. Holds a stereo ring buffer that the main thread fills
 * with emulator samples (posted via port.postMessage as {left,right} Float32Arrays). The
 * worklet pulls from the ring at the hardware sample rate, producing glitch-free playback
 * decoupled from requestAnimationFrame jitter.
 */
class GBAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const CAP = 1 << 16; // 65536 samples (~1.5s @44.1k) power-of-two ring
    this.cap = CAP;
    this.mask = CAP - 1;
    this.left = new Float32Array(CAP);
    this.right = new Float32Array(CAP);
    this.writePos = 0;
    this.readPos = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.port.onmessage = (e) => {
      const { left, right } = e.data;
      const n = left.length;
      for (let i = 0; i < n; i++) {
        // overwrite-oldest if we ever overrun (keeps latency bounded)
        this.left[this.writePos & this.mask] = left[i];
        this.right[this.writePos & this.mask] = right[i];
        this.writePos++;
      }
    };
  }

  available() {
    return this.writePos - this.readPos;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const frames = outL.length;
    const avail = this.available();

    // If we have nothing buffered, output the last sample (DC hold) to avoid clicks.
    for (let i = 0; i < frames; i++) {
      if (this.readPos < this.writePos) {
        this.lastL = this.left[this.readPos & this.mask];
        this.lastR = this.right[this.readPos & this.mask];
        this.readPos++;
      }
      // else: underrun — repeat lastL/lastR (soft hold)
      outL[i] = this.lastL;
      outR[i] = this.lastR;
    }

    // Drop samples if we're way behind (latency spiraling) — keep ~200ms max.
    const maxLag = sampleRate * 0.2;
    if (this.available() > maxLag) {
      this.readPos = this.writePos - Math.floor(maxLag);
    }
    return true;
  }
}

registerProcessor("gb-audio", GBAudioProcessor);
