import { readFileSync, writeFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { buildBlocks, buildModuleWat } from "../src/recompiler/module.ts";
import { assembleWat } from "../src/recompiler/assemble.ts";

const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const mmu = new MMU(rom);
const mem = (a: number) => mmu.read(a);
const STANDARD_ENTRIES = [0x0100, 0x0150, 0x0000, 0x0008, 0x0010, 0x0018, 0x0020, 0x0028, 0x0030, 0x0038, 0x0040, 0x0048, 0x0050, 0x0058, 0x0060];
const t0 = Date.now();
const blocks = buildBlocks(mem, STANDARD_ENTRIES, { maxBlocks: 20000 });
const wat = buildModuleWat(blocks);
const wasm = await assembleWat(wat);
writeFileSync("build/served.wasm", wasm);
console.log(`Regenerated build/served.wasm: ${blocks.size} blocks -> ${(wasm.length/1024).toFixed(0)}KB in ${Date.now()-t0}ms`);
