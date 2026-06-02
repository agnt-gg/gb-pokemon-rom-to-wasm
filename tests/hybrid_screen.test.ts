import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";
const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const m = await BrowserMachine.create(wasm, rom);
const ex:any=m.exports;
for(let f=0;f<600;f++){
  m.runFrame();
  if(f%100===99||f===30){
    let nw=0; const fb=m.framebuffer; for(let p=0;p<fb.length;p+=4) if(!(fb[p]===0xe0&&fb[p+1]===0xf8&&fb[p+2]===0xd0))nw++;
    console.log(`frame ${f}: PC=0x${(ex.get_PC()&0xffff).toString(16)} LCDC=0x${m.mmu.rawIoRead(0xff40).toString(16)} LY=${m.mmu.rawIoRead(0xff44)} nonWhite=${nw}`);
  }
}
const fb=m.framebuffer; const ramp=" .:-=+*#%@";
console.log("\nHYBRID screen @ frame 600:");
for(let y=0;y<144;y+=4){let line="  ";for(let x=0;x<160;x+=2){const o=(y*160+x)*4;const lum=(fb[o]!+fb[o+1]!+fb[o+2]!)/3;line+=ramp[Math.min(9,Math.floor((255-lum)/255*9))];}console.log(line);}
