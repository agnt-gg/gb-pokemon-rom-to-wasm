/**
 * Phase 4 oracle: DIFFERENTIAL test — recompiled WASM must equal the reference interpreter.
 *
 * For each program we:
 *   1. run it on the pure interpreter (ground truth)
 *   2. lift it -> WAT -> real .wasm (via wabt), instantiate, run it
 *   3. assert identical final register state
 *
 * This is the anti-drift weapon: it proves the static recompilation preserves semantics.
 *
 * Run: node --experimental-strip-types tests/recomp.test.ts
 */

import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { buildBlocks, buildModuleWat } from "../src/recompiler/module.ts";
import { instantiateRecomp } from "../src/runtime/wasm_host.ts";
import { SENTINEL_HALT } from "../src/recompiler/lifter.ts";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(c: boolean, m: string) { if (c) pass++; else { fail++; failures.push(m); } }

function makeRom(program: number[], extra: { at: number; bytes: number[] }[] = []): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom[0x0147] = 0x13; rom[0x0149] = 0x03;
  program.forEach((b, i) => (rom[0x0150 + i] = b));
  for (const ex of extra) ex.bytes.forEach((b, i) => (rom[ex.at + i] = b));
  return rom;
}

function runInterp(program: number[], steps: number, extra?: any): CPU {
  const cpu = new CPU(new MMU(makeRom(program, extra)));
  cpu.pc = 0x0150; cpu.sp = 0xfffe;
  for (let i = 0; i < steps && !cpu.halted; i++) cpu.step();
  return cpu;
}

async function runRecomp(program: number[], extra?: any) {
  const mmu = new MMU(makeRom(program, extra));
  const mem = (a: number) => mmu.read(a);
  const blocks = buildBlocks(mem, [0x0150]);
  const wat = buildModuleWat(blocks);
  const inst = await instantiateRecomp(wat, mmu);
  inst.cpu.sp = 0xfffe;
  inst.exports.set_SP(0xfffe);
  inst.run(0x0150, 100000);
  return inst;
}

function diff(label: string, cpu: CPU, inst: any) {
  const regs = ["A", "F", "B", "C", "D", "E", "H", "L", "SP"] as const;
  for (const r of regs) {
    const want = (cpu as any)[r.toLowerCase()] & (r === "SP" ? 0xffff : 0xff);
    const gotRaw = inst.exports[`get_${r}`]();
    const got = gotRaw & (r === "SP" ? 0xffff : 0xff);
    const w = r === "F" ? want & 0xf0 : want;
    const g = r === "F" ? got & 0xf0 : got;
    ok(w === g, `${label}: reg ${r} interp=0x${w.toString(16)} wasm=0x${g.toString(16)}`);
  }
}

async function differential(label: string, program: number[], steps: number, extra?: any) {
  try {
    const cpu = runInterp(program, steps, extra);
    const inst = await runRecomp(program, extra);
    diff(label, cpu, inst);
  } catch (err) {
    ok(false, `${label}: threw ${(err as Error).message}`);
  }
}

const main = async () => {
  // 1. XOR A ; LD B,0x42 ; HALT
  await differential("xor+ld", [0xaf, 0x06, 0x42, 0x76], 10);

  // 2. LD A,0x10 ; LD C,0x05 ; LD B,A ; HALT  (reg-reg moves)
  await differential("reg moves", [0x3e, 0x10, 0x0e, 0x05, 0x47, 0x76], 10);

  // 3. memory store via (HL) then load: LD HL,0xC000 LD A,0x99 LD (HL),A LD A,0 LD A,(HL) HALT
  //    LD HL,d16 and LD A,(HL) route through interpreter; (HL),A is native.
  await differential("mem store/load", [0x21, 0x00, 0xc0, 0x3e, 0x99, 0x77, 0x3e, 0x00, 0x7e, 0x76], 12);

  // 4. Unconditional JP forward over a trap: JP 0x0155 ; LD A,0xFF(skipped) ; (0x0155) LD A,0x07 ; HALT
  await differential("jp forward", [0xc3, 0x55, 0x01, 0x3e, 0xff, 0x3e, 0x07, 0x76], 10);

  // 5. CALL/RET: CALL 0x0160 ; LD B,0x22 ; HALT  | 0x0160: LD A,0x33 ; RET
  await differential("call/ret", [0xcd, 0x60, 0x01, 0x06, 0x22, 0x76], 10,
    [{ at: 0x0160, bytes: [0x3e, 0x33, 0xc9] }]);

  // 6. Conditional JR loop: LD B,3 ; DEC B ; JR NZ,-3 ; HALT  (DEC routes to interp; JR native)
  await differential("jr nz loop", [0x06, 0x03, 0x05, 0x20, 0xfd, 0x76], 50);

  // 7. RST: RST 0x28 lands at 0x0028 -> (we put LD A,0x5A ; HALT there)
  await differential("rst28", [0xef], 6, [{ at: 0x0028, bytes: [0x3e, 0x5a, 0x76] }]);

  // 8. DI/EI don't corrupt regs: DI ; LD A,0x11 ; EI ; LD B,0x22 ; HALT
  await differential("di/ei", [0xf3, 0x3e, 0x11, 0xfb, 0x06, 0x22, 0x76], 10);

  // 9. Arithmetic chain through interp: LD A,0x0F ; ADD A,0x01 ; ADD A,0x10 ; HALT (=0x20, H from first)
  await differential("alu chain", [0x3e, 0x0f, 0xc6, 0x01, 0xc6, 0x10, 0x76], 10);

  // 10. PUSH/POP swap: LD BC,0x1234 ; PUSH BC ; POP HL ; HALT
  await differential("push/pop", [0x01, 0x34, 0x12, 0xc5, 0xe1, 0x76], 10);

  console.log("");
  console.log("================ PHASE 4: RECOMPILER DIFFERENTIAL ======");
  console.log(`  PASS: ${pass}`);
  console.log(`  FAIL: ${fail}`);
  if (fail > 0) {
    console.log("\n  Failures:");
    for (const f of failures.slice(0, 60)) console.log("   x " + f);
    console.log("========================================================\n");
    process.exit(1);
  } else {
    console.log("  ALL GREEN ✓  recompiled WASM == reference interpreter (10 programs)");
    console.log("  (SM83 assembly -> real .wasm via wabt, executed in V8)");
    console.log("========================================================\n");
  }
};

main();
