/** Catch the exact instruction where the INTERPRETER (with interrupts+PPU) derails to 0x38. */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { Joypad } from "../src/runtime/joypad.ts";
import { decode } from "../src/recompiler/decoder.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu=new CPU(mmu); const ppu=new PPU(mmu); const timer=new Timer(mmu); new Joypad(mmu);
cpu.a=1;cpu.f=0xb0;cpu.b=0;cpu.c=0x13;cpu.d=0;cpu.e=0xd8;cpu.h=1;cpu.l=0x4d;cpu.sp=0xfffe;cpu.pc=0x100;
mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);

const trail:string[]=[];
let irqCount=0;
let prevPC=0x100;
for(let i=0;i<2_000_000;i++){
  const imeBefore=(cpu as any).ime;
  const ic=cpu.serviceInterrupts();
  if(ic>0){ppu.step(ic);timer.step(ic);irqCount++; trail.push(`  >>> IRQ #${irqCount} serviced, pushed 0x${prevPC.toString(16)}, jumped to vector 0x${(cpu.pc&0xffff).toString(16)}, SP=0x${cpu.sp.toString(16)}`); if(trail.length>40)trail.shift();}
  const pc=cpu.pc&0xffff;
  if(pc===0x0038){
    console.log(`INTERP derailed to 0x0038 at step ${i} (after ${irqCount} IRQs). Trail:`);
    for(const t of trail) console.log(t);
    break;
  }
  const ins=decode(new Uint8Array([mmu.read(pc),mmu.read(pc+1),mmu.read(pc+2)]),0,pc);
  trail.push(`0x${pc.toString(16).padStart(4,"0")} ${ins.text.padEnd(16)} A=${cpu.a.toString(16)} BC=${(cpu.b<<8|cpu.c).toString(16)} DE=${(cpu.d<<8|cpu.e).toString(16)} HL=${(cpu.h<<8|cpu.l).toString(16)} SP=${cpu.sp.toString(16)} IME=${(cpu as any).ime?1:0}`);
  if(trail.length>40)trail.shift();
  prevPC=pc;
  const b=cpu.cycles; cpu.step(); const d=cpu.cycles-b; ppu.step(d); timer.step(d);
}
