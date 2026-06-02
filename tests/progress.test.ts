import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const m = await BrowserMachine.create(wasm, rom);
const ex:any = m.exports;

for(let f=0;f<400;f++){
  m.runFrame();
  if(f===5||f===20||f===60||f===120||f===250||f===399){
    let nonWhite=0; const fb=m.framebuffer;
    for(let p=0;p<fb.length;p+=4) if(!(fb[p]===0xe0&&fb[p+1]===0xf8&&fb[p+2]===0xd0)) nonWhite++;
    console.log(`frame ${String(f).padStart(3)}: PC=0x${(ex.get_PC()&0xffff).toString(16)} LCDC=0x${m.mmu.rawIoRead(0xff40).toString(16)} LY=${m.mmu.rawIoRead(0xff44)} nonWhite=${nonWhite} stall=${(m as any).lastStall||"-"}`);
  }
}
