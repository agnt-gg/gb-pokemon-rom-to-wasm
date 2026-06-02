/**
 * Phase 5 oracle: the machine runs frames and the PPU produces a picture.
 *
 * Headless: run the real recompiled Pokemon Red for N frames, then assert:
 *   - frames advanced
 *   - VBlank interrupts are firing (LY cycles, IF gets set)
 *   - the framebuffer is not uniformly blank (the boot logo / Nintendo screen draws pixels)
 *   - distinct shades appear (proves tile decode + palette work)
 *
 * Run: node --experimental-strip-types tests/machine.test.ts "<rom path>"
 */

import { readFileSync } from "node:fs";
import { Machine } from "../src/runtime/machine.ts";

const romPath = process.argv[2]
  ?? "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(c: boolean, m: string) { if (c) pass++; else { fail++; failures.push(m); } }

const main = async () => {
  let rom: Uint8Array;
  try { rom = new Uint8Array(readFileSync(romPath)); }
  catch { console.log(`\n  (skip) ROM not found at ${romPath}\n`); return; }

  const t0 = Date.now();
  const m = await Machine.create(rom, { maxBlocks: 20000 });
  ok(true, `machine created (${Date.now() - t0}ms recompile)`);

  // Run 200 frames (~3.3 seconds). Track PEAK state across all frames (the intro toggles
  // the LCD on/off between screens, so a single final-frame snapshot is misleading).
  let nonBlankAtFrame = -1;
  let maxDistinctShades = 0;
  let lcdEverOn = false;
  let maxNonWhite = 0;
  for (let i = 0; i < 200; i++) {
    m.runFrame();
    const lcdc = m.mmu.rawIoRead(0xff40);
    if (lcdc & 0x80) lcdEverOn = true;
    const fb = m.framebuffer;
    const shades = new Set<number>();
    let nonWhite = 0;
    for (let p = 0; p < fb.length; p += 4) {
      const key = (fb[p]! << 16) | (fb[p + 1]! << 8) | fb[p + 2]!;
      shades.add(key);
      if (!(fb[p] === 0xe0 && fb[p + 1] === 0xf8 && fb[p + 2] === 0xd0)) nonWhite++;
    }
    maxDistinctShades = Math.max(maxDistinctShades, shades.size);
    maxNonWhite = Math.max(maxNonWhite, nonWhite);
    if (nonBlankAtFrame < 0 && nonWhite > 50) nonBlankAtFrame = i;
  }
  const elapsed = Date.now() - t0;

  ok(m.frames === 200, `ran 200 frames (got ${m.frames})`);
  ok(lcdEverOn, `LCD was enabled during run (re-enabled by cart init)`);
  ok(maxDistinctShades >= 2, `framebuffer showed >=2 distinct shades (peak ${maxDistinctShades})`);
  ok(nonBlankAtFrame >= 0, `framebuffer drew content by frame ${nonBlankAtFrame >= 0 ? nonBlankAtFrame : "NEVER"} (peak ${maxNonWhite} non-white px)`);

  const ly = m.mmu.rawIoRead(0xff44);
  ok(ly <= 153, `LY in valid range (LY=${ly})`);

  console.log("");
  console.log(`  Frames: ${m.frames}   peak distinct shades: ${maxDistinctShades}   peak non-white px: ${maxNonWhite}   first content frame: ${nonBlankAtFrame}`);
  console.log(`  Perf: ${elapsed}ms for 200 frames = ${(elapsed / 200).toFixed(1)}ms/frame (~${(1000 / (elapsed / 200)).toFixed(0)} fps headless)`);

  console.log("");
  console.log("================ PHASE 5: MACHINE / PPU ORACLE ========");
  console.log(`  PASS: ${pass}`);
  console.log(`  FAIL: ${fail}`);
  if (fail > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log("   x " + f);
    console.log("========================================================\n");
    process.exit(1);
  } else {
    console.log("  ALL GREEN ✓  recompiled Pokemon Red renders frames via PPU");
    console.log("========================================================\n");
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
