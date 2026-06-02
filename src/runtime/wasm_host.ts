/**
 * WASM host: instantiates a recompiled module and drives it.
 *
 * The recompiled module imports `env.rb/wb/interp/tick/dispatch/...` and a shared `mem`.
 * We back those with the SAME MMU + CPU used by the reference interpreter, so:
 *   - recompiled fast-path ops mutate WASM globals (registers)
 *   - interp-routed ops call back into the CPU, which must read/write those SAME registers
 *
 * To keep the two register files coherent, we SYNC: before an $interp call we copy WASM
 * globals -> CPU, run one instruction in the CPU, then copy CPU -> WASM globals. This makes
 * the hybrid path correct by construction; the differential oracle then proves the native
 * lifts match the interpreter exactly.
 */

import { MMU } from "./mmu.ts";
import { CPU } from "./cpu.ts";
import { decode } from "../recompiler/decoder.ts";
import { assembleWat } from "../recompiler/assemble.ts";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../recompiler/module.ts";

export interface RecompInstance {
  exports: any;
  mmu: MMU;
  cpu: CPU;
  /** Run starting at pc until HALT/STOP or step budget exhausted. Returns final pc. */
  run(pc: number, maxSteps?: number): number;
  /**
   * Run until at least `targetCycles` t-cycles have elapsed (used by the frame loop).
   * Returns the number of cycles actually consumed. Services interrupts between blocks.
   */
  runCycles(targetCycles: number): number;
  /** Install a callback invoked with the t-cycles each instruction/block consumes. */
  onTick(cb: (cycles: number) => void): void;
  /** Sync helpers exposed for the machine to read/seed PC etc. */
  getPC(): number;
  setPC(pc: number): void;
}

const REGS = ["A", "F", "B", "C", "D", "E", "H", "L", "SP", "PC"] as const;

export async function instantiateRecomp(
  wat: string,
  mmu: MMU,
): Promise<RecompInstance> {
  const bytes = await assembleWat(wat);

  // Shared linear memory: we mirror the GB 16-bit address space into a 128 KB WASM memory.
  // The recompiled code's $rb/$wb imports go through the MMU (so banking works), so the
  // memory pages here are only used as a scratch/compat region; the authoritative state is
  // the MMU. We still must provide a `memory` import the module declared.
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });

  const cpu = new CPU(mmu);
  let tickCb: ((c: number) => void) | null = null;

  // --- register sync helpers (WASM globals <-> CPU) ---
  let exportsRef: any = null;
  function wasmToCpu(): void {
    cpu.a = exportsRef.get_A(); cpu.f = exportsRef.get_F() & 0xf0;
    cpu.b = exportsRef.get_B(); cpu.c = exportsRef.get_C();
    cpu.d = exportsRef.get_D(); cpu.e = exportsRef.get_E();
    cpu.h = exportsRef.get_H(); cpu.l = exportsRef.get_L();
    cpu.sp = exportsRef.get_SP(); cpu.pc = exportsRef.get_PC();
  }
  function cpuToWasm(): void {
    exportsRef.set_A(cpu.a); exportsRef.set_F(cpu.f & 0xf0);
    exportsRef.set_B(cpu.b); exportsRef.set_C(cpu.c);
    exportsRef.set_D(cpu.d); exportsRef.set_E(cpu.e);
    exportsRef.set_H(cpu.h); exportsRef.set_L(cpu.l);
    exportsRef.set_SP(cpu.sp); exportsRef.set_PC(cpu.pc);
  }

  const imports = {
    env: {
      mem: memory,
      rb: (addr: number) => mmu.read(addr & 0xffff),
      wb: (addr: number, val: number) => mmu.write(addr & 0xffff, val & 0xff),
      tick: (_cycles: number) => { cpu.cycles += _cycles; if (tickCb) tickCb(_cycles); },
      // Run exactly one instruction at `addr` through the reference interpreter,
      // keeping WASM globals authoritative via sync.
      interp: (addr: number) => {
        wasmToCpu();
        // The block already advanced PC past this instruction's bytes; the interpreter
        // re-decodes at `addr` and executes, but must NOT re-advance PC for non-control ops.
        const b0 = mmu.read(addr), b1 = mmu.read((addr + 1) & 0xffff), b2 = mmu.read((addr + 2) & 0xffff);
        const ins = decode(new Uint8Array([b0, b1, b2]), 0, addr);
        // Save PC, let exec run (control ops handle PC themselves; data ops leave it).
        const savedPc = cpu.pc;
        cpu.exec(ins);
        // For non-terminators, the block manages PC; restore so we don't double-advance.
        if (!ins.isTerminator) cpu.pc = savedPc;
        cpuToWasm();
      },
      dispatch: (pc: number) => pc, // host loop handles dispatch; identity here
      set_ime: (v: number) => { (cpu as any).ime = !!v; },
      sched_ei: () => { (cpu as any).imeScheduled = true; },
      set_halt: (v: number) => { cpu.halted = !!v; },
    },
  };

  const { instance } = await WebAssembly.instantiate(bytes, imports as any);
  exportsRef = instance.exports;

  function run(pc: number, maxSteps = 1_000_000): number {
    exportsRef.set_PC(pc);
    let steps = 0;
    let cur = pc;
    while (steps++ < maxSteps) {
      const next = exportsRef.run(cur);
      if (next === SENTINEL_HALT) return SENTINEL_HALT; // HALT/STOP/illegal
      if (next === UNKNOWN_BLOCK) {
        wasmToCpu();
        cpu.step();
        cpuToWasm();
        cur = cpu.pc;
        continue;
      }
      cur = next & 0xffff;
    }
    return cur;
  }

  /**
   * Frame-loop driver. Executes blocks (recompiled where available, interpreted otherwise)
   * until `targetCycles` have elapsed, servicing interrupts between blocks. This is the
   * hybrid execution model that makes the real game runnable: the static recompiler handles
   * the hot ROM blocks; anything indirect / RAM-resident / not-yet-lifted falls through to
   * the verified interpreter. Both share the SAME cpu + mmu state.
   */
  function runCycles(targetCycles: number): number {
    const start = cpu.cycles;
    let guard = 0;
    const GUARD_MAX = 2_000_000; // hard stop to avoid a runaway frame
    while (cpu.cycles - start < targetCycles && guard++ < GUARD_MAX) {
      // service interrupts first (may push PC and jump to a vector)
      wasmToCpu();
      const ic = cpu.serviceInterrupts();
      if (ic > 0) { cpuToWasm(); if (tickCb) tickCb(ic); }
      if (cpu.halted) {
        // HALT: burn a little time until an interrupt wakes us
        cpu.cycles += 4; if (tickCb) tickCb(4);
        wasmToCpu();
        if (cpu.serviceInterrupts() > 0) cpuToWasm();
        continue;
      }

      const cur = exportsRef.get_PC() & 0xffff;

      // BANK-WINDOW GUARD: 0x4000-0x7FFF blocks were lifted from the build-time bank, which may
      // differ from the live bank. Interpret them against the current MMU bank mapping instead.
      if (cur >= 0x4000) {
        wasmToCpu();
        let inner = 0;
        while ((cpu.pc & 0xffff) >= 0x4000 && inner++ < 16384 && !cpu.halted) {
          const b = cpu.cycles;
          cpu.step();
          if (tickCb) tickCb(cpu.cycles - b);
        }
        cpuToWasm();
        continue;
      }

      const next = exportsRef.run(cur);
      if (next === UNKNOWN_BLOCK) {
        // interpret one instruction (covers RAM code, indirect targets, not-yet-lifted blocks)
        wasmToCpu();
        const before = cpu.cycles;
        cpu.step();
        cpuToWasm();
        const used = cpu.cycles - before;
        if (tickCb && used > 0) { /* cpu.step already added; tick PPU */ tickCb(used); }
      } else if (next === SENTINEL_HALT) {
        wasmToCpu(); // halted flag set inside block
      }
      // else: a recompiled block ran; it already called $tick per-instruction and set PC.
    }
    return cpu.cycles - start;
  }

  return {
    exports: exportsRef, mmu, cpu, run, runCycles,
    onTick: (cb) => { tickCb = cb; },
    getPC: () => exportsRef.get_PC() & 0xffff,
    setPC: (pc: number) => exportsRef.set_PC(pc & 0xffff),
  };
}
