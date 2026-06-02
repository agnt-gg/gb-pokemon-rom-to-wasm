/** In BOTH engines, find the PC that writes 0xc0b6 and what value/count, at frame 10. */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { Joypad } from "../src/runtime/joypad.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { BrowserMachine } from "../src/browser/host_browser.ts";

const romPath = "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";
const rom = new Uint8Array(readFileSync(romPath));

function runInterp(){
  const mmu:any=new MMU(new Uint8Array(rom));const cpu=new CPU(mmu);const ppu=new PPU(mmu);const timer=new Timer(mmu);new Joypad(mmu);
  cpu.a=1;cpu.f=0xb0;cpu.b=0;cpu.c=0x13;cpu.d=0;cpu.e=0xd8;cpu.h=1;cpu.l=0x4d;cpu.sp=0xfffe;cpu.pc=0x100;
  mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);
  const realW=mmu.write.bind(mmu);const log:string[]=[];
  mmu.write=(a:number,v:number)=>{a&=0xffff; if(a===0xc0b6&&log.length<5)log.push(`pc=0x${(cpu.pc&0xffff).toString(16)} <-0x${(v&0xff).toString(16)}`); return realW(a,v);};
  for(let f=0;f<11;f++){const s=cpu.cycles;let g=0;while(cpu.cycles-s<70224&&g++<2e6){const ic=cpu.serviceInterrupts();if(ic>0){ppu.step(ic);timer.step(ic);}const b=cpu.cycles;cpu.step();const d=cpu.cycles-b;ppu.step(d);timer.step(d);}}
  return log;
}
console.log("INTERP writes to 0xc0b6:", runInterp().join("  ")||"NONE (stays 0)");

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const m = await BrowserMachine.create(wasm, new Uint8Array(rom));
const cpu=m.cpu; const mmu:any=m.mmu;
const realW=mmu.write.bind(mmu);const log:string[]=[];
mmu.write=(a:number,v:number)=>{a&=0xffff; if(a===0xc0b6&&log.length<5)log.push(`cpuPC=0x${(cpu.pc&0xffff).toString(16)} wasmPC=0x${((m.exports as any).get_PC()&0xffff).toString(16)} <-0x${(v&0xff).toString(16)}`); return realW(a,v);};
for(let f=0;f<11;f++) m.runFrame();
console.log("HYBRID writes to 0xc0b6:", log.join("  ")||"NONE");
console.log("\nhybrid c0b6 final=0x"+mmu.read(0xc0b6).toString(16)+" interp would be 0x00");
