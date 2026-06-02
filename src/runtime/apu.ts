/**
 * APU — Game Boy (DMG) audio processing unit.
 *
 * Four channels:
 *   CH1  square wave with frequency sweep + length + volume envelope   (NR10-NR14, FF10-FF14)
 *   CH2  square wave with length + volume envelope                     (NR21-NR24, FF16-FF19)
 *   CH3  programmable 32-sample 4-bit wave from Wave RAM               (NR30-NR34, FF1A-FF1E + FF30-FF3F)
 *   CH4  noise (LFSR) with length + volume envelope                    (NR41-NR44, FF20-FF23)
 *   Master/control:                                                    (NR50-NR52, FF24-FF26)
 *
 * Design: the APU is driven by the same cycle stream as PPU/timer (`step(cycles)`), advancing
 * each channel's internal timers in t-cycles. A frame-sequencer running at 512 Hz clocks length,
 * envelope, and sweep. Audio is produced by `drain()` which returns interleaved stereo Float32
 * samples accumulated since the last call — the host pulls these into a Web Audio ring buffer.
 *
 * The whole thing is register-faithful but pragmatic: it reproduces the real channel logic
 * (duty patterns, envelope steps, LFSR width, sweep math, wave-RAM playback, L/R panning, master
 * volume) so Pokémon's music and SFX sound correct, without modeling sub-instruction DAC quirks.
 */

import type { MMU, IoHooks } from "./mmu.ts";

const CPU_HZ = 4194304;          // DMG t-cycles per second
const FRAME_SEQ_PERIOD = 8192;   // 512 Hz frame sequencer (CPU_HZ / 512)

const DUTY_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
  [1, 0, 0, 0, 0, 0, 0, 1], // 25%
  [1, 0, 0, 0, 0, 1, 1, 1], // 50%
  [0, 1, 1, 1, 1, 1, 1, 0], // 75%
];

// Noise divisor lookup (NR43 low 3 bits)
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];

export class APU {
  private mmu: MMU;

  // Output sample accumulation
  private sampleRate: number;
  private sampleCounter = 0;        // fractional t-cycle accumulator for resampling
  private cyclesPerSample: number;  // CPU_HZ / sampleRate
  private outL: number[] = [];
  private outR: number[] = [];
  private maxBuffered: number;

  // Frame sequencer
  private fsCounter = 0;
  private fsStep = 0;

  // ---- registers (raw) ----
  private reg = new Uint8Array(0x30); // FF10..FF3F mirror (0x10..0x3F)
  private waveRam = new Uint8Array(16);
  private enabled = false;

  // ---- CH1 (square + sweep) ----
  private c1On = false; private c1Freq = 0; private c1Timer = 0; private c1DutyPos = 0;
  private c1Len = 0; private c1Vol = 0; private c1EnvTimer = 0; private c1EnvPeriod = 0; private c1EnvUp = false;
  private c1SweepTimer = 0; private c1SweepPeriod = 0; private c1SweepShift = 0; private c1SweepDown = false; private c1SweepEnabled = false; private c1SweepShadow = 0;

  // ---- CH2 (square) ----
  private c2On = false; private c2Freq = 0; private c2Timer = 0; private c2DutyPos = 0;
  private c2Len = 0; private c2Vol = 0; private c2EnvTimer = 0; private c2EnvPeriod = 0; private c2EnvUp = false;

  // ---- CH3 (wave) ----
  private c3On = false; private c3Freq = 0; private c3Timer = 0; private c3Pos = 0; private c3Len = 0; private c3Sample = 0;

  // ---- CH4 (noise) ----
  private c4On = false; private c4Timer = 0; private c4Lfsr = 0x7fff; private c4Len = 0;
  private c4Vol = 0; private c4EnvTimer = 0; private c4EnvPeriod = 0; private c4EnvUp = false;

  constructor(mmu: MMU, sampleRate = 44100) {
    this.mmu = mmu;
    this.sampleRate = sampleRate;
    this.cyclesPerSample = CPU_HZ / sampleRate;
    this.maxBuffered = sampleRate; // 1s cap to avoid unbounded growth if host stops draining
  }

  /** Returns true if `addr` is an APU register (so the MMU routes it here). */
  static isAudioAddr(addr: number): boolean {
    return addr >= 0xff10 && addr <= 0xff3f;
  }

  // ---- IO hook surface (called by MMU) ----
  readReg(addr: number): number {
    // Wave RAM is directly readable
    if (addr >= 0xff30 && addr <= 0xff3f) return this.waveRam[addr - 0xff30]!;
    // NR52 (FF26): bit7 power, bits0-3 channel-active flags; unused bits read 1.
    if (addr === 0xff26) {
      let v = (this.enabled ? 0x80 : 0) | 0x70;
      v |= this.c1On ? 1 : 0; v |= this.c2On ? 2 : 0; v |= this.c3On ? 4 : 0; v |= this.c4On ? 8 : 0;
      return v;
    }
    // Most registers read back with some bits masked to 1 (matching hardware OR-masks).
    return this.reg[addr - 0xff10]! | READ_OR_MASK[addr - 0xff10]!;
  }

  writeReg(addr: number, value: number): void {
    if (addr >= 0xff30 && addr <= 0xff3f) { this.waveRam[addr - 0xff30] = value & 0xff; return; }

    if (addr === 0xff26) { // NR52 power control
      const on = (value & 0x80) !== 0;
      if (!on && this.enabled) { this.powerOff(); }
      this.enabled = on;
      this.reg[addr - 0xff10] = value & 0x80;
      return;
    }
    if (!this.enabled && addr !== 0xff26) {
      // When powered off, only NR52 (and on DMG, length writes) are accepted. Keep it simple:
      // ignore everything else while off.
      return;
    }

    this.reg[addr - 0xff10] = value & 0xff;

    switch (addr) {
      // ---- CH1 ----
      case 0xff10: { // NR10 sweep
        this.c1SweepPeriod = (value >> 4) & 7;
        this.c1SweepDown = (value & 0x08) !== 0;
        this.c1SweepShift = value & 7;
        break;
      }
      case 0xff11: this.c1Len = 64 - (value & 0x3f); break; // NR11 duty/length
      case 0xff12: { // NR12 envelope
        this.c1EnvUp = (value & 0x08) !== 0;
        this.c1EnvPeriod = value & 7;
        if ((value & 0xf8) === 0) this.c1On = false; // DAC off
        break;
      }
      case 0xff13: this.c1Freq = (this.c1Freq & 0x700) | (value & 0xff); break; // NR13 freq lo
      case 0xff14: { // NR14 freq hi + trigger
        this.c1Freq = (this.c1Freq & 0xff) | ((value & 7) << 8);
        if (value & 0x80) this.triggerCh1();
        break;
      }
      // ---- CH2 ----
      case 0xff16: this.c2Len = 64 - (value & 0x3f); break;
      case 0xff17: {
        this.c2EnvUp = (value & 0x08) !== 0;
        this.c2EnvPeriod = value & 7;
        if ((value & 0xf8) === 0) this.c2On = false;
        break;
      }
      case 0xff18: this.c2Freq = (this.c2Freq & 0x700) | (value & 0xff); break;
      case 0xff19: {
        this.c2Freq = (this.c2Freq & 0xff) | ((value & 7) << 8);
        if (value & 0x80) this.triggerCh2();
        break;
      }
      // ---- CH3 (wave) ----
      case 0xff1a: if ((value & 0x80) === 0) this.c3On = false; break; // DAC enable
      case 0xff1b: this.c3Len = 256 - (value & 0xff); break;
      case 0xff1d: this.c3Freq = (this.c3Freq & 0x700) | (value & 0xff); break;
      case 0xff1e: {
        this.c3Freq = (this.c3Freq & 0xff) | ((value & 7) << 8);
        if (value & 0x80) this.triggerCh3();
        break;
      }
      // ---- CH4 (noise) ----
      case 0xff20: this.c4Len = 64 - (value & 0x3f); break;
      case 0xff21: {
        this.c4EnvUp = (value & 0x08) !== 0;
        this.c4EnvPeriod = value & 7;
        if ((value & 0xf8) === 0) this.c4On = false;
        break;
      }
      // NR43 (FF22) read directly in noise timer; NR44 (FF23) trigger
      case 0xff23: if (value & 0x80) this.triggerCh4(); break;
    }
  }

  private powerOff(): void {
    this.c1On = this.c2On = this.c3On = this.c4On = false;
    for (let i = 0; i < 0x16; i++) this.reg[i] = 0; // clear FF10..FF25 (not wave RAM)
  }

  // ---- triggers (channel restart) ----
  private triggerCh1(): void {
    this.c1On = true;
    if (this.c1Len === 0) this.c1Len = 64;
    this.c1Timer = (2048 - this.c1Freq) * 4;
    this.c1EnvPeriod = this.reg[0x02]! & 7; this.c1EnvTimer = this.c1EnvPeriod;
    this.c1Vol = (this.reg[0x02]! >> 4) & 0xf;
    this.c1EnvUp = (this.reg[0x02]! & 0x08) !== 0;
    // sweep init
    this.c1SweepShadow = this.c1Freq;
    this.c1SweepPeriod = (this.reg[0x00]! >> 4) & 7;
    this.c1SweepShift = this.reg[0x00]! & 7;
    this.c1SweepDown = (this.reg[0x00]! & 0x08) !== 0;
    this.c1SweepTimer = this.c1SweepPeriod || 8;
    this.c1SweepEnabled = this.c1SweepPeriod > 0 || this.c1SweepShift > 0;
    if (this.c1SweepShift > 0) this.sweepCalc(); // initial overflow check
    if ((this.reg[0x02]! & 0xf8) === 0) this.c1On = false;
  }
  private triggerCh2(): void {
    this.c2On = true;
    if (this.c2Len === 0) this.c2Len = 64;
    this.c2Timer = (2048 - this.c2Freq) * 4;
    this.c2EnvPeriod = this.reg[0x07]! & 7; this.c2EnvTimer = this.c2EnvPeriod;
    this.c2Vol = (this.reg[0x07]! >> 4) & 0xf;
    this.c2EnvUp = (this.reg[0x07]! & 0x08) !== 0;
    if ((this.reg[0x07]! & 0xf8) === 0) this.c2On = false;
  }
  private triggerCh3(): void {
    this.c3On = (this.reg[0x0a]! & 0x80) !== 0;
    if (this.c3Len === 0) this.c3Len = 256;
    this.c3Timer = (2048 - this.c3Freq) * 2;
    this.c3Pos = 0;
  }
  private triggerCh4(): void {
    this.c4On = true;
    if (this.c4Len === 0) this.c4Len = 64;
    this.c4EnvPeriod = this.reg[0x11]! & 7; this.c4EnvTimer = this.c4EnvPeriod;
    this.c4Vol = (this.reg[0x11]! >> 4) & 0xf;
    this.c4EnvUp = (this.reg[0x11]! & 0x08) !== 0;
    this.c4Lfsr = 0x7fff;
    const nr43 = this.reg[0x12]!;
    this.c4Timer = (NOISE_DIVISORS[nr43 & 7]! << (nr43 >> 4)) || 8;
    if ((this.reg[0x11]! & 0xf8) === 0) this.c4On = false;
  }

  private sweepCalc(): number {
    let next = this.c1SweepShadow >> this.c1SweepShift;
    next = this.c1SweepDown ? this.c1SweepShadow - next : this.c1SweepShadow + next;
    if (next > 2047) this.c1On = false; // overflow disables channel
    return next;
  }

  // ---- main cycle step ----
  step(cycles: number): void {
    if (!this.enabled) {
      // still need to emit silence so audio clock stays aligned with wall time
      this.accumulateSilence(cycles);
      return;
    }
    for (let i = 0; i < cycles; i++) this.tickOne();
  }

  private accumulateSilence(cycles: number): void {
    this.sampleCounter += cycles;
    while (this.sampleCounter >= this.cyclesPerSample) {
      this.sampleCounter -= this.cyclesPerSample;
      this.pushSample(0, 0);
    }
  }

  private tickOne(): void {
    // CH1 timer
    if (--this.c1Timer <= 0) { this.c1Timer = (2048 - this.c1Freq) * 4; this.c1DutyPos = (this.c1DutyPos + 1) & 7; }
    // CH2 timer
    if (--this.c2Timer <= 0) { this.c2Timer = (2048 - this.c2Freq) * 4; this.c2DutyPos = (this.c2DutyPos + 1) & 7; }
    // CH3 timer
    if (--this.c3Timer <= 0) {
      this.c3Timer = (2048 - this.c3Freq) * 2;
      this.c3Pos = (this.c3Pos + 1) & 31;
      const byte = this.waveRam[this.c3Pos >> 1]!;
      this.c3Sample = (this.c3Pos & 1) ? (byte & 0xf) : (byte >> 4);
    }
    // CH4 timer
    if (--this.c4Timer <= 0) {
      const nr43 = this.reg[0x12]!;
      this.c4Timer = (NOISE_DIVISORS[nr43 & 7]! << (nr43 >> 4)) || 8;
      const xor = (this.c4Lfsr & 1) ^ ((this.c4Lfsr >> 1) & 1);
      this.c4Lfsr = (this.c4Lfsr >> 1) | (xor << 14);
      if (nr43 & 0x08) { this.c4Lfsr &= ~0x40; this.c4Lfsr |= xor << 6; } // 7-bit width
    }

    // frame sequencer @ 512 Hz
    if (++this.fsCounter >= FRAME_SEQ_PERIOD) {
      this.fsCounter = 0;
      this.clockFrameSequencer();
    }

    // resample to output rate
    if (++this.sampleCounter >= this.cyclesPerSample) {
      this.sampleCounter -= this.cyclesPerSample;
      this.mixAndPush();
    }
  }

  private clockFrameSequencer(): void {
    const step = this.fsStep;
    // length counters on steps 0,2,4,6
    if ((step & 1) === 0) {
      if ((this.reg[0x04]! & 0x40) && this.c1Len > 0 && --this.c1Len === 0) this.c1On = false;
      if ((this.reg[0x09]! & 0x40) && this.c2Len > 0 && --this.c2Len === 0) this.c2On = false;
      if ((this.reg[0x0e]! & 0x40) && this.c3Len > 0 && --this.c3Len === 0) this.c3On = false;
      if ((this.reg[0x13]! & 0x40) && this.c4Len > 0 && --this.c4Len === 0) this.c4On = false;
    }
    // sweep on steps 2,6
    if (step === 2 || step === 6) {
      if (this.c1SweepEnabled && --this.c1SweepTimer <= 0) {
        this.c1SweepTimer = this.c1SweepPeriod || 8;
        if (this.c1SweepPeriod > 0) {
          const next = this.sweepCalc();
          if (next <= 2047 && this.c1SweepShift > 0) {
            this.c1SweepShadow = next; this.c1Freq = next; this.sweepCalc();
          }
        }
      }
    }
    // envelopes on step 7
    if (step === 7) {
      this.clockEnv(1); this.clockEnv(2); this.clockEnv(4);
    }
    this.fsStep = (this.fsStep + 1) & 7;
  }

  private clockEnv(ch: 1 | 2 | 4): void {
    if (ch === 1) {
      if (this.c1EnvPeriod === 0) return;
      if (--this.c1EnvTimer <= 0) {
        this.c1EnvTimer = this.c1EnvPeriod;
        if (this.c1EnvUp && this.c1Vol < 15) this.c1Vol++;
        else if (!this.c1EnvUp && this.c1Vol > 0) this.c1Vol--;
      }
    } else if (ch === 2) {
      if (this.c2EnvPeriod === 0) return;
      if (--this.c2EnvTimer <= 0) {
        this.c2EnvTimer = this.c2EnvPeriod;
        if (this.c2EnvUp && this.c2Vol < 15) this.c2Vol++;
        else if (!this.c2EnvUp && this.c2Vol > 0) this.c2Vol--;
      }
    } else {
      if (this.c4EnvPeriod === 0) return;
      if (--this.c4EnvTimer <= 0) {
        this.c4EnvTimer = this.c4EnvPeriod;
        if (this.c4EnvUp && this.c4Vol < 15) this.c4Vol++;
        else if (!this.c4EnvUp && this.c4Vol > 0) this.c4Vol--;
      }
    }
  }

  // ---- mixing ----
  private mixAndPush(): void {
    // per-channel output in [0..15]
    const ch1 = this.c1On ? (DUTY_TABLE[(this.reg[0x01]! >> 6) & 3]![this.c1DutyPos]! ? this.c1Vol : 0) : 0;
    const ch2 = this.c2On ? (DUTY_TABLE[(this.reg[0x06]! >> 6) & 3]![this.c2DutyPos]! ? this.c2Vol : 0) : 0;
    // CH3 volume shift: NR32 bits 5-6 → 0:mute,1:100%,2:50%,3:25%
    const c3shift = [4, 0, 1, 2][(this.reg[0x0c]! >> 5) & 3]!;
    const ch3 = this.c3On && (this.reg[0x0a]! & 0x80) ? (this.c3Sample >> c3shift) : 0;
    const ch4 = this.c4On ? ((~this.c4Lfsr & 1) ? this.c4Vol : 0) : 0;

    // panning (NR51 / FF25): bits 0-3 = right, 4-7 = left
    const pan = this.reg[0x15]!;
    let l = 0, r = 0;
    if (pan & 0x10) l += ch1; if (pan & 0x01) r += ch1;
    if (pan & 0x20) l += ch2; if (pan & 0x02) r += ch2;
    if (pan & 0x40) l += ch3; if (pan & 0x04) r += ch3;
    if (pan & 0x80) l += ch4; if (pan & 0x08) r += ch4;

    // master volume (NR50 / FF24): bits 0-2 right, 4-6 left (0-7 → ×(n+1)/8)
    const nr50 = this.reg[0x14]!;
    const lVol = ((nr50 >> 4) & 7) + 1;
    const rVol = (nr50 & 7) + 1;

    // normalize: 4 channels × 15 max × volume 8 ≈ 480 full-scale; 0.6 keeps headroom.
    this.pushSample((l * lVol) / 480 * 0.6, (r * rVol) / 480 * 0.6);
  }

  private pushSample(l: number, r: number): void {
    if (this.outL.length >= this.maxBuffered) return; // drop if host isn't draining (paused tab)
    this.outL.push(l);
    this.outR.push(r);
  }

  /** Pull all accumulated stereo samples since last call. Returns {left,right} Float32Arrays. */
  drain(): { left: Float32Array; right: Float32Array } {
    const left = Float32Array.from(this.outL);
    const right = Float32Array.from(this.outR);
    this.outL.length = 0; this.outR.length = 0;
    return { left, right };
  }

  /** How many samples are queued (host uses this to manage buffer latency). */
  get queued(): number { return this.outL.length; }
}

// Hardware OR-masks for register reads (bits that always read 1).
const READ_OR_MASK = new Uint8Array(0x30);
{
  const set = (a: number, m: number) => { READ_OR_MASK[a - 0xff10] = m; };
  set(0xff10, 0x80); set(0xff11, 0x3f); set(0xff12, 0x00); set(0xff13, 0xff); set(0xff14, 0xbf);
  set(0xff15, 0xff); set(0xff16, 0x3f); set(0xff17, 0x00); set(0xff18, 0xff); set(0xff19, 0xbf);
  set(0xff1a, 0x7f); set(0xff1b, 0xff); set(0xff1c, 0x9f); set(0xff1d, 0xff); set(0xff1e, 0xbf);
  set(0xff1f, 0xff); set(0xff20, 0xff); set(0xff21, 0x00); set(0xff22, 0x00); set(0xff23, 0xbf);
  set(0xff24, 0x00); set(0xff25, 0x00); set(0xff26, 0xff);
  for (let a = 0xff27; a <= 0xff2f; a++) set(a, 0xff);
}

/** Build an IoHooks adapter that routes APU register reads/writes to the APU instance. */
export function apuIoHooks(apu: APU, fallback?: IoHooks | null): IoHooks {
  return {
    readIO(addr: number): number | null {
      if (APU.isAudioAddr(addr)) return apu.readReg(addr);
      return fallback ? fallback.readIO(addr) : null;
    },
    writeIO(addr: number, value: number): boolean {
      if (APU.isAudioAddr(addr)) { apu.writeReg(addr, value); return true; }
      return fallback ? fallback.writeIO(addr, value) : false;
    },
  };
}
