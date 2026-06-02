/**
 * Phase 1 oracle: decoder coverage + known-answer disassembly.
 *
 * Run:  node --experimental-strip-types tests/decoder.test.ts
 *
 * No external test framework — a tiny assert harness keeps the toolchain minimal
 * and the "green board" self-contained.
 */

import { decode, disassembleRange, hex4 } from "../src/recompiler/decoder.ts";
import { BASE, CB, ILLEGAL_OPCODES, tableCoverage } from "../src/recompiler/opcodes.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
  }
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// ---- 1. Table coverage: every base + CB slot defined --------------------------
const cov = tableCoverage();
eq(cov.base, 256, "all 256 base opcode slots covered");
eq(cov.cb, 256, "all 256 CB opcode slots covered");

// ---- 2. Illegal opcodes decode as ILLEGAL terminators -------------------------
for (const op of ILLEGAL_OPCODES) {
  const buf = new Uint8Array([op, 0, 0]);
  const ins = decode(buf, 0, 0x0000);
  eq(ins.mnemonic, "ILLEGAL", `opcode ${op.toString(16)} -> ILLEGAL`);
  ok(ins.isTerminator, `illegal ${op.toString(16)} is terminator`);
}

// ---- 3. Known-answer single instructions --------------------------------------
type KA = { bytes: number[]; addr: number; text: string; len: number; mnem: string };
const known: KA[] = [
  { bytes: [0x00], addr: 0x150, text: "NOP", len: 1, mnem: "NOP" },
  { bytes: [0x3e, 0x42], addr: 0x150, text: "LD A, $42", len: 2, mnem: "LD" },
  { bytes: [0x06, 0xff], addr: 0x150, text: "LD B, $FF", len: 2, mnem: "LD" },
  { bytes: [0x21, 0x34, 0x12], addr: 0x150, text: "LD HL, $1234", len: 3, mnem: "LD" },
  { bytes: [0xc3, 0x50, 0x01], addr: 0x150, text: "JP $0150", len: 3, mnem: "JP" },
  { bytes: [0xcd, 0x00, 0x40], addr: 0x150, text: "CALL $4000", len: 3, mnem: "CALL" },
  { bytes: [0xc9], addr: 0x150, text: "RET", len: 1, mnem: "RET" },
  { bytes: [0xe9], addr: 0x150, text: "JP (HL)", len: 1, mnem: "JP" },
  { bytes: [0xaf], addr: 0x150, text: "XOR A", len: 1, mnem: "XOR" },
  { bytes: [0x80], addr: 0x150, text: "ADD A, B", len: 1, mnem: "ADD" },
  { bytes: [0x09], addr: 0x150, text: "ADD HL, BC", len: 1, mnem: "ADD16" },
  { bytes: [0x76], addr: 0x150, text: "HALT", len: 1, mnem: "HALT" },
  { bytes: [0xf3], addr: 0x150, text: "DI", len: 1, mnem: "DI" },
  { bytes: [0xff], addr: 0x150, text: "RST 38H", len: 1, mnem: "RST" },
  { bytes: [0xe0, 0x40], addr: 0x150, text: "LDH ($40), A", len: 2, mnem: "LDH" },
  { bytes: [0xea, 0x00, 0xc0], addr: 0x150, text: "LD ($C000), A", len: 3, mnem: "LD" },
  // CB-prefixed
  { bytes: [0xcb, 0x7c], addr: 0x150, text: "BIT 7, H", len: 2, mnem: "BIT" },
  { bytes: [0xcb, 0x11], addr: 0x150, text: "RL C", len: 2, mnem: "RL" },
  { bytes: [0xcb, 0x37], addr: 0x150, text: "SWAP A", len: 2, mnem: "SWAP" },
  { bytes: [0xcb, 0xfe], addr: 0x150, text: "SET 7, (HL)", len: 2, mnem: "SET" },
];

for (const k of known) {
  const buf = new Uint8Array([...k.bytes, 0, 0]);
  const ins = decode(buf, 0, k.addr);
  eq(ins.mnemonic, k.mnem, `decode ${k.bytes.map((b) => b.toString(16)).join(" ")} mnemonic`);
  eq(ins.length, k.len, `decode ${k.text} length`);
  eq(ins.text, k.text, `decode ${k.bytes.map((b) => b.toString(16)).join(" ")} text`);
}

// ---- 4. JR relative target math ------------------------------------------------
{
  // JR +2 at 0x0100: next = 0x0102, +2 => 0x0104
  const buf = new Uint8Array([0x18, 0x02, 0, 0]);
  const ins = decode(buf, 0, 0x0100);
  eq(ins.mnemonic, "JR", "JR mnemonic");
  ok(ins.staticTargets?.includes(0x0104) ?? false, "JR +2 from 0x100 -> 0x104");
}
{
  // JR -2 (0xFE) at 0x0100: next = 0x0102, -2 => 0x0100 (tight loop)
  const buf = new Uint8Array([0x18, 0xfe, 0, 0]);
  const ins = decode(buf, 0, 0x0100);
  ok(ins.staticTargets?.includes(0x0100) ?? false, "JR -2 from 0x100 -> 0x100 (self loop)");
}
{
  // Conditional JR NZ has TWO static targets (taken + fallthrough)
  const buf = new Uint8Array([0x20, 0x05, 0, 0]);
  const ins = decode(buf, 0, 0x0200);
  eq(ins.staticTargets?.length, 2, "JR NZ has 2 static targets");
  ok(ins.staticTargets?.includes(0x0207) ?? false, "JR NZ +5 taken -> 0x207");
  ok(ins.staticTargets?.includes(0x0202) ?? false, "JR NZ fallthrough -> 0x202");
}

// ---- 5. Linear sweep over a tiny program --------------------------------------
{
  // A realistic snippet resembling a Game Boy init:
  //   DI; LD SP,$FFFE; XOR A; LD ($FF00+$40),A; JP $0150
  const prog = [0xf3, 0x31, 0xfe, 0xff, 0xaf, 0xe0, 0x40, 0xc3, 0x50, 0x01];
  const buf = new Uint8Array(prog);
  const ins = disassembleRange(buf, 0, prog.length, 0x0100);
  eq(ins.length, 5, "sweep produced 5 instructions");
  eq(ins[0]!.text, "DI", "sweep[0] DI");
  eq(ins[1]!.text, "LD SP, $FFFE", "sweep[1] LD SP,$FFFE");
  eq(ins[2]!.text, "XOR A", "sweep[2] XOR A");
  eq(ins[4]!.text, "JP $0150", "sweep[4] JP $0150");
}

// ---- 6. Every base opcode decodes without throwing ----------------------------
for (let op = 0; op <= 0xff; op++) {
  if (op === 0xcb) continue;
  try {
    const buf = new Uint8Array([op, 0x00, 0x00]);
    const ins = decode(buf, 0, 0x0150);
    ok(ins.length >= 1 && ins.length <= 3, `base ${op.toString(16)} sane length`);
  } catch (e) {
    ok(false, `base opcode ${op.toString(16)} threw: ${(e as Error).message}`);
  }
}
// Every CB opcode decodes without throwing
for (let cb = 0; cb <= 0xff; cb++) {
  try {
    const buf = new Uint8Array([0xcb, cb, 0x00]);
    const ins = decode(buf, 0, 0x0150);
    eq(ins.length, 2, `CB ${cb.toString(16)} length 2`);
  } catch (e) {
    ok(false, `CB opcode ${cb.toString(16)} threw: ${(e as Error).message}`);
  }
}

// ---- report -------------------------------------------------------------------
console.log("");
console.log("================ PHASE 1: DECODER ORACLE ================");
console.log(`  PASS: ${pass}`);
console.log(`  FAIL: ${fail}`);
if (fail > 0) {
  console.log("\n  Failures:");
  for (const f of failures.slice(0, 40)) console.log("   x " + f);
  console.log("========================================================\n");
  process.exit(1);
} else {
  console.log("  ALL GREEN ✓  (256 base + 256 CB opcodes, KA disasm, flow analysis)");
  console.log("========================================================\n");
}
