/** Run interp and hybrid frame-by-frame; after each frame compare full memory snapshot.
 *  Report the FIRST frame where WRAM/HRAM/IO diverge, and dump the diffs. */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { Joypad } from "../src/runtime/joypad.ts";
import { BrowserMachine } from "../src/browser/host_browser.ts";

const romPath = "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";
const rom = new Uint8Array(readFileSync(romPath));
const mI=new MMU(new Uint8Array(rom)); const cI=new CPU(mI); const pI=new PPU(mI); const tI=new Timer(mI); new Joypad(mI);
cI.a=1;cI.f=0xb0;cI.b=0;cI.c=0x13;cI.d=0;cI.e=0xd8;cI.h=1;cI.l=0x4d;cI.sp=0xfffe;cI.pc=0x100;
mI.rawIoWrite(0xff40,0x91);mI.rawIoWrite(0xff47,0xfc);
const frameI=()=>{const s=cI.cycles;let g=0;while(cI.cycles-s<70224&&g++<2e6){const ic=cI.serviceInterrupts();if(ic>0){pI.step(ic);tI.step(ic);}const b=cI.cycles;cI.step();const d=cI.cycles-b;pI.step(d);tI.step(d);}};

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const m = await BrowserMachine.create(wasm, new Uint8Array(rom)); const mH=m.mmu;

function snap(mmu:any){const a=new Uint8Array(0x2000+0x80); for(let i=0;i<0x2000;i++)a[i]=mmu.read(0xc000+i); for(let i=0;i<0x80;i++)a[0x2000+i]=mmu.read(0xff80+i); return a;}
for(let f=0;f<120;f++){
  frameI(); m.runFrame();
  const sI=snap(mI), sH=snap(mH);
  let diffs:number[]=[]; for(let i=0;i<sI.length;i++) if(sI[i]!==sH[i]) diffs.push(i);
  if(diffs.length>0){
    console.log(`First memory divergence at frame ${f}: ${diffs.length} bytes differ`);
    for(const i of diffs.slice(0,24)){const addr=i<0x2000?0xc000+i:0xff80+(i-0x2000);console.log(`  0x${addr.toString(16)}: interp=0x${sI[i].toString(16)} hybrid=0x${sH[i].toString(16)}`);}
    console.log("interp PC=0x"+(cI.pc&0xffff).toString(16)+" hybrid PC=0x"+((m.exports as any).get_PC()&0xffff).toString(16));
    break;
  }
  if(f===119) console.log("No memory divergence in 120 frames!");
}
