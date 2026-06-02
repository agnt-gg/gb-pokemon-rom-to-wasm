import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";
const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const m = await BrowserMachine.create(wasm, rom);
const cpu=m.cpu;
// instrument cpu.step to record region visits (since bank window is interpreted via cpu.step)
const realStep=cpu.step.bind(cpu);
const regions:Record<string,number>={};
let saw589b=false, saw5800region=0;
(cpu as any).step=()=>{const pc=cpu.pc&0xffff; if(pc>=0x5800&&pc<0x5900){saw5800region++; if(pc===0x589b)saw589b=true;} return realStep();};
for(let f=0;f<200;f++) m.runFrame();
console.log("hybrid visits to 0x5800-0x58FF (interpreted):", saw5800region);
console.log("reached 0x589b (BGP=0xe4 write):", saw589b);
console.log("final BGP=0x"+m.mmu.rawIoRead(0xff47).toString(16));
console.log("PC=0x"+((m.exports as any).get_PC()&0xffff).toString(16));
