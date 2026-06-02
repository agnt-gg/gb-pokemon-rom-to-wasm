/**
 * Core type model for the SM83 (Sharp LR35902 / Game Boy CPU) static recompiler.
 *
 * The pipeline is:  ROM bytes  ->  Decoder (this file's Instr)  ->  Lifter (WASM)  ->  Emitter.
 *
 * We model instructions in a CPU-agnostic, structured form so the lifter never has to
 * re-parse opcode bytes. Every field the lifter needs to emit correct WASM lives here.
 */

/** 8-bit registers. F is the flag register (only upper nibble used: Z N H C). */
export type Reg8 = "A" | "B" | "C" | "D" | "E" | "H" | "L" | "F";

/** 16-bit register pairs + the two pointers. */
export type Reg16 = "AF" | "BC" | "DE" | "HL" | "SP" | "PC";

/** Condition codes used by conditional JP/JR/CALL/RET. */
export type Cond = "NZ" | "Z" | "NC" | "C" | "ALWAYS";

/**
 * Operand kinds. The recompiler distinguishes memory access shapes because each
 * lifts to a different WASM memory-access sequence (and different bank handling).
 */
export type Operand =
  | { kind: "reg8"; reg: Reg8 }
  | { kind: "reg16"; reg: Reg16 }
  | { kind: "imm8"; value: number }              // d8
  | { kind: "imm16"; value: number }             // d16 / a16
  | { kind: "simm8"; value: number }             // r8 (signed, for JR / ADD SP,r8 / LD HL,SP+r8)
  | { kind: "mem_reg16"; reg: Reg16 }            // (HL), (BC), (DE)
  | { kind: "mem_hl_inc" }                        // (HL+)
  | { kind: "mem_hl_dec" }                        // (HL-)
  | { kind: "mem_imm16"; addr: number }          // (a16)
  | { kind: "mem_high_imm8"; off: number }       // (FF00+a8)  -- LDH
  | { kind: "mem_high_c" }                        // (FF00+C)
  | { kind: "bit"; n: number }                    // bit index 0..7 for CB ops
  | { kind: "rst"; vec: number }                  // RST target (0x00,0x08,...0x38)
  | { kind: "cond"; cc: Cond };

/** Every distinct opcode behaviour the lifter must handle. */
export type Mnemonic =
  // 8-bit loads
  | "LD" | "LDH"
  // 16-bit loads / stack
  | "PUSH" | "POP"
  // 8-bit ALU
  | "ADD" | "ADC" | "SUB" | "SBC" | "AND" | "OR" | "XOR" | "CP"
  | "INC" | "DEC"
  // 16-bit ALU
  | "ADD16" | "INC16" | "DEC16"
  // misc ALU / accumulator
  | "DAA" | "CPL" | "SCF" | "CCF"
  // rotates / shifts (non-CB accumulator forms)
  | "RLCA" | "RRCA" | "RLA" | "RRA"
  // CB-prefixed rotates / shifts / bit ops
  | "RLC" | "RRC" | "RL" | "RR" | "SLA" | "SRA" | "SWAP" | "SRL"
  | "BIT" | "RES" | "SET"
  // control flow
  | "JP" | "JR" | "CALL" | "RET" | "RETI" | "RST"
  // cpu control
  | "NOP" | "HALT" | "STOP" | "DI" | "EI"
  // illegal / undefined opcodes (0xD3,0xDB,0xDD,0xE3,0xE4,0xEB,0xEC,0xED,0xF4,0xFC,0xFD)
  | "ILLEGAL";

export interface Instr {
  /** Address (within its bank's logical view) where this instruction starts. */
  addr: number;
  /** Raw opcode byte (0xCB prefix is resolved away; cbByte holds the sub-op). */
  opcode: number;
  /** For CB-prefixed instructions, the byte following 0xCB. */
  cbByte?: number;
  mnemonic: Mnemonic;
  /** dest first, then src (matches Game Boy "LD dest, src" ordering). */
  operands: Operand[];
  /** Total encoded length in bytes (1..3). */
  length: number;
  /** Base machine cycles (m-cycles * 4 = t-cycles). Branch-taken handled separately. */
  cycles: number;
  /** Extra cycles when a conditional branch is taken. */
  cyclesBranch?: number;
  /** Human-readable disassembly, for debugging & oracle diffs. */
  text: string;
  /** True if this instruction can end a basic block (jump/ret/illegal/halt). */
  isTerminator: boolean;
  /**
   * Static control-flow targets discovered at decode time (for the block graph).
   * Indirect targets (JP HL, RET) are resolved at runtime via the dispatcher.
   */
  staticTargets?: number[];
}

/** A flag-effect descriptor extracted from the opcode tables (debug/verification use). */
export interface FlagEffect {
  Z: "0" | "1" | "-" | "Z"; // "Z" = set according to result
  N: "0" | "1" | "-" | "N";
  H: "0" | "1" | "-" | "H";
  C: "0" | "1" | "-" | "C";
}
