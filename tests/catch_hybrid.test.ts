/**
 * The pure interpreter runs 5M steps clean, but the HYBRID (recompiled+interp) path derails
 * into 0x0038. So the bug is at the block<->interp seam. Instrument the hybrid loop: record
 * (pc-in, run()-return, pc-out, cycles-delta) for every dispatch, and stop when pc-out lands
 * in the crash vector OR when pc jumps somewhere not reachable from pc-in.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { Joypad } from "../src/runtime/joypad.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync(
  "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"
));

const mmu = new MMU(rom);
const cpu = new CPU(mmu);
const ppu = new PPU(mmu);
const timer = new Timer(mmu);
new Joypad(mmu);

const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
let ex: any;
const w2c = () => { cpu.a=ex.get_A();cpu.f=ex.get_F()&0xf0;cpu.b=ex.get_B();cpu.c=ex.get_C();cpu.d=ex.get_D();cpu.e=ex.get_E();cpu.h=ex.get_H();cpu.l=ex.get_L();cpu.sp=ex.get_SP();cpu.pc=ex.get_PC(); };
const c2w = () => { ex.set_A(cpu.a);ex.set_F(cpu.f&0xf0);ex.set_B(cpu.b);ex.set_C(cpu.c);ex.set_D(cpu.d);ex.set_E(cpu.e);ex.set_H(cpu.h);ex.set_L(cpu.l);ex.set_SP(cpu.sp);ex.set_PC(cpu.pc); };

const imports = { env: {
  mem: memory,
  rb: (a: number) => mmu.read(a & 0xffff),
  wb: (a: number, v: number) => mmu.write(a & 0xffff, v & 0xff),
  tick: (c: number) => { cpu.cycles += c; ppu.step(c); timer.step(c); },
  interp: (addr: number) => {
    w2c();
    const ins = decode(new Uint8Array([mmu.read(addr), mmu.read((addr+1)&0xffff), mmu.read((addr+2)&0xffff)]), 0, addr);
    const saved = cpu.pc; cpu.exec(ins); if (!ins.isTerminator) cpu.pc = saved;
    c2w();
  },
  dispatch: (pc: number) => pc,
  set_ime: (v: number) => { (cpu as any).ime = !!v; },
  sched_ei: () => { (cpu as any).imeScheduled = true; },
  set_halt: (v: number) => { cpu.halted = !!v; },
}};

const { instance } = await WebAssembly.instantiate(wasm, imports as any);
ex = instance.exports;
ex.set_A(0x01);ex.set_F(0xb0);ex.set_B(0);ex.set_C(0x13);ex.set_D(0);ex.set_E(0xd8);ex.set_H(0x01);ex.set_L(0x4d);ex.set_SP(0xfffe);ex.set_PC(0x0100);
mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);

const trail: string[] = [];
let n = 0;
const MAX = 2_000_000;
while (n++ < MAX) {
  const pcIn = ex.get_PC() & 0xffff;
  if (pcIn === 0x0038) {
    console.log("\n*** HYBRID entered crash vector 0x0038 at dispatch", n, "***");
    console.log("Dispatch trail (oldest -> newest):");
    for (const t of trail) console.log("   " + t);
    break;
  }
  // disasm the block entry
  const b0 = mmu.read(pcIn);
  const ins0 = decode(new Uint8Array([b0, mmu.read((pcIn+1)&0xffff), mmu.read((pcIn+2)&0xffff)]), 0, pcIn);
  const cyBefore = cpu.cycles;
  const ret = ex.run(pcIn);
  let kind = "BLK";
  if (ret === UNKNOWN_BLOCK) { kind = "UNK->interp"; w2c(); cpu.step(); c2w(); }
  else if (ret === SENTINEL_HALT) { kind = "HALT"; cpu.halted = true; }
  const pcOut = ex.get_PC() & 0xffff;
  trail.push(
    `[${kind}] in=0x${pcIn.toString(16).padStart(4,"0")} (${ins0.text}) ret=0x${(ret>>>0).toString(16)} out=0x${pcOut.toString(16).padStart(4,"0")} dCy=${cpu.cycles-cyBefore} F=0x${(ex.get_F()&0xff).toString(16)}`
  );
  if (trail.length > 30) trail.shift();
  if (n === MAX) console.log("hybrid reached MAX without crashing");
}
