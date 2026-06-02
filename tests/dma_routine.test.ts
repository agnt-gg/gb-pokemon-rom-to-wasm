import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { decode } from "../src/recompiler/decoder.ts";
const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
console.log("=== copy loop 0x4bf0 ===");
let a=0x4bf0; for(let i=0;i<16;i++){const ins=decode(new Uint8Array([mmu.read(a),mmu.read(a+1),mmu.read(a+2)]),0,a);console.log(`  0x${a.toString(16)}: ${ins.text} [${mmu.read(a).toString(16)}]`);a+=ins.length;}
console.log("\n=== 0x5870 (where it jumped, bank-dependent!) ===");
a=0x5870; for(let i=0;i<14;i++){const ins=decode(new Uint8Array([mmu.read(a),mmu.read(a+1),mmu.read(a+2)]),0,a);console.log(`  0x${a.toString(16)}: ${ins.text} [${mmu.read(a).toString(16)}]`);a+=ins.length;}
// what's at 0x5876 in each bank?
console.log("\nbytes at 0x5876 (current bank0-mapped view):", [0,1,2,3].map(i=>mmu.read(0x5876+i).toString(16)).join(" "));
