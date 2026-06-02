/**
 * Does the PURE interpreter populate HRAM (0xFF80+) with the OAM-DMA routine and run it
 * correctly? If yes, the hybrid's empty HRAM proves a write/copy was lost at the seam.
 * We run the oracle ~20k instrs (with PPU) and dump HRAM + count how often PC is in HRAM.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu=new CPU(mmu); const ppu=new PPU(mmu); const timer=new Timer(mmu);
cpu.a=1;cpu.f=0xb0;cpu.b=0;cpu.c=0x13;cpu.d=0;cpu.e=0xd8;cpu.h=1;cpu.l=0x4d;cpu.sp=0xfffe;cpu.pc=0x100;
mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);

let hramExec=0, firstHram=-1;
for(let i=0;i<3_000_000;i++){
  const pc=cpu.pc&0xffff;
  if(pc>=0xff80&&pc<=0xfffe){hramExec++; if(firstHram<0){firstHram=i; console.log("oracle first HRAM exec at step "+i+", PC=0x"+pc.toString(16));}}
  const b=cpu.cycles; cpu.step(); ppu.step(cpu.cycles-b); timer.step(cpu.cycles-b);
}
console.log("HRAM dump after 3M steps:");
for(let r=0xff80;r<0xffff;r+=16){let line="  0x"+r.toString(16)+": ";for(let c=0;c<16;c++)line+=mmu.read(r+c).toString(16).padStart(2,"0")+" ";console.log(line);}
console.log("hramExec count:", hramExec);
