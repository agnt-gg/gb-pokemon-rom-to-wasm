/** Run interpreter and hybrid each ~80 frames, then diff WRAM+HRAM+key IO to find where the
 *  hybrid's MEMORY state actually differs (the real functional gap, not loop phase). */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { Joypad } from "../src/runtime/joypad.ts";
import { BrowserMachine } from "../src/browser/host_browser.ts";

const romPath = "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";
const rom = new Uint8Array(readFileSync(romPath));
const FRAMES = 80;

// interpreter
const mI=new MMU(new Uint8Array(rom)); const cI=new CPU(mI); const pI=new PPU(mI); const tI=new Timer(mI); new Joypad(mI);
cI.a=1;cI.f=0xb0;cI.b=0;cI.c=0x13;cI.d=0;cI.e=0xd8;cI.h=1;cI.l=0x4d;cI.sp=0xfffe;cI.pc=0x100;
mI.rawIoWrite(0xff40,0x91);mI.rawIoWrite(0xff47,0xfc);
for(let f=0;f<FRAMES;f++){const s=cI.cycles;let g=0;while(cI.cycles-s<70224&&g++<2e6){const ic=cI.serviceInterrupts();if(ic>0){pI.step(ic);tI.step(ic);}const b=cI.cycles;cI.step();const d=cI.cycles-b;pI.step(d);tI.step(d);}}

// hybrid
const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const m = await BrowserMachine.create(wasm, new Uint8Array(rom));
for(let f=0;f<FRAMES;f++) m.runFrame();
const mH = m.mmu;

// diff WRAM C000-DFFF
let wramDiffs=0, firstDiffs:string[]=[];
for(let a=0xc000;a<0xe000;a++){ if(mI.read(a)!==mH.read(a)){wramDiffs++; if(firstDiffs.length<20)firstDiffs.push(`0x${a.toString(16)}: interp=0x${mI.read(a).toString(16)} hybrid=0x${mH.read(a).toString(16)}`);} }
console.log(`WRAM diffs: ${wramDiffs}/8192`);
for(const d of firstDiffs) console.log("  "+d);
// HRAM
let hramDiffs=0;
for(let a=0xff80;a<0xffff;a++){ if(mI.read(a)!==mH.read(a)){hramDiffs++; console.log(`  HRAM 0x${a.toString(16)}: interp=0x${mI.read(a).toString(16)} hybrid=0x${mH.read(a).toString(16)}`);} }
console.log(`HRAM diffs: ${hramDiffs}`);
// key IO
for(const a of [0xff40,0xff41,0xff42,0xff43,0xff44,0xff47,0xff0f,0xffff]) console.log(`  IO 0x${a.toString(16)}: interp=0x${mI.rawIoRead(a).toString(16)} hybrid=0x${mH.rawIoRead(a).toString(16)}`);
console.log(`\ninterp PC=0x${(cI.pc&0xffff).toString(16)}  hybrid PC=0x${(m.exports as any).get_PC().toString(16)}`);
