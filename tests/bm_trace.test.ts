/**
 * Trace BrowserMachine itself (the real class). Catch when PC first enters 0x0038 and dump
 * the last 30 (pc, sp) it dispatched, plus whether the forward-progress guard fired.
 */
import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const m = await BrowserMachine.create(wasm, rom);

// monkey-patch the exports.run to record a trail
const ex:any = m.exports;
const realRun = ex.run.bind(ex);
const trail:string[]=[];
let crashed=false;
ex.run = (pc:number) => {
  if((pc&0xffff)===0x0038 && !crashed){
    crashed=true;
    console.log("BrowserMachine entered 0x0038. Last 30 dispatches:");
    for(const t of trail) console.log("  "+t);
  }
  trail.push(`pc=0x${(pc&0xffff).toString(16).padStart(4,"0")} SP=0x${(ex.get_SP()&0xffff).toString(16)} A=0x${ex.get_A().toString(16)} F=0x${(ex.get_F()&0xff).toString(16)}`);
  if(trail.length>30)trail.shift();
  return realRun(pc);
};

for(let i=0;i<80 && !crashed;i++) m.runFrame();
if(!crashed) console.log("No crash in 80 frames! LCDC=0x"+m.mmu.rawIoRead(0xff40).toString(16)+" frames="+m.frames);
