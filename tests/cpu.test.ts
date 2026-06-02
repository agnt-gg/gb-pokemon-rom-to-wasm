/**
 * Phase 3 oracle: CPU interpreter + MMU integration.
 *
 * Hand-assembled SM83 programs run to completion; we assert exact end-state.
 * This verifies operand resolution, the stack, control flow, and MBC banking work
 * together — the semantics the recompiler must reproduce in WASM.
 *
 * Run: node --experimental-strip-types tests/cpu.test.ts
 */

import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(c: boolean, m: string) { if (c) pass++; else { fail++; failures.push(m); } }
function eq(a: number, b: number, m: string) { ok(a === b, `${m} (got 0x${a.toString(16)}, want 0x${b.toString(16)})`); }

/** Build a 64 KB-bank ROM (2 banks min) with `program` at 0x0150 and a valid-ish header. */
function makeRom(program: number[], opts: { mbc?: number; extra?: { at: number; bytes: number[] }[] } = {}): Uint8Array {
  const rom = new Uint8Array(0x8000); // 32 KB = 2 banks
  rom.fill(0x00);
  rom[0x0147] = opts.mbc ?? 0x13; // MBC3+RAM+BATTERY (pokered)
  rom[0x0148] = 0x00; // 32KB rom
  rom[0x0149] = 0x03; // 32KB ram
  program.forEach((b, i) => (rom[0x0150 + i] = b));
  for (const ex of opts.extra ?? []) ex.bytes.forEach((b, i) => (rom[ex.at + i] = b));
  return rom;
}

function run(program: number[], steps: number, opts?: any): CPU {
  const mmu = new MMU(makeRom(program, opts));
  const cpu = new CPU(mmu);
  cpu.pc = 0x0150;
  cpu.sp = 0xfffe;
  for (let i = 0; i < steps; i++) cpu.step();
  return cpu;
}

// ---- 1. Basic load + arithmetic ----------------------------------------------
{
  // LD A,0x10 ; LD B,0x05 ; ADD A,B  => A=0x15
  const cpu = run([0x3e, 0x10, 0x06, 0x05, 0x80], 3);
  eq(cpu.a, 0x15, "LD/ADD: A = 0x15");
  eq(cpu.b, 0x05, "B = 0x05");
}

// ---- 2. 16-bit load + memory store/load --------------------------------------
{
  // LD HL,0xC000 ; LD A,0x42 ; LD (HL),A ; LD A,0x00 ; LD A,(HL)  => A back to 0x42
  const cpu = run([0x21, 0x00, 0xc0, 0x3e, 0x42, 0x77, 0x3e, 0x00, 0x7e], 5);
  eq(cpu.a, 0x42, "store then reload through (HL) = 0x42");
  eq(cpu.hl, 0xc000, "HL = 0xC000");
}

// ---- 3. (HL+) post-increment -------------------------------------------------
{
  // LD HL,0xC000 ; LD A,0xAA ; LD (HL+),A ; LD (HL+),A  => HL advanced by 2, both bytes 0xAA
  const cpu = run([0x21, 0x00, 0xc0, 0x3e, 0xaa, 0x22, 0x22], 4);
  eq(cpu.hl, 0xc002, "(HL+) advanced HL to 0xC002");
  eq(cpu.mmu.read(0xc000), 0xaa, "C000 = 0xAA");
  eq(cpu.mmu.read(0xc001), 0xaa, "C001 = 0xAA");
}

// ---- 4. CALL / RET round trip ------------------------------------------------
{
  // At 0x0150: CALL 0x0160 ; (after ret) LD A,0x99 ; HALT
  // At 0x0160: LD A,0x11 ; RET
  const cpu = run(
    [0xcd, 0x60, 0x01, 0x3e, 0x99, 0x76],
    5,
    { extra: [{ at: 0x0160, bytes: [0x3e, 0x11, 0xc9] }] },
  );
  // sequence: CALL -> A=0x11 -> RET -> A=0x99 -> HALT
  eq(cpu.a, 0x99, "CALL/RET returned and continued: A=0x99");
  eq(cpu.sp, 0xfffe, "SP restored after CALL/RET");
}

// ---- 5. Conditional JR loop (count down) -------------------------------------
{
  // LD B,3 ; (loop) DEC B ; JR NZ,-3 ; HALT   => B ends 0
  // 0x0150: 06 03        LD B,3
  // 0x0152: 05           DEC B
  // 0x0153: 20 FD        JR NZ,-3  (back to 0x0152)
  // 0x0155: 76           HALT
  const cpu = run([0x06, 0x03, 0x05, 0x20, 0xfd, 0x76], 20);
  eq(cpu.b, 0x00, "JR NZ loop counted B down to 0");
  ok(cpu.halted, "reached HALT");
}

// ---- 6. PUSH/POP preserve & swap ---------------------------------------------
{
  // LD BC,0x1234 ; PUSH BC ; POP HL  => HL = 0x1234
  const cpu = run([0x01, 0x34, 0x12, 0xc5, 0xe1], 3);
  eq(cpu.hl, 0x1234, "PUSH BC / POP HL = 0x1234");
}

// ---- 7. Stack pointer + RST --------------------------------------------------
{
  // RST 0x28 pushes PC and jumps to 0x0028
  const cpu = run([0xef], 1); // RST 28H
  eq(cpu.pc, 0x0028, "RST 28H -> PC=0x0028");
  eq(cpu.sp, 0xfffc, "RST pushed 2 bytes (SP=0xFFFC)");
}

// ---- 8. MBC3 bank switching --------------------------------------------------
{
  // Put a marker byte in bank 1 at file offset 0x4000 (logical 0x4000 when bank1 mapped).
  // Default romBank is 1, so reading 0x4000 should already see bank-1 data.
  const rom = new Uint8Array(0x8000);
  rom[0x0147] = 0x13;
  rom[0x4000] = 0x5a; // bank 1, logical 0x4000
  const mmu = new MMU(rom);
  ok(mmu.mbc === "MBC3", "detected MBC3");
  eq(mmu.read(0x4000), 0x5a, "bank 1 visible at 0x4000 by default");
  // switch to bank 1 explicitly via 0x2000-0x3FFF write, re-read
  mmu.write(0x2000, 0x01);
  eq(mmu.currentRomBank, 0x01, "ROM bank register set to 1");
  // writing bank 0 maps to 1 (MBC3 quirk)
  mmu.write(0x2000, 0x00);
  eq(mmu.currentRomBank, 0x01, "bank 0 request remaps to 1");
}

// ---- 9. External RAM enable + read/write -------------------------------------
{
  const rom = new Uint8Array(0x8000);
  rom[0x0147] = 0x13; rom[0x0149] = 0x03;
  const mmu = new MMU(rom);
  // RAM disabled by default -> reads 0xFF
  eq(mmu.read(0xa000), 0xff, "ext RAM reads 0xFF when disabled");
  mmu.write(0x0000, 0x0a); // enable RAM
  mmu.write(0xa000, 0x77);
  eq(mmu.read(0xa000), 0x77, "ext RAM read/write after enable");
}

// ---- 10. Echo RAM mirror -----------------------------------------------------
{
  const rom = new Uint8Array(0x8000); rom[0x0147] = 0x13;
  const mmu = new MMU(rom);
  mmu.write(0xc000, 0x3c);
  eq(mmu.read(0xe000), 0x3c, "echo RAM mirrors WRAM (0xE000==0xC000)");
}

// ---- 11. XOR A idiom (clears A, sets Z) --------------------------------------
{
  const cpu = run([0x3e, 0xff, 0xaf], 2); // LD A,0xFF ; XOR A
  eq(cpu.a, 0x00, "XOR A clears A");
  ok((cpu.f & 0x80) !== 0, "XOR A sets Z");
}

// ---- 12. 16-bit INC wrapping -------------------------------------------------
{
  const cpu = run([0x01, 0xff, 0xff, 0x03], 2); // LD BC,0xFFFF ; INC BC
  eq(cpu.bc, 0x0000, "INC BC wraps 0xFFFF->0x0000");
}

console.log("");
console.log("================ PHASE 3: CPU + MMU ORACLE =============");
console.log(`  PASS: ${pass}`);
console.log(`  FAIL: ${fail}`);
if (fail > 0) {
  console.log("\n  Failures:");
  for (const f of failures.slice(0, 40)) console.log("   x " + f);
  console.log("========================================================\n");
  process.exit(1);
} else {
  console.log("  ALL GREEN ✓  (loads, ALU, stack, CALL/RET, JR loops, MBC3 banking)");
  console.log("========================================================\n");
}
