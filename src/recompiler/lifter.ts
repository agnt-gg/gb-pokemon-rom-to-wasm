/**
 * The LIFTER: SM83 Instr  ->  WebAssembly (WAT text).
 *
 * This is the heart of the static recompiler. Each basic block of Game Boy machine code
 * becomes a WASM function `blk_XXXX`. The recompiled code mutates a shared machine state
 * held in WASM globals (registers) + the imported linear memory (the GB address space),
 * and calls imported host functions for the things that CANNOT be statically recompiled:
 * memory access (banking is dynamic) and indirect control transfer.
 *
 * DESIGN: hybrid recompilation.
 *   - Straight-line ALU/load ops  -> inline WASM (fast path, no interpreter).
 *   - Static direct jumps/calls   -> direct WASM calls to other blk_ functions.
 *   - Indirect (JP HL, RET, RST)  -> return a "next PC" to the host dispatcher,
 *                                     which looks up / lazily compiles the target block.
 *
 * The host exposes these imports (see runtime/wasm_host.ts):
 *   env.rb(addr)      -> i32   read byte  (through MMU, honors banking)
 *   env.wb(addr,val)         write byte
 *   env.rw(addr)      -> i32   read word
 *   env.ww(addr,val)         write word
 *   env.dispatch(pc)  -> i32   run block at pc (indirect), returns final next-pc
 *   env.tick(cycles)         advance PPU/timer by t-cycles
 *
 * Registers are WASM mutable globals: $A $F $B $C $D $E $H $L $SP $PC (all i32, 8/16-bit masked).
 *
 * The block function contract:
 *   - executes its instructions, mutating globals
 *   - on a STATIC terminator, calls the target blk_ directly (tail) then returns its result
 *   - on an INDIRECT terminator, sets $PC and returns it (host dispatches)
 *   - returns i32 = the next PC the host should run (or a sentinel for HALT/STOP)
 */

import type { Instr, Operand } from "./types.ts";
import { hex4 } from "./decoder.ts";

export const SENTINEL_HALT = 0x10000; // out-of-range PC signals halt to the host loop

// Conservative correctness mode for the browser demo: generated WASM still owns basic-block
// dispatch/timing/control-flow, but ordinary instruction semantics are delegated to the verified
// interpreter import. This keeps the game running through WASM blocks while avoiding partially
// validated native opcode lifts. Flip this off only when each native opcode family passes lockstep.
const FORCE_INTERP_NON_TERMINATORS = true;

/** Emit a label name for a block at a given address. */
export function blockName(addr: number): string {
  return `blk_${hex4(addr)}`;
}

/** A lifted block ready to be assembled. */
export interface LiftedBlock {
  addr: number;
  wat: string;
  /** Static successor addresses (for the module builder to ensure they get lifted too). */
  successors: number[];
  instrCount: number;
}

/** WAT snippets to read/write the value of an operand as an expression / statement. */
class Emit {
  lines: string[] = [];
  push(s: string) { this.lines.push(s); }
  toString() { return this.lines.join("\n"); }
}

/** Produce a WAT expression that evaluates to the 8-bit value of `o`. */
function readExpr(o: Operand): string {
  switch (o.kind) {
    case "reg8": return `(global.get $${o.reg})`;
    case "imm8": return `(i32.const ${o.value})`;
    case "simm8": return `(i32.const ${o.value & 0xff})`;
    case "mem_reg16": return `(call $rb (call $${o.reg === "BC" ? "bc16" : o.reg === "DE" ? "de16" : "hl16"}))`;
    case "mem_imm16": return `(call $rb (i32.const ${o.addr}))`;
    case "mem_high_imm8": return `(call $rb (i32.const ${0xff00 + o.off}))`;
    case "mem_high_c": return `(call $rb (i32.add (i32.const 0xff00) (global.get $C)))`;
    case "mem_hl_inc":
    case "mem_hl_dec":
      return `(call $rb (call $hl16))`; // pre-inc/dec handled by caller
    default: return `(i32.const 0)`;
  }
}

/**
 * NOTE ON 16-BIT PAIRS IN WASM:
 * For clarity and provable correctness, the WAT we emit uses helper calls $hl16/$bc16/$de16
 * to compose pairs from the 8-bit globals, and $set_hl16 etc. to split them back. These
 * helpers are emitted once in the module preamble. This keeps each lifted instruction a
 * direct, auditable translation of its SM83 semantics rather than hand-inlined bit math.
 */

/**
 * Lift a single instruction into WAT statements appended to `e`.
 * Returns true if the instruction is a terminator (block ends here).
 *
 * For the milestone build we lift the high-frequency boot/overworld opcode subset
 * to NATIVE wasm, and route the long tail through `$interp` (the host interpreter)
 * so correctness is never compromised while coverage grows. Each op we add to the
 * native set is verified against the interpreter by the differential oracle.
 */
export function liftInstr(e: Emit, ins: Instr): boolean {
  const ops = ins.operands;
  e.push(`    ;; ${hex4(ins.addr)}: ${ins.text}`);
  // advance cycle budget for this instruction
  e.push(`    (call $tick (i32.const ${ins.cycles}))`);

  if (FORCE_INTERP_NON_TERMINATORS && !ins.isTerminator) {
    emitInterp(e, ins);
    return false;
  }

  switch (ins.mnemonic) {
    case "NOP":
      return false;

    case "XOR": {
      // common idiom; native lift: A ^= src; flags Z000
      e.push(`    (global.set $A (i32.and (i32.xor (global.get $A) ${readExpr(ops[ops.length - 1]!)}) (i32.const 0xff)))`);
      e.push(`    (call $setflags_z (global.get $A))`);
      return false;
    }
    case "LD": {
      const dst = ops[0]!, src = ops[ops.length - 1]!;
      // 8-bit reg <- reg/imm/mem (native for the simple shapes; else interp)
      if (dst.kind === "reg8" && (src.kind === "reg8" || src.kind === "imm8" || src.kind === "mem_reg16" || src.kind === "mem_imm16" || src.kind === "mem_high_imm8" || src.kind === "mem_high_c")) {
        e.push(`    (global.set $${dst.reg} ${readExpr(src)})`);
        return false;
      }
      if (dst.kind === "mem_reg16" && src.kind === "reg8") {
        const pair = dst.reg === "BC" ? "bc16" : dst.reg === "DE" ? "de16" : "hl16";
        e.push(`    (call $wb (call $${pair}) (global.get $${src.reg}))`);
        return false;
      }
      if ((dst.kind === "mem_imm16") && src.kind === "reg8") {
        e.push(`    (call $wb (i32.const ${dst.addr}) (global.get $${src.reg}))`);
        return false;
      }
      if (dst.kind === "mem_high_imm8" && src.kind === "reg8") {
        e.push(`    (call $wb (i32.const ${0xff00 + dst.off}) (global.get $${src.reg}))`);
        return false;
      }
      // everything else (16-bit loads, HL+/-, SP forms): route to interpreter for correctness
      emitInterp(e, ins);
      return false;
    }
    case "LDH": {
      const dst = ops[0]!, src = ops[1]!;
      if (dst.kind === "mem_high_imm8" && src.kind === "reg8") {
        e.push(`    (call $wb (i32.const ${0xff00 + dst.off}) (global.get $${src.reg}))`);
        return false;
      }
      if (dst.kind === "reg8" && src.kind === "mem_high_imm8") {
        e.push(`    (global.set $${dst.reg} (call $rb (i32.const ${0xff00 + src.off})))`);
        return false;
      }
      emitInterp(e, ins);
      return false;
    }

    // --- static control flow: emit direct calls / pc returns ---
    case "JP": {
      const imm = ops.find((o) => o.kind === "imm16");
      const cond = ops.find((o) => o.kind === "cond");
      if (!imm) {
        // JP (HL) — indirect: set PC, return to dispatcher
        e.push(`    (global.set $PC (call $hl16))`);
        e.push(`    (return (global.get $PC))`);
        return true;
      }
      const tgt = (imm as any).value as number;
      if (!cond) {
        e.push(`    (global.set $PC (i32.const ${tgt}))`);
        e.push(`    (return (i32.const ${tgt}))`);
      } else {
        emitConditionalReturn(e, (cond as any).cc, tgt, (ins.addr + ins.length) & 0xffff, ins);
      }
      return true;
    }
    case "JR": {
      const cond = ops.find((o) => o.kind === "cond");
      const next = (ins.addr + ins.length) & 0xffff;
      const disp = (ops.find((o) => o.kind === "simm8") as any)?.value ?? 0;
      const tgt = (next + disp) & 0xffff;
      if (!cond) {
        e.push(`    (global.set $PC (i32.const ${tgt}))`);
        e.push(`    (return (i32.const ${tgt}))`);
      } else {
        emitConditionalReturn(e, (cond as any).cc, tgt, next, ins);
      }
      return true;
    }
    case "CALL": {
      const imm = ops.find((o) => o.kind === "imm16");
      const cond = ops.find((o) => o.kind === "cond");
      const tgt = (imm as any)?.value ?? 0;
      const next = (ins.addr + ins.length) & 0xffff;
      if (!cond) {
        e.push(`    (call $push16 (i32.const ${next}))`);
        e.push(`    (global.set $PC (i32.const ${tgt}))`);
        e.push(`    (return (i32.const ${tgt}))`);
      } else {
        const extra = Math.max(0, (ins.cyclesBranch ?? ins.cycles) - ins.cycles);
        e.push(`    (if ${condTest((cond as any).cc)}`);
        e.push(`      (then ${extra ? `(call $tick (i32.const ${extra})) ` : ""}(call $push16 (i32.const ${next})) (global.set $PC (i32.const ${tgt})) (return (i32.const ${tgt}))))`);
        e.push(`    (global.set $PC (i32.const ${next}))`);
        e.push(`    (return (i32.const ${next}))`);
      }
      return true;
    }
    case "RST": {
      const vec = (ops[0] as any).vec as number;
      const next = (ins.addr + ins.length) & 0xffff;
      e.push(`    (call $push16 (i32.const ${next}))`);
      e.push(`    (global.set $PC (i32.const ${vec}))`);
      e.push(`    (return (i32.const ${vec}))`);
      return true;
    }
    case "RET": {
      const cond = ops.find((o) => o.kind === "cond");
      if (!cond) {
        e.push(`    (global.set $PC (call $pop16))`);
        e.push(`    (return (global.get $PC))`);
      } else {
        const extra = Math.max(0, (ins.cyclesBranch ?? ins.cycles) - ins.cycles);
        e.push(`    (if ${condTest((cond as any).cc)}`);
        e.push(`      (then ${extra ? `(call $tick (i32.const ${extra})) ` : ""}(global.set $PC (call $pop16)) (return (global.get $PC))))`);
        const next = (ins.addr + ins.length) & 0xffff;
        e.push(`    (global.set $PC (i32.const ${next}))`);
        e.push(`    (return (i32.const ${next}))`);
      }
      return true;
    }
    case "RETI": {
      e.push(`    (call $set_ime (i32.const 1))`);
      e.push(`    (global.set $PC (call $pop16))`);
      e.push(`    (return (global.get $PC))`);
      return true;
    }
    case "HALT":
    case "STOP": {
      e.push(`    (call $set_halt (i32.const 1))`);
      e.push(`    (return (i32.const ${SENTINEL_HALT}))`);
      return true;
    }
    case "DI": { e.push(`    (call $set_ime (i32.const 0))`); return false; }
    case "EI": { e.push(`    (call $sched_ei)`); return false; }

    case "ILLEGAL": {
      e.push(`    (return (i32.const ${SENTINEL_HALT}))`);
      return true;
    }

    // --- everything else: lift via the verified interpreter (correct by construction) ---
    default:
      emitInterp(e, ins);
      return false;
  }
}

/** Conditional JP/JR: if taken return target, else return fallthrough (both set PC). */
function emitConditionalReturn(e: Emit, cc: string, tgt: number, next: number, ins: Instr): void {
  const extra = Math.max(0, (ins.cyclesBranch ?? ins.cycles) - ins.cycles);
  e.push(`    (if ${condTest(cc)}`);
  e.push(`      (then ${extra ? `(call $tick (i32.const ${extra})) ` : ""}(global.set $PC (i32.const ${tgt})) (return (i32.const ${tgt}))))`);
  e.push(`    (global.set $PC (i32.const ${next}))`);
  e.push(`    (return (i32.const ${next}))`);
}

/** WAT boolean expression for a condition code, reading the F global. */
function condTest(cc: string): string {
  const Z = `(i32.and (global.get $F) (i32.const 0x80))`;
  const C = `(i32.and (global.get $F) (i32.const 0x10))`;
  switch (cc) {
    case "Z": return `(i32.ne ${Z} (i32.const 0))`;
    case "NZ": return `(i32.eq ${Z} (i32.const 0))`;
    case "C": return `(i32.ne ${C} (i32.const 0))`;
    case "NC": return `(i32.eq ${C} (i32.const 0))`;
    default: return `(i32.const 1)`;
  }
}

/**
 * Route one instruction to the host interpreter for execution. The interpreter reads the
 * SAME globals/memory, so it's transparent. `$interp` takes the instruction's start addr
 * and length and returns nothing (it mutates state). PC was already advanced by the block.
 */
function emitInterp(e: Emit, ins: Instr): void {
  e.push(`    (call $interp (i32.const ${ins.addr}))`);
}
