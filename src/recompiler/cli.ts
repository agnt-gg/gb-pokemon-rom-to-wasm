/**
 * Recompiler CLI.
 *
 *   node --experimental-strip-types src/recompiler/cli.ts <rom.gb> [--out build/] [--max N]
 *
 * Loads a ROM, discovers statically-reachable basic blocks from the standard entry
 * points (0x0100 entry + RST vectors + interrupt vectors), lifts them all to WAT,
 * assembles to game_logic.wasm via wabt, and writes a coverage report.
 *
 * IMPORTANT: this reads a ROM only to discover its control-flow graph and emit a
 * recompiled module of *your own* copy for *your own* use. The recompiler itself
 * contains no game data; it is a generic SM83->WASM lifter.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { MMU } from "../runtime/mmu.ts";
import { buildBlocks, buildModuleWat } from "./module.ts";
import { assembleWat } from "./assemble.ts";
import { disassembleRange, hex4 } from "./decoder.ts";

interface Args { rom: string; out: string; max: number; }
function parseArgs(argv: string[]): Args {
  const a: Args = { rom: "", out: "build", max: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--out") a.out = argv[++i]!;
    else if (v === "--max") a.max = parseInt(argv[++i]!, 10);
    else if (!a.rom) a.rom = v;
  }
  return a;
}

const STANDARD_ENTRIES = [
  0x0100, // ROM entry point (after the boot ROM hands off)
  0x0000, 0x0008, 0x0010, 0x0018, 0x0020, 0x0028, 0x0030, 0x0038, // RST vectors
  0x0040, 0x0048, 0x0050, 0x0058, 0x0060, // interrupt vectors (VBlank/STAT/Timer/Serial/Joypad)
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.rom) {
    console.error("usage: cli.ts <rom.gb> [--out build/] [--max N]");
    process.exit(2);
  }

  const rom = new Uint8Array(readFileSync(args.rom));
  const mmu = new MMU(rom);
  const mem = (addr: number) => mmu.read(addr);

  console.log("");
  console.log("================ GB-RECOMP : STATIC RECOMPILER =========");
  console.log(`  ROM file   : ${args.rom}`);
  console.log(`  Title      : ${mmu.romTitle()}`);
  console.log(`  Size       : ${(rom.length / 1024).toFixed(0)} KB  (${mmu.romBankCount} banks)`);
  console.log(`  MBC        : ${mmu.mbc}`);
  console.log("  --------------------------------------------------------");

  const t0 = Date.now();
  const blocks = buildBlocks(mem, STANDARD_ENTRIES, { maxBlocks: args.max });
  const liftMs = Date.now() - t0;

  let instrTotal = 0;
  for (const b of blocks.values()) instrTotal += b.instrCount;

  console.log(`  Blocks     : ${blocks.size} basic blocks lifted`);
  console.log(`  Instrs     : ${instrTotal} SM83 instructions recompiled`);
  console.log(`  Lift time  : ${liftMs} ms`);

  const wat = buildModuleWat(blocks);
  writeFileSync(`${args.out}/game_logic.wat`, wat);

  const t1 = Date.now();
  const bytes = await assembleWat(wat);
  const asmMs = Date.now() - t1;
  mkdirSync(args.out, { recursive: true });
  writeFileSync(`${args.out}/game_logic.wasm`, bytes);

  console.log(`  WAT        : ${(wat.length / 1024).toFixed(0)} KB -> ${args.out}/game_logic.wat`);
  console.log(`  WASM       : ${(bytes.length / 1024).toFixed(0)} KB -> ${args.out}/game_logic.wasm`);
  console.log(`  Assemble   : ${asmMs} ms (via wabt)`);

  // Opcode coverage over bank 0 (a representative sample of how much we decode cleanly).
  const sweep = disassembleRange(rom, 0x0150, Math.min(0x4000, rom.length), 0x0150);
  const seen = new Map<string, number>();
  let illegal = 0;
  for (const ins of sweep) {
    seen.set(ins.mnemonic, (seen.get(ins.mnemonic) ?? 0) + 1);
    if (ins.mnemonic === "ILLEGAL") illegal++;
  }
  const distinct = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  console.log("  --------------------------------------------------------");
  console.log(`  Bank-0 linear sweep: ${sweep.length} instrs, ${illegal} illegal-byte decodes`);
  console.log("  Top mnemonics: " + distinct.slice(0, 8).map(([m, n]) => `${m}:${n}`).join("  "));
  console.log("========================================================");
  console.log("");

  const report = {
    rom: args.rom,
    title: mmu.romTitle(),
    mbc: mmu.mbc,
    banks: mmu.romBankCount,
    blocks: blocks.size,
    instrsRecompiled: instrTotal,
    liftMs, asmMs,
    wasmBytes: bytes.length,
    entryBlock: `blk_${hex4(0x0100)}`,
  };
  writeFileSync(`${args.out}/recomp_report.json`, JSON.stringify(report, null, 2));
  console.log(`  report -> ${args.out}/recomp_report.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
