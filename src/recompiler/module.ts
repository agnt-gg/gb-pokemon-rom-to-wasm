/**
 * Module builder: discover blocks via recursive descent, lift each, and assemble a
 * complete WAT module with the runtime preamble.
 *
 * The block graph is built by following STATIC successors from a set of entry points
 * (the ROM entry 0x0100, the RST/interrupt vectors, plus any address the dispatcher
 * later discovers at runtime — those are lazily lifted on demand by the host).
 *
 * The emitted module exports `run(pc) -> i32` which executes the block at `pc` and
 * returns the next PC (a static successor it tail-called into, or an indirect target
 * the host must dispatch). The host loop in wasm_host.ts drives this.
 */

import { decode } from "./decoder.ts";
import { liftInstr, blockName, type LiftedBlock, SENTINEL_HALT } from "./lifter.ts";
import type { Instr } from "./types.ts";

class Emit {
  lines: string[] = [];
  push(s: string) { this.lines.push(s); }
  toString() { return this.lines.join("\n"); }
}

/** Read 3 bytes for decode from a flat 16-bit logical snapshot of memory. */
function decodeAt(mem: (a: number) => number, addr: number): Instr {
  const buf = new Uint8Array([mem(addr), mem((addr + 1) & 0xffff), mem((addr + 2) & 0xffff)]);
  return decode(buf, 0, addr);
}

/**
 * Lift one basic block starting at `addr`. A block runs until a terminator.
 * Non-terminator instructions are appended; the block ends at the first terminator.
 */
function liftBlock(mem: (a: number) => number, addr: number): LiftedBlock {
  const e = new Emit();
  e.push(`  (func $${blockName(addr)} (result i32)`);
  let pc = addr;
  let count = 0;
  const successors: number[] = [];
  const MAX = 4096; // safety bound on block size

  while (count < MAX) {
    const ins = decodeAt(mem, pc);
    count++;
    const term = liftInstr(e, ins);
    if (term) {
      for (const t of ins.staticTargets ?? []) {
        if (t < 0x8000) successors.push(t); // only ROM-resident targets are statically liftable
      }
      break;
    }
    pc = (pc + ins.length) & 0xffff;
    // If we'd run off the end of ROM/into RAM, stop (RAM code is interpreted).
    if (pc >= 0x8000) {
      e.push(`    (global.set $PC (i32.const ${pc}))`);
      e.push(`    (return (i32.const ${pc}))`);
      break;
    }
  }
  if (count >= MAX) {
    e.push(`    (global.set $PC (i32.const ${pc}))`);
    e.push(`    (return (i32.const ${pc}))`);
  }
  e.push(`  )`);
  return { addr, wat: e.toString(), successors, instrCount: count };
}

/**
 * Discover & lift all statically-reachable blocks from `entries`.
 * Returns the lifted blocks keyed by address.
 */
export function buildBlocks(
  mem: (a: number) => number,
  entries: number[],
  opts: { maxBlocks?: number } = {},
): Map<number, LiftedBlock> {
  const blocks = new Map<number, LiftedBlock>();
  const queue = [...entries];
  const maxBlocks = opts.maxBlocks ?? 20000;

  while (queue.length && blocks.size < maxBlocks) {
    const addr = queue.shift()!;
    if (addr >= 0x8000) continue; // can't statically lift RAM
    if (blocks.has(addr)) continue;
    const blk = liftBlock(mem, addr);
    blocks.set(addr, blk);
    for (const s of blk.successors) {
      if (!blocks.has(s) && s < 0x8000) queue.push(s);
    }
  }
  return blocks;
}

/** The fixed runtime preamble: imports, register globals, and helper functions. */
function preamble(): string {
  return `
  ;; ---- imported host functions (the parts that can't be statically recompiled) ----
  (import "env" "rb" (func $rb (param i32) (result i32)))           ;; read byte
  (import "env" "wb" (func $wb (param i32 i32)))                    ;; write byte
  (import "env" "interp" (func $interp (param i32)))               ;; run 1 instr via reference interpreter
  (import "env" "tick" (func $tick (param i32)))                   ;; advance PPU/timer
  (import "env" "dispatch" (func $dispatch (param i32) (result i32)));; run block at pc (indirect)
  (import "env" "set_ime" (func $set_ime (param i32)))
  (import "env" "sched_ei" (func $sched_ei))
  (import "env" "set_halt" (func $set_halt (param i32)))

  ;; ---- CPU registers as mutable globals (8-bit values kept masked) ----
  (global $A (mut i32) (i32.const 0))
  (global $F (mut i32) (i32.const 0))
  (global $B (mut i32) (i32.const 0))
  (global $C (mut i32) (i32.const 0))
  (global $D (mut i32) (i32.const 0))
  (global $E (mut i32) (i32.const 0))
  (global $H (mut i32) (i32.const 0))
  (global $L (mut i32) (i32.const 0))
  (global $SP (mut i32) (i32.const 0xfffe))
  (global $PC (mut i32) (i32.const 0x100))

  ;; ---- 16-bit pair composition helpers ----
  (func $hl16 (result i32) (i32.or (i32.shl (global.get $H) (i32.const 8)) (global.get $L)))
  (func $bc16 (result i32) (i32.or (i32.shl (global.get $B) (i32.const 8)) (global.get $C)))
  (func $de16 (result i32) (i32.or (i32.shl (global.get $D) (i32.const 8)) (global.get $E)))

  ;; ---- stack push/pop (16-bit, little-endian, through MMU) ----
  (func $push16 (param $v i32)
    (global.set $SP (i32.and (i32.sub (global.get $SP) (i32.const 1)) (i32.const 0xffff)))
    (call $wb (global.get $SP) (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 0xff)))
    (global.set $SP (i32.and (i32.sub (global.get $SP) (i32.const 1)) (i32.const 0xffff)))
    (call $wb (global.get $SP) (i32.and (local.get $v) (i32.const 0xff))))
  (func $pop16 (result i32) (local $lo i32) (local $hi i32)
    (local.set $lo (call $rb (global.get $SP)))
    (global.set $SP (i32.and (i32.add (global.get $SP) (i32.const 1)) (i32.const 0xffff)))
    (local.set $hi (call $rb (global.get $SP)))
    (global.set $SP (i32.and (i32.add (global.get $SP) (i32.const 1)) (i32.const 0xffff)))
    (i32.or (i32.shl (local.get $hi) (i32.const 8)) (local.get $lo)))

  ;; ---- flag helper: set Z from an 8-bit result, clear N H C (used by XOR/OR/AND-style) ----
  (func $setflags_z (param $v i32)
    (global.set $F (select (i32.const 0x80) (i32.const 0x00)
      (i32.eqz (i32.and (local.get $v) (i32.const 0xff))))))
`;
}

/** Assemble the full WAT module text from lifted blocks + a dispatch table. */
export function buildModuleWat(blocks: Map<number, LiftedBlock>): string {
  const e = new Emit();
  e.push(`(module`);
  e.push(`  (import "env" "mem" (memory 2))  ;; 128 KB linear memory shared with host (GB address space view)`);
  e.push(preamble());

  // all lifted block functions
  for (const blk of blocks.values()) e.push(blk.wat);

  // The exported entry: run the block at $pc if we have it, else ask host to dispatch.
  // We build a br_table-free dispatcher using a chain of comparisons for the known blocks.
  // For scale, the host actually calls run() with a known-present pc; unknown pcs return
  // to the host which lazily lifts them. So run() = "I know this block, execute it".
  const addrs = [...blocks.keys()].sort((a, b) => a - b);
  e.push(`  (func $run (export "run") (param $pc i32) (result i32)`);
  for (const a of addrs) {
    e.push(`    (if (i32.eq (local.get $pc) (i32.const ${a})) (then (return (call $${blockName(a)}))))`);
  }
  // unknown block -> sentinel so the host knows to lift it
  e.push(`    (return (i32.const ${SENTINEL_HALT + 1}))  ;; UNKNOWN_BLOCK`);
  e.push(`  )`);

  // export register accessors so the host interpreter & oracle can sync state
  for (const r of ["A", "F", "B", "C", "D", "E", "H", "L", "SP", "PC"]) {
    e.push(`  (func (export "get_${r}") (result i32) (global.get $${r}))`);
    e.push(`  (func (export "set_${r}") (param i32) (global.set $${r} (local.get 0)))`);
  }

  e.push(`)`);
  return e.toString();
}

export const UNKNOWN_BLOCK = SENTINEL_HALT + 1;
export { SENTINEL_HALT };
