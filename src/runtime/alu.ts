/**
 * SM83 ALU reference model.
 *
 * This is the single source of truth for arithmetic + flag behaviour. The recompiler's
 * lifter emits WASM that mirrors these exact operations; this module is ALSO used directly
 * by the interpreter fallback and by the test oracle. Keeping ONE definition means the
 * recompiled path and the reference path can never silently disagree.
 *
 * Flag register F layout (bit 7..4): Z N H C, low nibble always 0.
 *
 * The half-carry (H) flag is the classic divergence point in Game Boy ports. We compute it
 * explicitly from nibble arithmetic for every op. DAA is implemented per the documented
 * post-BCD-adjust algorithm, keyed off N/H/C.
 */

export const FLAG_Z = 0x80;
export const FLAG_N = 0x40;
export const FLAG_H = 0x20;
export const FLAG_C = 0x10;

export interface AluResult {
  /** 8-bit result (or 16-bit for the 16-bit ops). */
  v: number;
  /** New flag register value (F). */
  f: number;
}

function flags(z: boolean, n: boolean, h: boolean, c: boolean): number {
  return (z ? FLAG_Z : 0) | (n ? FLAG_N : 0) | (h ? FLAG_H : 0) | (c ? FLAG_C : 0);
}

// ---------------------------------------------------------------------------
// 8-bit arithmetic
// ---------------------------------------------------------------------------

export function add8(a: number, b: number): AluResult {
  const r = a + b;
  const v = r & 0xff;
  const h = ((a & 0xf) + (b & 0xf)) > 0xf;
  return { v, f: flags(v === 0, false, h, r > 0xff) };
}

export function adc8(a: number, b: number, carryIn: number): AluResult {
  const c = carryIn ? 1 : 0;
  const r = a + b + c;
  const v = r & 0xff;
  const h = ((a & 0xf) + (b & 0xf) + c) > 0xf;
  return { v, f: flags(v === 0, false, h, r > 0xff) };
}

export function sub8(a: number, b: number): AluResult {
  const r = a - b;
  const v = r & 0xff;
  const h = (a & 0xf) - (b & 0xf) < 0;
  return { v, f: flags(v === 0, true, h, r < 0) };
}

export function sbc8(a: number, b: number, carryIn: number): AluResult {
  const c = carryIn ? 1 : 0;
  const r = a - b - c;
  const v = r & 0xff;
  const h = (a & 0xf) - (b & 0xf) - c < 0;
  return { v, f: flags(v === 0, true, h, r < 0) };
}

/** CP is SUB without storing the result — flags only. */
export function cp8(a: number, b: number): AluResult {
  const res = sub8(a, b);
  return { v: a, f: res.f }; // value unchanged, flags as if subtracted
}

export function and8(a: number, b: number): AluResult {
  const v = a & b & 0xff;
  return { v, f: flags(v === 0, false, true, false) }; // H always set, C cleared
}

export function or8(a: number, b: number): AluResult {
  const v = (a | b) & 0xff;
  return { v, f: flags(v === 0, false, false, false) };
}

export function xor8(a: number, b: number): AluResult {
  const v = (a ^ b) & 0xff;
  return { v, f: flags(v === 0, false, false, false) };
}

/** INC r: does NOT affect C. Preserve incoming carry. */
export function inc8(a: number, fIn: number): AluResult {
  const v = (a + 1) & 0xff;
  const h = (a & 0xf) + 1 > 0xf;
  const c = (fIn & FLAG_C) !== 0;
  return { v, f: flags(v === 0, false, h, c) };
}

/** DEC r: does NOT affect C. */
export function dec8(a: number, fIn: number): AluResult {
  const v = (a - 1) & 0xff;
  const h = (a & 0xf) === 0; // borrow from bit 4
  const c = (fIn & FLAG_C) !== 0;
  return { v, f: flags(v === 0, true, h, c) };
}

// ---------------------------------------------------------------------------
// DAA — decimal adjust accumulator. The famous one.
// Behaviour depends on the N (last op was subtract?), H, and C flags.
// ---------------------------------------------------------------------------

export function daa(a: number, fIn: number): AluResult {
  let v = a;
  let correction = 0;
  const n = (fIn & FLAG_N) !== 0;
  const h = (fIn & FLAG_H) !== 0;
  let c = (fIn & FLAG_C) !== 0;

  if (!n) {
    // after addition
    if (h || (v & 0x0f) > 0x09) correction |= 0x06;
    if (c || v > 0x99) {
      correction |= 0x60;
      c = true;
    }
    v = (v + correction) & 0xff;
  } else {
    // after subtraction
    if (h) correction |= 0x06;
    if (c) correction |= 0x60;
    v = (v - correction) & 0xff;
  }

  // H is always cleared by DAA; Z from result; N preserved; C as computed.
  return { v, f: (v === 0 ? FLAG_Z : 0) | (n ? FLAG_N : 0) | (c ? FLAG_C : 0) };
}

/** CPL — complement A. Sets N and H, preserves Z and C. */
export function cpl(a: number, fIn: number): AluResult {
  const v = (~a) & 0xff;
  return { v, f: (fIn & (FLAG_Z | FLAG_C)) | FLAG_N | FLAG_H };
}

/** SCF — set carry flag. Clears N,H. Preserves Z. */
export function scf(fIn: number): number {
  return (fIn & FLAG_Z) | FLAG_C;
}

/** CCF — complement carry flag. Clears N,H. Preserves Z. */
export function ccf(fIn: number): number {
  const c = (fIn & FLAG_C) !== 0;
  return (fIn & FLAG_Z) | (c ? 0 : FLAG_C);
}

// ---------------------------------------------------------------------------
// 16-bit arithmetic
// ---------------------------------------------------------------------------

/** ADD HL, rr — Z preserved, N=0, H from bit 11 carry, C from bit 15 carry. */
export function add16(hl: number, rr: number, fIn: number): AluResult {
  const r = hl + rr;
  const v = r & 0xffff;
  const h = ((hl & 0x0fff) + (rr & 0x0fff)) > 0x0fff;
  const z = (fIn & FLAG_Z) !== 0;
  return { v, f: flags(z, false, h, r > 0xffff) };
}

/** ADD SP, r8 / LD HL,SP+r8 — Z=0, N=0, H and C computed from the LOW byte (8-bit math). */
export function addSpR8(sp: number, r8: number): AluResult {
  const e = r8 & 0xff; // unsigned low byte for flag computation
  const v = (sp + (r8 << 24 >> 24)) & 0xffff; // signed add for the value
  const h = ((sp & 0xf) + (e & 0xf)) > 0xf;
  const c = ((sp & 0xff) + e) > 0xff;
  return { v, f: flags(false, false, h, c) };
}

export function inc16(rr: number): number {
  return (rr + 1) & 0xffff;
}
export function dec16(rr: number): number {
  return (rr - 1) & 0xffff;
}

// ---------------------------------------------------------------------------
// Rotates & shifts (CB-prefixed + accumulator forms)
// ---------------------------------------------------------------------------

export function rlc(v: number): AluResult {
  const c = (v >> 7) & 1;
  const r = ((v << 1) | c) & 0xff;
  return { v: r, f: flags(r === 0, false, false, c === 1) };
}
export function rrc(v: number): AluResult {
  const c = v & 1;
  const r = ((v >> 1) | (c << 7)) & 0xff;
  return { v: r, f: flags(r === 0, false, false, c === 1) };
}
export function rl(v: number, carryIn: number): AluResult {
  const c = (v >> 7) & 1;
  const r = ((v << 1) | (carryIn ? 1 : 0)) & 0xff;
  return { v: r, f: flags(r === 0, false, false, c === 1) };
}
export function rr(v: number, carryIn: number): AluResult {
  const c = v & 1;
  const r = ((v >> 1) | (carryIn ? 0x80 : 0)) & 0xff;
  return { v: r, f: flags(r === 0, false, false, c === 1) };
}
export function sla(v: number): AluResult {
  const c = (v >> 7) & 1;
  const r = (v << 1) & 0xff;
  return { v: r, f: flags(r === 0, false, false, c === 1) };
}
export function sra(v: number): AluResult {
  const c = v & 1;
  const r = ((v >> 1) | (v & 0x80)) & 0xff; // arithmetic: keep sign bit
  return { v: r, f: flags(r === 0, false, false, c === 1) };
}
export function srl(v: number): AluResult {
  const c = v & 1;
  const r = (v >> 1) & 0xff;
  return { v: r, f: flags(r === 0, false, false, c === 1) };
}
export function swap(v: number): AluResult {
  const r = ((v & 0x0f) << 4) | ((v & 0xf0) >> 4);
  return { v: r, f: flags(r === 0, false, false, false) };
}

/**
 * Accumulator rotate forms (RLCA/RRCA/RLA/RRA) are special: Z is ALWAYS cleared,
 * unlike their CB counterparts which set Z from the result.
 */
export function rlca(a: number): AluResult {
  const r = rlc(a);
  return { v: r.v, f: r.f & ~FLAG_Z };
}
export function rrca(a: number): AluResult {
  const r = rrc(a);
  return { v: r.v, f: r.f & ~FLAG_Z };
}
export function rla(a: number, carryIn: number): AluResult {
  const r = rl(a, carryIn);
  return { v: r.v, f: r.f & ~FLAG_Z };
}
export function rra(a: number, carryIn: number): AluResult {
  const r = rr(a, carryIn);
  return { v: r.v, f: r.f & ~FLAG_Z };
}

// ---------------------------------------------------------------------------
// Bit operations
// ---------------------------------------------------------------------------

/** BIT n,r — Z = !(bit set), N=0, H=1, C preserved. */
export function bit(n: number, v: number, fIn: number): number {
  const set = (v >> n) & 1;
  return (set ? 0 : FLAG_Z) | FLAG_H | (fIn & FLAG_C);
}
export function res(n: number, v: number): number {
  return v & ~(1 << n) & 0xff;
}
export function set(n: number, v: number): number {
  return (v | (1 << n)) & 0xff;
}
