/**
 * Run the EXACT browser code path (BrowserMachine + pre-assembled served.wasm) headlessly,
 * so we can see what the canvas would show without a browser. Dumps:
 *   - per-frame: PC, LCDC, LY, whether stalled, non-white pixel count
 *   - a final ASCII render of the 160x144 framebuffer (downsampled) so we SEE the screen
 */
import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync(
  "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"
));

const m = await BrowserMachine.create(wasm, rom);
console.log("created, PC=0x" + m.exports.get_PC().toString(16));

let stallFirstSeen = -1;
for (let i = 0; i < 400; i++) {
  m.runFrame();
  const stall = (m as any).lastStall;
  if (stall && stallFirstSeen < 0) stallFirstSeen = i;
  if (i < 5 || i === 50 || i === 100 || i === 200 || i === 399) {
    const fb = m.framebuffer;
    let nonWhite = 0;
    for (let p = 0; p < fb.length; p += 4)
      if (!(fb[p] === 0xe0 && fb[p + 1] === 0xf8 && fb[p + 2] === 0xd0)) nonWhite++;
    console.log(
      `frame ${String(i).padStart(3)}  PC=0x${m.exports.get_PC().toString(16).padStart(4, "0")}` +
      `  LCDC=0x${m.mmu.rawIoRead(0xff40).toString(16)}  LY=${m.mmu.rawIoRead(0xff44)}` +
      `  nonWhite=${nonWhite}  stall=${stall || "-"}`
    );
  }
}
console.log("\nfirst stall at frame:", stallFirstSeen);

// ASCII render the final framebuffer (downsample 160x144 -> 80x36)
const fb = m.framebuffer;
const W = 160, H = 144;
const ramp = " .:-=+*#%@";
console.log("\n  Final framebuffer (downsampled):");
for (let y = 0; y < H; y += 4) {
  let line = "  ";
  for (let x = 0; x < W; x += 2) {
    const o = (y * W + x) * 4;
    // luminance from green channel (DMG palette is green-tinted)
    const lum = (fb[o]! + fb[o + 1]! + fb[o + 2]!) / 3;
    const idx = Math.min(ramp.length - 1, Math.floor((255 - lum) / 255 * (ramp.length - 1)));
    line += ramp[idx];
  }
  console.log(line);
}
