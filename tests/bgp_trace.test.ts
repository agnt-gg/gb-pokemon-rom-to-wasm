import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";
const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const m = await BrowserMachine.create(wasm, rom);
const mmu:any = m.mmu;
// hook writes to FF47 / FF42/FF43 (scroll) / VRAM tilemap region
const realWrite = mmu.write.bind(mmu);
const bgpWrites:string[]=[]; let vramWrites=0, tilemapWrites=0;
mmu.write = (a:number,v:number)=>{ a&=0xffff;
  if(a===0xff47 && bgpWrites.length<10) bgpWrites.push(`BGP<-0x${(v&0xff).toString(16)}`);
  if(a>=0x8000&&a<0x9800) vramWrites++;
  if(a>=0x9800&&a<0xa000) tilemapWrites++;
  return realWrite(a,v);
};
for(let f=0;f<120;f++) m.runFrame();
console.log("BGP writes:", bgpWrites.length?bgpWrites.join(", "):"NONE");
console.log("VRAM tile writes:", vramWrites, " tilemap writes:", tilemapWrites);
console.log("final BGP=0x"+mmu.rawIoRead(0xff47).toString(16)+" LCDC=0x"+mmu.rawIoRead(0xff40).toString(16));
let nw=0;const fb=m.framebuffer;for(let p=0;p<fb.length;p+=4)if(!(fb[p]===0xe0&&fb[p+1]===0xf8&&fb[p+2]===0xd0))nw++;
console.log("nonWhite="+nw);
// Sample VRAM tilemap 0x9800
let nz=0; for(let a=0x9800;a<0x9c00;a++) if(mmu.read(a)!==0)nz++;
console.log("nonzero tilemap entries (0x9800-0x9BFF):", nz+"/1024");
