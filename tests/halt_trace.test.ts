import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";
const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const m = await BrowserMachine.create(wasm, rom);
const ex:any=m.exports; const cpu=m.cpu; const mmu=m.mmu;
// run to where it reaches the 0x20af wait loop
for(let f=0;f<40;f++) m.runFrame();
console.log("After 40 frames:");
console.log("  PC=0x"+(ex.get_PC()&0xffff).toString(16));
console.log("  IME="+((cpu as any).ime?1:0)+" halted="+cpu.halted);
console.log("  IE(FFFF)=0x"+mmu.read(0xffff).toString(16)+" IF(FF0F)=0x"+mmu.rawIoRead(0xff0f).toString(16));
console.log("  FFD6(vblank-wait flag)=0x"+mmu.read(0xffd6).toString(16)+"  (game waits for this to become 0)");
console.log("  STAT(FF41)=0x"+mmu.rawIoRead(0xff41).toString(16)+" LY=0x"+mmu.rawIoRead(0xff44).toString(16));
// Does PPU request vblank interrupt? check IF after stepping a frame manually
const ifBefore=mmu.rawIoRead(0xff0f);
m.ppu.step(70224);
console.log("  After ppu.step(70224): IF=0x"+mmu.rawIoRead(0xff0f).toString(16)+" (was 0x"+ifBefore.toString(16)+", expect bit0 set if vblank fires)");
// what vector is FFFF? Is the game even enabling VBlank IE? Trace next 200k dispatches for an IE write
