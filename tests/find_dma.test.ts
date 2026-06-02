/** Disasm 0x1E02, 0x1E5E, 0x1EBE, and 0x2040-0x2055 to find the HRAM copy routine. */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { decode } from "../src/recompiler/decoder.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
function dis(start:number,n:number,label:string){
  console.log(`\n=== ${label} (0x${start.toString(16)}) ===`);
  let a=start;
  for(let i=0;i<n;i++){const ins=decode(new Uint8Array([mmu.read(a),mmu.read(a+1),mmu.read(a+2)]),0,a);console.log(`  0x${a.toString(16)}: ${ins.text} [${mmu.read(a).toString(16).padStart(2,"0")}]`);if(ins.isTerminator&&i>0&&ins.text.startsWith("RET"))break;a+=ins.length;}
}
dis(0x2040, 12, "boot init calls");
dis(0x1e02, 20, "sub 0x1E02");
dis(0x1e5e, 20, "sub 0x1E5E");
dis(0x1ebe, 24, "sub 0x1EBE");
// The classic DMA routine source in Pokemon Red is at 0x???? labeled "WriteDMACodeToHRAM".
// It does: ld c,$80; ... copy 0xA bytes to 0xFF80. Search ROM bank0 for the signature:
// 21 ?? ?? 0E 80 06 0A (ld hl,src; ld c,$80; ld b,$0A)
console.log("\n=== searching bank0 for DMA-copy signature (0e 80 06 0a) ===");
for(let a=0x100;a<0x4000;a++){
  if(mmu.read(a)===0x0e && mmu.read(a+1)===0x80 && mmu.read(a+2)===0x06 && mmu.read(a+3)===0x0a){
    console.log("  found at 0x"+a.toString(16)); dis(a-3, 14, "DMA copy @0x"+(a-3).toString(16));
  }
}
