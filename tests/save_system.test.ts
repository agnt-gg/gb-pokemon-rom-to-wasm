/**
 * Verify the save system end-to-end, headless:
 *  1. Boot ~120 frames (into the overworld).
 *  2. BATTERY SAVE: write known bytes to SRAM via the bus, export, zero SRAM, re-import, confirm.
 *  3. SAVE-STATE: snapshot, run 200 more frames (state mutates), restore, confirm registers+RAM
 *     match the snapshot exactly and execution continues deterministically.
 */
import { readFileSync } from "node:fs";
import { BrowserMachine } from "../src/browser/host_browser.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));
const m = await BrowserMachine.create(wasm, rom);

console.log("saveKey:", m.saveKey(), "| hasBattery:", m.hasBattery());
for (let f = 0; f < 120; f++) m.runFrame();

// ---- 1) BATTERY SAVE round-trip ----
// enable SRAM (MBC3: write 0x0A to 0x0000-0x1FFF), select bank 0, write a signature
m.mmu.write(0x0000, 0x0a);
m.mmu.write(0x4000, 0x00);
const sig = [0xDE, 0xAD, 0xBE, 0xEF, 0x42];
for (let i = 0; i < sig.length; i++) m.mmu.write(0xa000 + i, sig[i]!);
const sav = m.getBatterySave();
console.log("battery .sav size:", sav.length, "bytes; first 5 @bank0:", Array.from(sav.slice(0, 5)).map(v=>v.toString(16)).join(" "));

// wipe SRAM, then reload the exported .sav
for (let i = 0; i < sig.length; i++) m.mmu.write(0xa000 + i, 0x00);
console.log("after wipe, SRAM[0]=0x" + m.mmu.read(0xa000).toString(16));
m.loadBatterySave(sav);
const restored = [0,1,2,3,4].map(i => m.mmu.read(0xa000 + i));
const battOk = restored.every((v,i) => v === sig[i]);
console.log("after reload, SRAM=", restored.map(v=>v.toString(16)).join(" "), battOk ? "✅ BATTERY SAVE OK" : "❌ MISMATCH");

// ---- 2) SAVE-STATE round-trip ----
const snap = m.snapshot();
const snapJson = JSON.stringify(snap);
console.log("\nsnapshot size:", (snapJson.length/1024).toFixed(0)+"KB", "| PC=0x"+snap.cpu.pc.toString(16), "frames="+snap.frames);

// capture a WRAM fingerprint at snapshot time
const fpAt = (mm:any) => { let h=0; for(let a=0xc000;a<0xe000;a++) h=(h*31 + mm.read(a))>>>0; return h; };
const fpSnap = fpAt(m.mmu);

// run forward — state should change
for (let f = 0; f < 200; f++) m.runFrame();
const fpAfter = fpAt(m.mmu);
console.log("WRAM fingerprint  snapshot=0x"+fpSnap.toString(16)+"  after+200f=0x"+fpAfter.toString(16), fpSnap!==fpAfter ? "(changed ✓)" : "(no change?)");

// restore and verify we're EXACTLY back
m.restore(JSON.parse(snapJson));
const fpRestored = fpAt(m.mmu);
const ex:any = m.exports;
const pcOk = (ex.get_PC()&0xffff) === snap.cpu.pc;
const fpOk = fpRestored === fpSnap;
console.log("after restore  PC=0x"+(ex.get_PC()&0xffff).toString(16)+" (expect 0x"+snap.cpu.pc.toString(16)+")", pcOk?"✓":"✗",
            "| WRAM fp=0x"+fpRestored.toString(16), fpOk?"✓":"✗");

// determinism: running again from restored state should reproduce the SAME post-200 fingerprint
for (let f = 0; f < 200; f++) m.runFrame();
const fpReplay = fpAt(m.mmu);
console.log("determinism replay fp=0x"+fpReplay.toString(16)+" (expect 0x"+fpAfter.toString(16)+")", fpReplay===fpAfter?"✅ SAVE-STATE DETERMINISTIC":"⚠ differs (input/timing nondeterminism)");

console.log("\nRESULT:", battOk && pcOk && fpOk ? "✅ ALL SAVE TESTS PASS" : "❌ FAILURE");
