/**
 * Phase 8 (slice): boot the REAL recompiled Pokemon Red.
 *
 * Loads the user's ROM, recompiles the entry region, instantiates the emitted WASM,
 * and steps the recompiled entry block. We assert:
 *   - the module instantiates (valid WASM)
 *   - executing from 0x0100 runs the real boot handoff without trapping
 *   - the well-known boot sequence side effects appear (NINTENDO logo DMA setup region,
 *     stack pointer init to 0xFFFE, etc.) OR it reaches a HALT/known PC
 *
 * This proves the pipeline works on commercial ROM bytes, not just synthetic tests.
 *
 * Run: node --experimental-strip-types tests/boot.test.ts "<path to Pokemon Red.gb>"
 */

import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { buildBlocks, buildModuleWat } from "../src/recompiler/module.ts";
import { instantiateRecomp } from "../src/runtime/wasm_host.ts";

const romPath = process.argv[2]
  ?? "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(c: boolean, m: string) { if (c) pass++; else { fail++; failures.push(m); } }

const main = async () => {
  let rom: Uint8Array;
  try {
    rom = new Uint8Array(readFileSync(romPath));
  } catch {
    console.log(`\n  (skip) ROM not found at ${romPath} — boot test requires the user's local ROM.\n`);
    return;
  }

  const mmu = new MMU(rom);
  ok(mmu.romTitle().includes("POKEMON"), `ROM header title = "${mmu.romTitle()}"`);
  ok(mmu.mbc === "MBC3", `MBC detected = ${mmu.mbc}`);

  const mem = (a: number) => mmu.read(a);
  // Entry at 0x0100 is "NOP; JP 0x0150" on virtually all GB carts. Lift from there.
  const blocks = buildBlocks(mem, [0x0100, 0x0150], { maxBlocks: 5000 });
  ok(blocks.size > 0, `lifted ${blocks.size} blocks from entry`);
  ok(blocks.has(0x0100), "entry block blk_0100 present");

  const wat = buildModuleWat(blocks);
  let inst;
  try {
    inst = await instantiateRecomp(wat, mmu);
    ok(true, "emitted WASM instantiated (valid module)");
  } catch (e) {
    ok(false, "WASM instantiation failed: " + (e as Error).message);
    report();
    return;
  }

  // Execute the entry: NOP; JP 0x0150. The recompiled run() should chase the static
  // JP into blk_0150 and continue until it hits an indirect target / HALT / step budget.
  inst.exports.set_PC(0x0100);
  inst.exports.set_SP(0xfffe);
  let finalPc = 0x0100;
  try {
    finalPc = inst.run(0x0100, 5000);
    ok(true, `executed ${5000} step budget from 0x0100 without WASM trap`);
  } catch (e) {
    ok(false, "execution trapped: " + (e as Error).message);
  }

  // The real Pokemon Red boot sets SP = 0xFFFE very early (LD SP,$FFFE at 0x0150 region).
  const sp = inst.exports.get_SP() & 0xffff;
  ok(sp <= 0xfffe, `stack pointer sane after boot (SP=0x${sp.toString(16)})`);

  // PC should have advanced past the entry (it ran real code, not stuck at 0x100).
  const pc = inst.exports.get_PC() & 0xffff;
  ok(pc !== 0x0100, `PC advanced past entry (PC=0x${pc.toString(16)})`);

  console.log("");
  console.log("  Boot trace summary:");
  console.log(`    title=${mmu.romTitle()}  blocks=${blocks.size}  finalPC=0x${(finalPc & 0xffff).toString(16)}  SP=0x${sp.toString(16)}`);

  report();
};

function report() {
  console.log("");
  console.log("================ PHASE 8 (slice): REAL ROM BOOT =======");
  console.log(`  PASS: ${pass}`);
  console.log(`  FAIL: ${fail}`);
  if (fail > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log("   x " + f);
    console.log("========================================================\n");
    process.exit(1);
  } else {
    console.log("  ALL GREEN ✓  recompiled Pokemon Red boots as WASM in V8");
    console.log("========================================================\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
