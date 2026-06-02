import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { decode } from "../src/recompiler/decoder.ts";
const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
let a=0x20a0;
console.log("disasm around 0x20af:");
for(let i=0;i<30;i++){const ins=decode(new Uint8Array([mmu.read(a),mmu.read(a+1),mmu.read(a+2)]),0,a);console.log(`  0x${a.toString(16)}: ${ins.text} [${mmu.read(a).toString(16)}]${ins.isTerminator?" *TERM*":""}`);a+=ins.length;}
