/**
 * Phase 2 oracle: SM83 ALU + flag correctness.
 *
 * This is the highest-stakes test in the whole project. If half-carry or DAA is wrong,
 * Pokemon's damage/RNG silently diverge. We test:
 *   - known-answer arithmetic
 *   - half-carry boundary conditions (the classic port killer)
 *   - DAA after both addition and subtraction
 *   - the accumulator-rotate Z=0 quirk
 *   - exhaustive add8/sub8 flag cross-check against an independent re-derivation
 *
 * Run: node --experimental-strip-types tests/alu.test.ts
 */

import * as alu from "../src/runtime/alu.ts";
const { FLAG_Z, FLAG_N, FLAG_H, FLAG_C } = alu;

let pass = 0,
  fail = 0;
const failures: string[] = [];
function ok(c: boolean, m: string) {
  if (c) pass++;
  else {
    fail++;
    failures.push(m);
  }
}
function eqv(got: number, want: number, m: string) {
  ok(got === want, `${m} (got ${got}, want ${want})`);
}
function eqf(got: number, want: number, m: string) {
  ok(got === want, `${m} (got F=${fstr(got)}, want F=${fstr(want)})`);
}
function fstr(f: number): string {
  return (
    (f & FLAG_Z ? "Z" : "-") +
    (f & FLAG_N ? "N" : "-") +
    (f & FLAG_H ? "H" : "-") +
    (f & FLAG_C ? "C" : "-")
  );
}

// ---- ADD8 -------------------------------------------------------------------
{
  let r = alu.add8(0x3a, 0xc6); // 0x3A+0xC6 = 0x100 -> 0x00, Z H C
  eqv(r.v, 0x00, "ADD 3A+C6 value");
  eqf(r.f, FLAG_Z | FLAG_H | FLAG_C, "ADD 3A+C6 flags = Z H C");

  r = alu.add8(0x0f, 0x01); // half-carry boundary, no full carry
  eqv(r.v, 0x10, "ADD 0F+01 value");
  eqf(r.f, FLAG_H, "ADD 0F+01 flags = H only");

  r = alu.add8(0x00, 0x00);
  eqf(r.f, FLAG_Z, "ADD 0+0 = Z");

  r = alu.add8(0xff, 0x01);
  eqv(r.v, 0x00, "ADD FF+01 wraps to 0");
  eqf(r.f, FLAG_Z | FLAG_H | FLAG_C, "ADD FF+01 = Z H C");
}

// ---- ADC --------------------------------------------------------------------
{
  const r = alu.adc8(0xe1, 0x0f, 1); // E1+0F+1 = 0xF1, half-carry from low nibble (1+F+1)
  eqv(r.v, 0xf1, "ADC E1+0F+1 value");
  ok((r.f & FLAG_H) !== 0, "ADC E1+0F+1 sets H");
  ok((r.f & FLAG_C) === 0, "ADC E1+0F+1 no C");
}

// ---- SUB / CP ---------------------------------------------------------------
{
  let r = alu.sub8(0x3e, 0x3e); // equal -> zero, no borrow
  eqv(r.v, 0x00, "SUB equal value 0");
  eqf(r.f, FLAG_Z | FLAG_N, "SUB equal = Z N");

  r = alu.sub8(0x3e, 0x0f); // 3E-0F: low nibble E-F borrows -> H
  eqv(r.v, 0x2f, "SUB 3E-0F value");
  eqf(r.f, FLAG_N | FLAG_H, "SUB 3E-0F = N H");

  r = alu.sub8(0x10, 0x20); // underflow -> C
  eqv(r.v, 0xf0, "SUB 10-20 wraps");
  eqf(r.f, FLAG_N | FLAG_C, "SUB 10-20 = N C");

  // CP leaves value unchanged but sets SUB flags
  const c = alu.cp8(0x3c, 0x2f);
  eqv(c.v, 0x3c, "CP preserves A");
  ok((c.f & FLAG_N) !== 0, "CP sets N");
  ok((c.f & FLAG_H) !== 0, "CP 3C vs 2F sets H (C-F borrow)");
}

// ---- AND/OR/XOR -------------------------------------------------------------
{
  let r = alu.and8(0x5a, 0x3f);
  eqv(r.v, 0x1a, "AND 5A&3F");
  eqf(r.f, FLAG_H, "AND sets H, clears others");
  r = alu.and8(0x00, 0xff);
  eqf(r.f, FLAG_Z | FLAG_H, "AND ->0 = Z H");

  r = alu.or8(0x00, 0x00);
  eqf(r.f, FLAG_Z, "OR 0 = Z");
  r = alu.xor8(0xff, 0xff);
  eqv(r.v, 0x00, "XOR FF^FF = 0");
  eqf(r.f, FLAG_Z, "XOR ->0 = Z");
}

// ---- INC/DEC preserve carry -------------------------------------------------
{
  // INC with carry already set: carry must survive
  let r = alu.inc8(0x0f, FLAG_C);
  eqv(r.v, 0x10, "INC 0F value");
  ok((r.f & FLAG_H) !== 0, "INC 0F sets H");
  ok((r.f & FLAG_C) !== 0, "INC preserves incoming C");

  r = alu.inc8(0xff, 0);
  eqv(r.v, 0x00, "INC FF wraps");
  eqf(r.f & ~FLAG_C, FLAG_Z | FLAG_H, "INC FF = Z H (C untouched=0)");

  r = alu.dec8(0x01, FLAG_C);
  eqv(r.v, 0x00, "DEC 01 -> 0");
  ok((r.f & FLAG_Z) !== 0, "DEC ->0 sets Z");
  ok((r.f & FLAG_N) !== 0, "DEC sets N");
  ok((r.f & FLAG_C) !== 0, "DEC preserves incoming C");

  r = alu.dec8(0x00, 0);
  eqv(r.v, 0xff, "DEC 00 wraps to FF");
  ok((r.f & FLAG_H) !== 0, "DEC 00 sets H (borrow)");
}

// ---- DAA --------------------------------------------------------------------
{
  // 0x09 + 0x08 = 0x11 raw; ADD sets H? 9+8=0x11 low nibble overflow -> H set.
  // After add: A=0x11, flags from add8:
  let add = alu.add8(0x09, 0x08); // = 0x11, H set (9+8=0x11>0xf)
  let d = alu.daa(add.v, add.f); // BCD: 9+8 = 17 decimal
  eqv(d.v, 0x17, "DAA(0x09+0x08) = 0x17 BCD");

  // 0x45 + 0x38 = 0x7D raw, no H/C; BCD expected 0x83
  add = alu.add8(0x45, 0x38);
  d = alu.daa(add.v, add.f);
  eqv(d.v, 0x83, "DAA(0x45+0x38) = 0x83 BCD");

  // BCD subtraction: 0x42 - 0x09 = 0x39 raw with H borrow; BCD expected 0x33
  let sub = alu.sub8(0x42, 0x09);
  d = alu.daa(sub.v, sub.f);
  eqv(d.v, 0x33, "DAA after SUB(0x42-0x09) = 0x33 BCD");

  // DAA always clears H
  ok((d.f & FLAG_H) === 0, "DAA clears H");

  // BCD carry-out: 0x90 + 0x90 = 0x120 -> wraps to 0x20, BCD 180 -> 0x80 + carry
  add = alu.add8(0x90, 0x90); // 0x20, C set
  d = alu.daa(add.v, add.f);
  eqv(d.v, 0x80, "DAA(0x90+0x90) value 0x80");
  ok((d.f & FLAG_C) !== 0, "DAA(0x90+0x90) sets C (BCD overflow)");
}

// ---- CPL / SCF / CCF --------------------------------------------------------
{
  const r = alu.cpl(0x35, FLAG_Z | FLAG_C);
  eqv(r.v, 0xca, "CPL 0x35 = 0xCA");
  ok((r.f & FLAG_N) !== 0 && (r.f & FLAG_H) !== 0, "CPL sets N H");
  ok((r.f & FLAG_Z) !== 0 && (r.f & FLAG_C) !== 0, "CPL preserves Z C");

  eqf(alu.scf(FLAG_Z | FLAG_N | FLAG_H), FLAG_Z | FLAG_C, "SCF sets C, clears N H, keeps Z");
  eqf(alu.ccf(FLAG_C), 0, "CCF clears set C");
  eqf(alu.ccf(0), FLAG_C, "CCF sets cleared C");
}

// ---- 16-bit ADD HL ----------------------------------------------------------
{
  const r = alu.add16(0x8a23, 0x0605, FLAG_Z); // bit-11 carry test
  eqv(r.v, 0x9028, "ADD HL value");
  ok((r.f & FLAG_H) !== 0, "ADD HL sets H from bit 11");
  ok((r.f & FLAG_Z) !== 0, "ADD HL preserves Z");
  ok((r.f & FLAG_N) === 0, "ADD HL clears N");

  const ov = alu.add16(0xffff, 0x0001, 0);
  eqv(ov.v, 0x0000, "ADD HL FFFF+1 wraps");
  ok((ov.f & FLAG_C) !== 0, "ADD HL overflow sets C");
}

// ---- ADD SP, r8 (8-bit flag semantics, signed value) ------------------------
{
  const r = alu.addSpR8(0xfff8, 0x02); // +2
  eqv(r.v, 0xfffa, "ADD SP,+2 value");
  ok((r.f & FLAG_Z) === 0 && (r.f & FLAG_N) === 0, "ADD SP clears Z N");

  const neg = alu.addSpR8(0x0005, 0xfb); // -5
  eqv(neg.v, 0x0000, "ADD SP,-5 from 5 = 0");
}

// ---- Rotates: accumulator Z=0 quirk vs CB Z-from-result ---------------------
{
  // RLCA of 0x00 -> result 0, but Z MUST be 0 (accumulator form)
  let r = alu.rlca(0x00);
  eqv(r.v, 0x00, "RLCA 0 value");
  ok((r.f & FLAG_Z) === 0, "RLCA never sets Z (quirk)");

  // CB RLC of 0x00 -> result 0, Z SET
  r = alu.rlc(0x00);
  ok((r.f & FLAG_Z) !== 0, "CB RLC 0 sets Z");

  // RLC 0x85 -> 0x0B, carry from bit7
  r = alu.rlc(0x85);
  eqv(r.v, 0x0b, "RLC 0x85 = 0x0B");
  ok((r.f & FLAG_C) !== 0, "RLC 0x85 sets C");

  // RR through carry
  r = alu.rr(0x01, 0); // bit0 ->C, no carry in -> 0x00
  eqv(r.v, 0x00, "RR 0x01 = 0x00");
  ok((r.f & FLAG_C) !== 0, "RR 0x01 sets C");

  // SRA keeps sign bit
  r = alu.sra(0x8a);
  eqv(r.v, 0xc5, "SRA 0x8A = 0xC5 (sign preserved)");

  // SWAP nibbles
  r = alu.swap(0x3c);
  eqv(r.v, 0xc3, "SWAP 0x3C = 0xC3");
  r = alu.swap(0x00);
  ok((r.f & FLAG_Z) !== 0, "SWAP 0 sets Z");

  // SRL clears sign
  r = alu.srl(0xff);
  eqv(r.v, 0x7f, "SRL 0xFF = 0x7F");
  ok((r.f & FLAG_C) !== 0, "SRL 0xFF sets C");
}

// ---- BIT / RES / SET --------------------------------------------------------
{
  let f = alu.bit(7, 0x80, 0); // bit 7 set -> Z clear
  ok((f & FLAG_Z) === 0, "BIT 7 of 0x80 -> Z clear");
  ok((f & FLAG_H) !== 0, "BIT sets H");
  f = alu.bit(0, 0x80, FLAG_C);
  ok((f & FLAG_Z) !== 0, "BIT 0 of 0x80 -> Z set");
  ok((f & FLAG_C) !== 0, "BIT preserves C");

  eqv(alu.res(3, 0xff), 0xf7, "RES 3 of 0xFF");
  eqv(alu.set(3, 0x00), 0x08, "SET 3 of 0x00");
}

// ---- Exhaustive cross-check: add8/sub8 over all 65536 input pairs -----------
// Independent re-derivation of H and C to catch any subtle table error.
{
  let mismatches = 0;
  for (let a = 0; a < 256 && mismatches < 5; a++) {
    for (let b = 0; b < 256; b++) {
      const r = alu.add8(a, b);
      const sum = a + b;
      const expV = sum & 0xff;
      const expH = ((a & 0xf) + (b & 0xf)) > 0xf ? FLAG_H : 0;
      const expC = sum > 0xff ? FLAG_C : 0;
      const expZ = expV === 0 ? FLAG_Z : 0;
      const exp = expZ | expH | expC; // N=0
      if (r.v !== expV || r.f !== exp) {
        mismatches++;
        failures.push(`ADD exhaustive mismatch a=${a} b=${b}`);
      }
    }
  }
  ok(mismatches === 0, "ADD8 exhaustive (65536 pairs) matches re-derivation");

  mismatches = 0;
  for (let a = 0; a < 256 && mismatches < 5; a++) {
    for (let b = 0; b < 256; b++) {
      const r = alu.sub8(a, b);
      const diff = a - b;
      const expV = diff & 0xff;
      const expH = (a & 0xf) - (b & 0xf) < 0 ? FLAG_H : 0;
      const expC = diff < 0 ? FLAG_C : 0;
      const expZ = expV === 0 ? FLAG_Z : 0;
      const exp = FLAG_N | expZ | expH | expC;
      if (r.v !== expV || r.f !== exp) {
        mismatches++;
        failures.push(`SUB exhaustive mismatch a=${a} b=${b}`);
      }
    }
  }
  ok(mismatches === 0, "SUB8 exhaustive (65536 pairs) matches re-derivation");
}

// ---- report -----------------------------------------------------------------
console.log("");
console.log("================ PHASE 2: ALU / FLAG ORACLE ============");
console.log(`  PASS: ${pass}`);
console.log(`  FAIL: ${fail}`);
if (fail > 0) {
  console.log("\n  Failures:");
  for (const f of failures.slice(0, 40)) console.log("   x " + f);
  console.log("========================================================\n");
  process.exit(1);
} else {
  console.log("  ALL GREEN ✓  (half-carry, DAA, rotates, 131072 exhaustive pairs)");
  console.log("========================================================\n");
}
