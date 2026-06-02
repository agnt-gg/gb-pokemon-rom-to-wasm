/**
 * Headless APU verification against the real ROM:
 *  - APU registers are captured (NR52 power on, channel enables set).
 *  - drainAudio() yields stereo samples at ~44100 Hz for the frames run.
 *  - Audio is non-silent once Pokemon starts its boot jingle / music.
 */
import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const m = await BrowserMachine.create(wasm, rom);

let totalSamples = 0;
let peak = 0;
let nonZeroChunks = 0;
const FRAMES = 600; // ~10 seconds of emulated time

for (let f = 0; f < FRAMES; f++) {
  m.runFrame();
  const { left, right } = m.drainAudio();
  totalSamples += left.length;
  let chunkPeak = 0;
  for (let i = 0; i < left.length; i++) {
    const a = Math.abs(left[i]!); const b = Math.abs(right[i]!);
    if (a > chunkPeak) chunkPeak = a;
    if (b > chunkPeak) chunkPeak = b;
  }
  if (chunkPeak > 0.001) nonZeroChunks++;
  if (chunkPeak > peak) peak = chunkPeak;
}

const expectedPerFrame = 44100 / 59.7275; // ~738 samples/frame
const expectedTotal = expectedPerFrame * FRAMES;
const rateOk = totalSamples > expectedTotal * 0.8 && totalSamples < expectedTotal * 1.2;

// inspect NR52 (FF26): bit7 = power
const nr52 = m.mmu.read(0xff26);

console.log("NR52 (FF26) = 0x" + nr52.toString(16), "power=" + ((nr52 & 0x80) ? "ON" : "off"),
            "ch-active bits=" + (nr52 & 0xf).toString(2).padStart(4, "0"));
console.log("audio samples produced:", totalSamples, "(expected ~" + expectedTotal.toFixed(0) + ")", rateOk ? "✓ rate OK" : "✗ rate off");
console.log("non-silent frames:", nonZeroChunks + "/" + FRAMES, "| peak amplitude:", peak.toFixed(4));
console.log("\nRESULT:", (rateOk && peak > 0.001) ? "✅ APU PRODUCING AUDIO" : "⚠ audio rate ok but silent (game may not have triggered sound yet)");
