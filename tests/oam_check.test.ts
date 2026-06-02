/** Is OAM populated after boot in the hybrid? And does anything write to FF46? */
import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";
const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const m = await BrowserMachine.create(wasm, rom);
const mmu:any = m.mmu;
const realW = mmu.write.bind(mmu);
let ff46Writes = 0; const ff46vals:number[]=[];
mmu.write = (a:number,v:number)=>{ a&=0xffff; if(a===0xff46){ff46Writes++; if(ff46vals.length<6)ff46vals.push(v&0xff);} return realW(a,v); };
for(let f=0;f<300;f++) m.runFrame();
const oam = mmu.getOam();
let nonZero=0; for(let i=0;i<oam.length;i++) if(oam[i]!==0)nonZero++;
console.log("FF46 (OAM DMA) writes:", ff46Writes, "vals:", ff46vals.map(v=>"0x"+v.toString(16)).join(","));
console.log("OAM non-zero bytes:", nonZero+"/160");
console.log("first 16 OAM bytes:", Array.from(oam.slice(0,16)).map(v=>v.toString(16).padStart(2,"0")).join(" "));
console.log("LCDC=0x"+mmu.rawIoRead(0xff40).toString(16)+" (bit1 OBJ enable="+((mmu.rawIoRead(0xff40)&2)?1:0)+")");
