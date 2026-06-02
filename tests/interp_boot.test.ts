/** Does the PURE interpreter boot Pokemon Red to a real screen? Run ~60 frames worth of
 *  cycles, driving PPU+timer+interrupts properly, then render the framebuffer as ASCII. */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU, SCREEN_W, SCREEN_H } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { Joypad } from "../src/runtime/joypad.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu=new CPU(mmu); const ppu=new PPU(mmu); const timer=new Timer(mmu); new Joypad(mmu);
cpu.a=1;cpu.f=0xb0;cpu.b=0;cpu.c=0x13;cpu.d=0;cpu.e=0xd8;cpu.h=1;cpu.l=0x4d;cpu.sp=0xfffe;cpu.pc=0x100;
mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);

const CYC=70224;
for(let f=0;f<200;f++){
  const start=cpu.cycles;
  let g=0;
  while(cpu.cycles-start<CYC && g++<2_000_000){
    const ic=cpu.serviceInterrupts(); if(ic>0){ppu.step(ic);timer.step(ic);}
    const b=cpu.cycles; cpu.step(); const d=cpu.cycles-b; ppu.step(d); timer.step(d);
  }
  if(f===20||f===60||f===120||f===199){
    let nonWhite=0; const fb=ppu.framebuffer;
    for(let p=0;p<fb.length;p+=4) if(!(fb[p]===0xe0&&fb[p+1]===0xf8&&fb[p+2]===0xd0)) nonWhite++;
    console.log(`frame ${f}: PC=0x${(cpu.pc&0xffff).toString(16)} LCDC=0x${mmu.rawIoRead(0xff40).toString(16)} LY=${mmu.rawIoRead(0xff44)} IME=${(cpu as any).ime?1:0} nonWhite=${nonWhite}`);
  }
}
// render final
const fb=ppu.framebuffer; const ramp=" .:-=+*#%@";
console.log("\nFinal screen (interpreter):");
for(let y=0;y<SCREEN_H;y+=4){let line="  ";for(let x=0;x<SCREEN_W;x+=2){const o=(y*SCREEN_W+x)*4;const lum=(fb[o]!+fb[o+1]!+fb[o+2]!)/3;line+=ramp[Math.min(9,Math.floor((255-lum)/255*9))];}console.log(line);}
