/**
 * Browser audio sink — bridges the APU's 44.1kHz sample stream to Web Audio.
 *
 * Browsers block autoplay, so the AudioContext must be created/resumed inside a user gesture.
 * Call `ensureStarted()` from a click/keydown handler. After that, feed samples every frame via
 * `push(left, right)`; if the AudioContext runs at a different rate (commonly 48000), we linearly
 * resample from the APU's native 44100 on the way in.
 */

const APU_RATE = 44100;

export class AudioSink {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private started = false;
  private _muted = false;
  private resampleFrac = 0;

  get isStarted(): boolean { return this.started; }
  get muted(): boolean { return this._muted; }

  /** Create + resume the AudioContext and load the worklet. Safe to call repeatedly. */
  async ensureStarted(): Promise<void> {
    if (this.started) { await this.ctx?.resume(); return; }
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    await ctx.audioWorklet.addModule("/web/audio-worklet.js");
    const node = new AudioWorkletNode(ctx, "gb-audio", { outputChannelCount: [2] });
    const gain = ctx.createGain();
    gain.gain.value = this._muted ? 0 : 0.9;
    node.connect(gain).connect(ctx.destination);
    await ctx.resume();
    this.ctx = ctx; this.node = node; this.gain = gain; this.started = true;
    console.log("[gb] audio started @", ctx.sampleRate, "Hz (apu", APU_RATE + ")");
  }

  setMuted(m: boolean): void {
    this._muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : 0.9;
  }
  toggleMute(): boolean { this.setMuted(!this._muted); return this._muted; }

  /** Feed one frame's worth of APU samples (native 44100). Resamples to ctx rate if needed. */
  push(left: Float32Array, right: Float32Array): void {
    if (!this.started || !this.node || this._muted) return;
    const ctxRate = this.ctx!.sampleRate;
    if (ctxRate === APU_RATE) {
      this.node.port.postMessage({ left, right });
      return;
    }
    // Linear resample 44100 -> ctxRate.
    const ratio = APU_RATE / ctxRate;
    const outN = Math.floor((left.length - this.resampleFrac) / ratio);
    const rl = new Float32Array(outN);
    const rr = new Float32Array(outN);
    let pos = this.resampleFrac;
    for (let i = 0; i < outN; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const l0 = left[idx] ?? 0, l1 = left[idx + 1] ?? l0;
      const r0 = right[idx] ?? 0, r1 = right[idx + 1] ?? r0;
      rl[i] = l0 + (l1 - l0) * frac;
      rr[i] = r0 + (r1 - r0) * frac;
      pos += ratio;
    }
    this.resampleFrac = pos - left.length; // carry fractional remainder to next chunk
    this.node.port.postMessage({ left: rl, right: rr });
  }
}
