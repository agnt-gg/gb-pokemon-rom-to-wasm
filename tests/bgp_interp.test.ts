/** Trace BGP writes in the INTERPRETER, with the PC that wrote each, to find the routine. */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { Joypad } from "../src/runtime/joypad.ts";

const mmu:any = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu=new CPU(mmu); const ppu=new PPU(mmu); const timer=new Timer(mmu); new Joypad(mmu);
cpu.a=1;cpu.f=0xb0;cpu.b=0;cpu.c=0x13;cpu.d=0;cpu.e=0xd8;cpu.h=1;cpu.l=0x4d;cpu.sp=0xfffe;cpu.pc=0x100;
mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);
const realWrite=mmu.write.bind(mmu);
const writes:string[]=[];
mmu.write=(a:number,v:number)=>{a&=0xffff; if(a===0xff47){const s=`pc=0x${(cpu.pc&0xffff).toString(16)} BGP<-0x${(v&0xff).toString(16)}`; if(writes.length<30&&writes[writes.length-1]!==s)writes.push(s);} return realWrite(a,v);};
for(let f=0;f<120;f++){const s=cpu.cycles;let g=0;while(cpu.cycles-s<70224&&g++<2e6){const ic=cpu.serviceInterrupts();if(ic>0){ppu.step(ic);timer.step(ic);}const b=cpu.cycles;cpu.step();const d=cpu.cycles-b;ppu.step(d);timer.step(d);}}
console.log("INTERP BGP writes:");
for(const w of writes) console.log("  "+w);
console.log("final BGP=0x"+mmu.rawIoRead(0xff47).toString(16));
