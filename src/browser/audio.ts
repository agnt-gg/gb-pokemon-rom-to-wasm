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
  // Output time-scale for the generated sample stream. 1.0 = normal. 0.5 = stretch
  // samples to half-speed (useful when gameplay is boosted but music should not race).

  playbackSpeed = 1.0;

  get isStarted(): boolean { return this.started; }
  get muted(): boolean { return this._muted; }

  setPlaybackSpeed(v: number): void {
    this.playbackSpeed = [0.5, 0.75, 1].includes(v) ? v : 1;
  }

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

  /** Feed one frame's worth of APU samples (native 44100), with optional output time-scaling. */
  push(left: Float32Array, right: Float32Array): void {
    if (!this.started || !this.node || this._muted || !left.length) return;
    const ctxRate = this.ctx!.sampleRate;

    // Output time-scaling happens here, at the final WebAudio stream. This is different from
    // scaling APU cycles: the game's sound driver can still write registers at boosted gameplay
    // speed, but AUDIO 0.5x / 0.75x stretches the emitted stream so the user can tune perceived
    // music/SFX tempo independently.
    const effectiveInRate = APU_RATE * this.playbackSpeed;
    const ratio = effectiveInRate / ctxRate; // input samples consumed per output sample
    const outN = Math.max(1, Math.floor((left.length - this.resampleFrac) / ratio));
    const rl = new Float32Array(outN);
    const rr = new Float32Array(outN);
    let pos = this.resampleFrac;
    for (let i = 0; i < outN; i++) {
      const idx = Math.max(0, Math.min(left.length - 1, Math.floor(pos)));
      const frac = pos - idx;
      const idx2 = Math.min(idx + 1, left.length - 1);
      const l0 = left[idx] ?? 0, l1 = left[idx2] ?? l0;
      const r0 = right[idx] ?? 0, r1 = right[idx2] ?? r0;
      rl[i] = l0 + (l1 - l0) * frac;
      rr[i] = r0 + (r1 - r0) * frac;
      pos += ratio;
    }
    this.resampleFrac = Math.max(0, pos - left.length);
    this.node.port.postMessage({ left: rl, right: rr });
  }
}
