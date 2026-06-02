/** Trace the hybrid's path into 0x5a8b: record the block-entry sequence right before cpu reaches
 *  0x5a00-0x5b00 the first time, to find the wrong branch/call. */
import { readFileSync } from "node:fs";
import { decode } from "../src/recompiler/decoder.ts";
import { BrowserMachine } from "../src/browser/host_browser.ts";

const romPath = "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";
const rom = new Uint8Array(readFileSync(romPath));
const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const m = await BrowserMachine.create(wasm, new Uint8Array(rom));
const cpu=m.cpu; const mmu=m.mmu;
const realStep=cpu.step.bind(cpu);
const trail:string[]=[]; let done=false;
(cpu as any).step=()=>{
  const pc=cpu.pc&0xffff;
  if(!done){ const last=trail[trail.length-1]; const e=`0x${pc.toString(16)} A=${cpu.a.toString(16)} BC=${(cpu.b<<8|cpu.c).toString(16)} DE=${(cpu.d<<8|cpu.e).toString(16)} HL=${(cpu.h<<8|cpu.l).toString(16)}`; if(last!==e){trail.push(e); if(trail.length>40)trail.shift();}
    if(pc>=0x5a00&&pc<0x5b00){ done=true; console.log("Hybrid reached 0x"+pc.toString(16)+". Path (interpreted-instr trail):"); for(const t of trail)console.log("  "+t); }
  }
  return realStep();
};
for(let f=0;f<11&&!done;f++) m.runFrame();
if(!done) console.log("did not reach 0x5a00 region in 11 frames");
// also note what bank is mapped
console.log("\nROM bank mapped (read of 0x2000-area via MMU bank reg):");
