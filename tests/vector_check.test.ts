import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { buildBlocks } from "../src/recompiler/module.ts";

const rom = new Uint8Array(readFileSync(
  "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"
));
const mmu = new MMU(rom);
const mem = (a: number) => mmu.read(a);

// disasm each interrupt vector
console.log("Interrupt vectors:");
for (const v of [0x40, 0x48, 0x50, 0x58, 0x60]) {
  let a = v; let s = `  0x${v.toString(16)}: `;
  for (let i = 0; i < 3; i++) {
    const ins = decode(new Uint8Array([mmu.read(a), mmu.read(a+1), mmu.read(a+2)]), 0, a);
    s += ins.text + "  |  "; a += ins.length;
  }
  console.log(s);
}

// Are the vectors in the lifted block set?
const entries = [0x0100, 0x0150, 0x0000, 0x0008, 0x0010, 0x0018, 0x0020, 0x0028, 0x0030, 0x0038, 0x0040, 0x0048, 0x0050, 0x0058, 0x0060];
const blocks = buildBlocks(mem, entries, { maxBlocks: 20000 });
console.log("\nVectors present as lifted blocks?");
for (const v of [0x40, 0x48, 0x50, 0x58, 0x60]) console.log(`  0x${v.toString(16)}: ${blocks.has(v) ? "YES" : "NO"}`);

// Check the VBlank handler target (whatever 0x40 jumps to)
const ins40 = decode(new Uint8Array([mmu.read(0x40), mmu.read(0x41), mmu.read(0x42)]), 0, 0x40);
console.log("\n0x40 decoded:", ins40.text, "staticTargets:", (ins40 as any).staticTargets);
