/**
 * The crash is interrupt-driven (only happens when PPU/timer tick -> interrupts fire).
 * Trace every interrupt entry (push) and every RET/RETI (pop) with SP, to find the imbalance.
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

const evlog: string[] = [];
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

const push = (s: string) => { evlog.push(s); if (evlog.length > 40) evlog.shift(); };

let n = 0;
while (n++ < 2_000_000) {
  // service interrupts (mirror of host loop)
  w2c();
  const ie = mmu.read(0xffff), iff = mmu.rawIoRead(0xff0f);
  const willFire = (cpu as any).ime && (ie & iff & 0x1f);
  const spBeforeInt = cpu.sp;
  const ic = cpu.serviceInterrupts();
  if (ic > 0) { c2w(); push(`IRQ pushed ret=0x${cpu.pc.toString(16)} (vector) SP ${spBeforeInt.toString(16)}->${cpu.sp.toString(16)}`); }

  const pcIn = ex.get_PC() & 0xffff;
  if (pcIn === 0x0038) {
    console.log("*** crash vector at dispatch", n, "***\nrecent events:");
    for (const e of evlog) console.log("   " + e);
    break;
  }
  // log RET/RETI/RST entries
  const op = mmu.read(pcIn);
  if (op === 0xc9 || op === 0xd9 || op === 0xc0 || op === 0xc8 || op === 0xd0 || op === 0xd8) {
    const sp = ex.get_SP() & 0xffff;
    const tgt = (mmu.read((sp+1)&0xffff)<<8)|mmu.read(sp);
    push(`RET-ish 0x${pcIn.toString(16)} op=0x${op.toString(16)} SP=0x${sp.toString(16)} -> pops 0x${tgt.toString(16)}`);
  }
  if (op === 0xcd || (op&0xc7)===0xc4) push(`CALL  0x${pcIn.toString(16)} op=0x${op.toString(16)} SP=0x${(ex.get_SP()&0xffff).toString(16)}`);
  if ((op&0xc7)===0xc7) push(`RST   0x${pcIn.toString(16)} op=0x${op.toString(16)} SP=0x${(ex.get_SP()&0xffff).toString(16)}`);

  const ret = ex.run(pcIn);
  if (ret === UNKNOWN_BLOCK) { w2c(); cpu.step(); c2w(); }
  else if (ret === SENTINEL_HALT) cpu.halted = true;
}
console.log("done at dispatch", n);
