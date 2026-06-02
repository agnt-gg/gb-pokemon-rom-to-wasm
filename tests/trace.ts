/**
 * Diagnostic: trace where the recompiled boot gets stuck.
 * Counts PC visits and reports the hottest PCs + whether we're looping.
 */
import { readFileSync } from "node:fs";
import { Machine } from "../src/runtime/machine.ts";

const romPath = process.argv[2]
  ?? "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";

const main = async () => {
  const rom = new Uint8Array(readFileSync(romPath));
  const m = await Machine.create(rom, { maxBlocks: 20000 });

  const pcHits = new Map<number, number>();
  const origOnTick = (m.recomp as any);
  // sample PC each block by wrapping run via runCycles in small slices
  let lastLcdcOn = -1;
  // Compare: drive with ONE big runFrame chunk (like the machine does)
  for (let frame = 0; frame < 60; frame++) {
    const pc = m.recomp.getPC();
    pcHits.set(pc, (pcHits.get(pc) ?? 0) + 1);
    m.runFrame();
    const lcdc = m.mmu.rawIoRead(0xff40);
    if ((lcdc & 0x80) && lastLcdcOn < 0) lastLcdcOn = frame;
  }

  const top = [...pcHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log("\n  Hottest PCs (pc : hits):");
  for (const [pc, n] of top) console.log(`    0x${pc.toString(16).padStart(4, "0")} : ${n}`);
  console.log(`\n  LCD re-enabled at frame: ${lastLcdcOn}`);
  console.log(`  Final LCDC: 0x${m.mmu.rawIoRead(0xff40).toString(16)}  LY: ${m.mmu.rawIoRead(0xff44)}  IF: 0x${m.mmu.rawIoRead(0xff0f).toString(16)}  IE: 0x${m.mmu.read(0xffff).toString(16)}`);
  console.log(`  CPU ime=${(m.recomp.cpu as any).ime} halted=${m.recomp.cpu.halted}`);

  // Disassemble around the hottest PC
  const hot = top[0]![0];
  console.log(`\n  Disassembly around hottest PC 0x${hot.toString(16)}:`);
  const { decode } = await import("../src/recompiler/decoder.ts");
  let a = hot;
  for (let i = 0; i < 8; i++) {
    const buf = new Uint8Array([m.mmu.read(a), m.mmu.read(a + 1), m.mmu.read(a + 2)]);
    const ins = decode(buf, 0, a);
    console.log(`    0x${a.toString(16).padStart(4, "0")}: ${ins.text}`);
    a = (a + ins.length) & 0xffff;
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
