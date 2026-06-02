import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { decode } from "../src/recompiler/decoder.ts";
const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
function dis(start:number,n:number,label:string){console.log(`\n=== ${label} (0x${start.toString(16)}) ===`);let a=start;for(let i=0;i<n;i++){const ins=decode(new Uint8Array([mmu.read(a),mmu.read(a+1),mmu.read(a+2)]),0,a);console.log(`  0x${a.toString(16)}: ${ins.text} [${mmu.read(a).toString(16).padStart(2,"0")}]`);a+=ins.length;}}
dis(0x1de1, 30, "sub 0x1DE1");
dis(0x1d01, 16, "sub 0x1D01");
// search for any LDH (00),A or write to FF80 region pattern: e0 80? no. The routine writes
// bytes then jumps. Look for 'ld a,$3e' style. Actually search for the DMA opcode 0xE0 0x46 (LDH (46),A) which IS the DMA trigger inside the HRAM routine.
console.log("\n=== search bank0 for hram-dma routine source (F5 E0 46 3E 28 3D 20 FD F1 D9 = push af;ldh(46),a;ld a,28;dec a;jr nz;pop af;reti) ===");
for(let a=0x100;a<0x4000;a++){
  if(mmu.read(a)===0xf5 && mmu.read(a+1)===0xe0 && mmu.read(a+2)===0x46){console.log("  DMA routine source at 0x"+a.toString(16));dis(a,8,"dma src");}
}
