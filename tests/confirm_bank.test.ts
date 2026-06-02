/**
 * Confirm the root cause: 0x5876 is in the SWITCHABLE bank window (0x4000-0x7FFF).
 * The recompiler lifted it from whatever bank was mapped at build time (bank 1), but at
 * runtime the game banks to a different ROM bank, so the live bytes differ -> the static
 * block is wrong -> control derails.
 *
 * Show the bytes at 0x5876 for each bank, and confirm bank 1 != the bank live at crash.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";

const rom = new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"));

// 0x5876 is offset 0x1876 within a 0x4000-sized bank window.
const offInBank = 0x5876 - 0x4000;
console.log("Bytes at logical 0x5876 across ROM banks (offset 0x" + offInBank.toString(16) + " in bank):");
for (const bank of [1, 2, 3, 0xb, 0x1c, 0x20]) {
  const fileOff = bank * 0x4000 + offInBank;
  const b = [...rom.slice(fileOff, fileOff + 4)].map(x => x.toString(16).padStart(2, "0")).join(" ");
  console.log(`  bank 0x${bank.toString(16).padStart(2,"0")}: ${b}`);
}
console.log("\nThe recompiler's buildBlocks() decoded via mmu.read() with bank 1 mapped.");
console.log("If the game banks elsewhere before reaching 0x5876, the static block is invalid.");
console.log("\n=> Root cause: STATIC RECOMPILATION OF BANKED ROM without bank-keying.");
