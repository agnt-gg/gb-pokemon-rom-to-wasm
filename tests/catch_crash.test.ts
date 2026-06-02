/**
 * Find the exact instruction that derails control flow into the 0x0038 crash vector.
 * We single-step the interpreter (authoritative) from boot and watch for:
 *   - PC entering 0x0038 (RST 38 crash vector)
 *   - any opcode fetch that returns 0xFF from a "code" region
 * and print the preceding instruction trail.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { decode } from "../src/recompiler/decoder.ts";

const rom = new Uint8Array(readFileSync(
  "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"
));
const mmu = new MMU(rom);
const cpu = new CPU(mmu);

// post-boot seed
cpu.a = 0x01; cpu.f = 0xb0; cpu.b = 0; cpu.c = 0x13; cpu.d = 0; cpu.e = 0xd8;
cpu.h = 0x01; cpu.l = 0x4d; cpu.sp = 0xfffe; cpu.pc = 0x0100;
mmu.rawIoWrite(0xff40, 0x91); mmu.rawIoWrite(0xff47, 0xfc);

const trail: string[] = [];
const TRAIL = 24;
let steps = 0;
const MAX = 5_000_000;

while (steps++ < MAX) {
  const pc = cpu.pc;
  if (pc === 0x0038) {
    console.log("\n*** Entered crash vector 0x0038 at step", steps, "***");
    console.log("Preceding instruction trail (oldest -> newest):");
    for (const t of trail) console.log("   " + t);
    break;
  }
  const b0 = mmu.read(pc), b1 = mmu.read((pc + 1) & 0xffff), b2 = mmu.read((pc + 2) & 0xffff);
  const ins = decode(new Uint8Array([b0, b1, b2]), 0, pc);
  // record trail
  trail.push(
    `0x${pc.toString(16).padStart(4, "0")}: ${ins.text.padEnd(18)}` +
    ` [op=0x${b0.toString(16).padStart(2, "0")}]` +
    ` A=${cpu.a.toString(16)} BC=${(cpu.b<<8|cpu.c).toString(16)} DE=${(cpu.d<<8|cpu.e).toString(16)} HL=${(cpu.h<<8|cpu.l).toString(16)} SP=${cpu.sp.toString(16)}`
  );
  if (trail.length > TRAIL) trail.shift();

  try {
    cpu.step();
  } catch (e) {
    console.log("\n*** Interpreter THREW at step", steps, "pc=0x" + pc.toString(16), "***");
    console.log((e as Error).message);
    console.log("Trail:");
    for (const t of trail) console.log("   " + t);
    break;
  }
  if (steps === MAX) console.log("reached MAX steps without crashing (good!)");
}
