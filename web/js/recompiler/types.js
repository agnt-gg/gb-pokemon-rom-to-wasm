/**
 * Core type model for the SM83 (Sharp LR35902 / Game Boy CPU) static recompiler.
 *
 * The pipeline is:  ROM bytes  ->  Decoder (this file's Instr)  ->  Lifter (WASM)  ->  Emitter.
 *
 * We model instructions in a CPU-agnostic, structured form so the lifter never has to
 * re-parse opcode bytes. Every field the lifter needs to emit correct WASM lives here.
 */
export {};
