import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { decode } from "../src/recompiler/decoder.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
// Note: 0x5876 is in bank NN (0x4000-0x7FFF). The recompiler decodes it from the static
// ROM image assuming a bank mapping. Show what's at file offset for bank as-currently-mapped.
console.log("MBC bank state irrelevant for static decode; decoding logical 0x5876:");
let a = 0x5876;
for (let i = 0; i < 20; i++) {
  const b0=mmu.read(a),b1=mmu.read(a+1),b2=mmu.read(a+2);
  const ins = decode(new Uint8Array([b0,b1,b2]),0,a);
  console.log(`  0x${a.toString(16)}: ${ins.text.padEnd(16)} [${b0.toString(16).padStart(2,"0")} ${b1.toString(16).padStart(2,"0")} ${b2.toString(16).padStart(2,"0")}] term=${ins.isTerminator} tgts=${JSON.stringify((ins as any).staticTargets||[])}`);
  if (ins.isTerminator) break;
  a += ins.length;
}
