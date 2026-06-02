/**
 * Isolate the RET-pops-0x0000 bug. Hypothesis: SP desyncs across the recompiled<->interp seam.
 *
 * We find the CALL that targets the copy routine, and trace SP at:
 *   - the CALL (push)  - the routine entry  - each interp op inside  - the RET (pop)
 * to see exactly where SP diverges.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync(
  "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"
));
const mmu = new MMU(rom);
const cpu = new CPU(mmu);

const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
let ex: any;
const w2c = () => { cpu.a=ex.get_A();cpu.f=ex.get_F()&0xf0;cpu.b=ex.get_B();cpu.c=ex.get_C();cpu.d=ex.get_D();cpu.e=ex.get_E();cpu.h=ex.get_H();cpu.l=ex.get_L();cpu.sp=ex.get_SP();cpu.pc=ex.get_PC(); };
const c2w = () => { ex.set_A(cpu.a);ex.set_F(cpu.f&0xf0);ex.set_B(cpu.b);ex.set_C(cpu.c);ex.set_D(cpu.d);ex.set_E(cpu.e);ex.set_H(cpu.h);ex.set_L(cpu.l);ex.set_SP(cpu.sp);ex.set_PC(cpu.pc); };

let interpLog = false;
const imports = { env: {
  mem: memory,
  rb: (a: number) => mmu.read(a & 0xffff),
  wb: (a: number, v: number) => mmu.write(a & 0xffff, v & 0xff),
  tick: (c: number) => { cpu.cycles += c; },
  interp: (addr: number) => {
    w2c();
    const spBefore = cpu.sp;
    const ins = decode(new Uint8Array([mmu.read(addr), mmu.read((addr+1)&0xffff), mmu.read((addr+2)&0xffff)]), 0, addr);
    const saved = cpu.pc; cpu.exec(ins); if (!ins.isTerminator) cpu.pc = saved;
    if (interpLog && cpu.sp !== spBefore)
      console.log(`   interp 0x${addr.toString(16)} ${ins.text}  SP ${spBefore.toString(16)} -> ${cpu.sp.toString(16)}`);
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

let n = 0;
let prevSP = ex.get_SP();
try {
while (n++ < 200000) {
  const pcIn = ex.get_PC() & 0xffff;
  const spIn = ex.get_SP() & 0xffff;
  // Start logging interp SP changes once we're near the copy routine
  if (pcIn === 0x00b5) interpLog = true;
  if (pcIn === 0x00bd) {
    // about to RET - what's on the stack?
    const lo = mmu.read(spIn), hi = mmu.read((spIn+1)&0xffff);
    console.log(`\nAt RET (0x00bd): SP=0x${spIn.toString(16)}  stack[SP]=0x${hi.toString(16)}${lo.toString(16)} (will pop 0x${((hi<<8)|lo).toString(16)})`);
  }
  if (pcIn === 0x0038) { console.log("\n-> reached crash vector. SP at crash:", spIn.toString(16)); break; }

  const ret = ex.run(pcIn);
  if (ret === UNKNOWN_BLOCK) { w2c(); cpu.step(); c2w(); }
  else if (ret === SENTINEL_HALT) cpu.halted = true;

  // detect SP corruption: a single dispatch shouldn't change SP by more than a few unless CALL/RET/PUSH/POP
  const spOut = ex.get_SP() & 0xffff;
  prevSP = spOut;
}
} catch (e) {
  console.log("THREW at dispatch", n, "pc=0x" + (ex.get_PC()&0xffff).toString(16));
  console.log((e as Error).stack);
}
console.log("done, dispatches:", n);
