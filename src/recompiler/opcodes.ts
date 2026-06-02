/**
 * SM83 opcode tables.
 *
 * These are the canonical Game Boy CPU instruction definitions. Each entry is a terse
 * descriptor the decoder expands into a full `Instr`. Operand placeholders:
 *   d8   immediate byte            d16  immediate word        a16 absolute address word
 *   r8   signed immediate byte     a8   high-page offset byte
 *   (HL) memory at HL, etc.
 *
 * Cycle counts are m-cycles*4 (t-cycles). For conditional ops, `br` is the taken cost.
 *
 * Sourced from the public, well-documented SM83 ISA (pandocs / pret disassembly
 * conventions). This is reference data, not extracted from any ROM.
 */

export interface OpDef {
  /** Disassembly template, e.g. "LD B, d8" or "ADD A, (HL)". */
  m: string;
  /** Encoded length in bytes. */
  len: number;
  /** Base t-cycles. */
  c: number;
  /** Taken-branch t-cycles (conditional control flow only). */
  br?: number;
  /** Flags as Z N H C using 0/1/-/letter. e.g. "Z 0 H C". Default "- - - -". */
  f?: string;
}

/** Undefined opcodes on the SM83 (no operation, lock up the real CPU). */
export const ILLEGAL_OPCODES = new Set([
  0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd,
]);

/**
 * Base (unprefixed) opcode table, indexed 0x00..0xFF.
 * Holes (illegal opcodes) are explicitly marked with mnemonic "ILLEGAL".
 */
export const BASE: Record<number, OpDef> = {
  0x00: { m: "NOP", len: 1, c: 4 },
  0x01: { m: "LD BC, d16", len: 3, c: 12 },
  0x02: { m: "LD (BC), A", len: 1, c: 8 },
  0x03: { m: "INC BC", len: 1, c: 8 },
  0x04: { m: "INC B", len: 1, c: 4, f: "Z 0 H -" },
  0x05: { m: "DEC B", len: 1, c: 4, f: "Z 1 H -" },
  0x06: { m: "LD B, d8", len: 2, c: 8 },
  0x07: { m: "RLCA", len: 1, c: 4, f: "0 0 0 C" },
  0x08: { m: "LD (a16), SP", len: 3, c: 20 },
  0x09: { m: "ADD HL, BC", len: 1, c: 8, f: "- 0 H C" },
  0x0a: { m: "LD A, (BC)", len: 1, c: 8 },
  0x0b: { m: "DEC BC", len: 1, c: 8 },
  0x0c: { m: "INC C", len: 1, c: 4, f: "Z 0 H -" },
  0x0d: { m: "DEC C", len: 1, c: 4, f: "Z 1 H -" },
  0x0e: { m: "LD C, d8", len: 2, c: 8 },
  0x0f: { m: "RRCA", len: 1, c: 4, f: "0 0 0 C" },

  0x10: { m: "STOP", len: 2, c: 4 },
  0x11: { m: "LD DE, d16", len: 3, c: 12 },
  0x12: { m: "LD (DE), A", len: 1, c: 8 },
  0x13: { m: "INC DE", len: 1, c: 8 },
  0x14: { m: "INC D", len: 1, c: 4, f: "Z 0 H -" },
  0x15: { m: "DEC D", len: 1, c: 4, f: "Z 1 H -" },
  0x16: { m: "LD D, d8", len: 2, c: 8 },
  0x17: { m: "RLA", len: 1, c: 4, f: "0 0 0 C" },
  0x18: { m: "JR r8", len: 2, c: 12 },
  0x19: { m: "ADD HL, DE", len: 1, c: 8, f: "- 0 H C" },
  0x1a: { m: "LD A, (DE)", len: 1, c: 8 },
  0x1b: { m: "DEC DE", len: 1, c: 8 },
  0x1c: { m: "INC E", len: 1, c: 4, f: "Z 0 H -" },
  0x1d: { m: "DEC E", len: 1, c: 4, f: "Z 1 H -" },
  0x1e: { m: "LD E, d8", len: 2, c: 8 },
  0x1f: { m: "RRA", len: 1, c: 4, f: "0 0 0 C" },

  0x20: { m: "JR NZ, r8", len: 2, c: 8, br: 12 },
  0x21: { m: "LD HL, d16", len: 3, c: 12 },
  0x22: { m: "LD (HL+), A", len: 1, c: 8 },
  0x23: { m: "INC HL", len: 1, c: 8 },
  0x24: { m: "INC H", len: 1, c: 4, f: "Z 0 H -" },
  0x25: { m: "DEC H", len: 1, c: 4, f: "Z 1 H -" },
  0x26: { m: "LD H, d8", len: 2, c: 8 },
  0x27: { m: "DAA", len: 1, c: 4, f: "Z - 0 C" },
  0x28: { m: "JR Z, r8", len: 2, c: 8, br: 12 },
  0x29: { m: "ADD HL, HL", len: 1, c: 8, f: "- 0 H C" },
  0x2a: { m: "LD A, (HL+)", len: 1, c: 8 },
  0x2b: { m: "DEC HL", len: 1, c: 8 },
  0x2c: { m: "INC L", len: 1, c: 4, f: "Z 0 H -" },
  0x2d: { m: "DEC L", len: 1, c: 4, f: "Z 1 H -" },
  0x2e: { m: "LD L, d8", len: 2, c: 8 },
  0x2f: { m: "CPL", len: 1, c: 4, f: "- 1 1 -" },

  0x30: { m: "JR NC, r8", len: 2, c: 8, br: 12 },
  0x31: { m: "LD SP, d16", len: 3, c: 12 },
  0x32: { m: "LD (HL-), A", len: 1, c: 8 },
  0x33: { m: "INC SP", len: 1, c: 8 },
  0x34: { m: "INC (HL)", len: 1, c: 12, f: "Z 0 H -" },
  0x35: { m: "DEC (HL)", len: 1, c: 12, f: "Z 1 H -" },
  0x36: { m: "LD (HL), d8", len: 2, c: 12 },
  0x37: { m: "SCF", len: 1, c: 4, f: "- 0 0 1" },
  0x38: { m: "JR C, r8", len: 2, c: 8, br: 12 },
  0x39: { m: "ADD HL, SP", len: 1, c: 8, f: "- 0 H C" },
  0x3a: { m: "LD A, (HL-)", len: 1, c: 8 },
  0x3b: { m: "DEC SP", len: 1, c: 8 },
  0x3c: { m: "INC A", len: 1, c: 4, f: "Z 0 H -" },
  0x3d: { m: "DEC A", len: 1, c: 4, f: "Z 1 H -" },
  0x3e: { m: "LD A, d8", len: 2, c: 8 },
  0x3f: { m: "CCF", len: 1, c: 4, f: "- 0 0 C" },

  // 0x40..0x7F: LD r,r' block (with HALT at 0x76)
  // generated programmatically below to avoid 64 hand-typed lines of error-prone data.

  // 0x80..0xBF: 8-bit ALU block (ADD/ADC/SUB/SBC/AND/XOR/OR/CP over B C D E H L (HL) A)
  // also generated below.

  0xc0: { m: "RET NZ", len: 1, c: 8, br: 20 },
  0xc1: { m: "POP BC", len: 1, c: 12 },
  0xc2: { m: "JP NZ, a16", len: 3, c: 12, br: 16 },
  0xc3: { m: "JP a16", len: 3, c: 16 },
  0xc4: { m: "CALL NZ, a16", len: 3, c: 12, br: 24 },
  0xc5: { m: "PUSH BC", len: 1, c: 16 },
  0xc6: { m: "ADD A, d8", len: 2, c: 8, f: "Z 0 H C" },
  0xc7: { m: "RST 00H", len: 1, c: 16 },
  0xc8: { m: "RET Z", len: 1, c: 8, br: 20 },
  0xc9: { m: "RET", len: 1, c: 16 },
  0xca: { m: "JP Z, a16", len: 3, c: 12, br: 16 },
  // 0xCB handled by the CB table
  0xcc: { m: "CALL Z, a16", len: 3, c: 12, br: 24 },
  0xcd: { m: "CALL a16", len: 3, c: 24 },
  0xce: { m: "ADC A, d8", len: 2, c: 8, f: "Z 0 H C" },
  0xcf: { m: "RST 08H", len: 1, c: 16 },

  0xd0: { m: "RET NC", len: 1, c: 8, br: 20 },
  0xd1: { m: "POP DE", len: 1, c: 12 },
  0xd2: { m: "JP NC, a16", len: 3, c: 12, br: 16 },
  0xd3: { m: "ILLEGAL", len: 1, c: 4 },
  0xd4: { m: "CALL NC, a16", len: 3, c: 12, br: 24 },
  0xd5: { m: "PUSH DE", len: 1, c: 16 },
  0xd6: { m: "SUB d8", len: 2, c: 8, f: "Z 1 H C" },
  0xd7: { m: "RST 10H", len: 1, c: 16 },
  0xd8: { m: "RET C", len: 1, c: 8, br: 20 },
  0xd9: { m: "RETI", len: 1, c: 16 },
  0xda: { m: "JP C, a16", len: 3, c: 12, br: 16 },
  0xdb: { m: "ILLEGAL", len: 1, c: 4 },
  0xdc: { m: "CALL C, a16", len: 3, c: 12, br: 24 },
  0xdd: { m: "ILLEGAL", len: 1, c: 4 },
  0xde: { m: "SBC A, d8", len: 2, c: 8, f: "Z 1 H C" },
  0xdf: { m: "RST 18H", len: 1, c: 16 },

  0xe0: { m: "LDH (a8), A", len: 2, c: 12 },
  0xe1: { m: "POP HL", len: 1, c: 12 },
  0xe2: { m: "LD (C), A", len: 1, c: 8 },
  0xe3: { m: "ILLEGAL", len: 1, c: 4 },
  0xe4: { m: "ILLEGAL", len: 1, c: 4 },
  0xe5: { m: "PUSH HL", len: 1, c: 16 },
  0xe6: { m: "AND d8", len: 2, c: 8, f: "Z 0 1 0" },
  0xe7: { m: "RST 20H", len: 1, c: 16 },
  0xe8: { m: "ADD SP, r8", len: 2, c: 16, f: "0 0 H C" },
  0xe9: { m: "JP (HL)", len: 1, c: 4 },
  0xea: { m: "LD (a16), A", len: 3, c: 16 },
  0xeb: { m: "ILLEGAL", len: 1, c: 4 },
  0xec: { m: "ILLEGAL", len: 1, c: 4 },
  0xed: { m: "ILLEGAL", len: 1, c: 4 },
  0xee: { m: "XOR d8", len: 2, c: 8, f: "Z 0 0 0" },
  0xef: { m: "RST 28H", len: 1, c: 16 },

  0xf0: { m: "LDH A, (a8)", len: 2, c: 12 },
  0xf1: { m: "POP AF", len: 1, c: 12, f: "Z N H C" },
  0xf2: { m: "LD A, (C)", len: 1, c: 8 },
  0xf3: { m: "DI", len: 1, c: 4 },
  0xf4: { m: "ILLEGAL", len: 1, c: 4 },
  0xf5: { m: "PUSH AF", len: 1, c: 16 },
  0xf6: { m: "OR d8", len: 2, c: 8, f: "Z 0 0 0" },
  0xf7: { m: "RST 30H", len: 1, c: 16 },
  0xf8: { m: "LD HL, SP+r8", len: 2, c: 12, f: "0 0 H C" },
  0xf9: { m: "LD SP, HL", len: 1, c: 8 },
  0xfa: { m: "LD A, (a16)", len: 3, c: 16 },
  0xfb: { m: "EI", len: 1, c: 4 },
  0xfc: { m: "ILLEGAL", len: 1, c: 4 },
  0xfd: { m: "ILLEGAL", len: 1, c: 4 },
  0xfe: { m: "CP d8", len: 2, c: 8, f: "Z 1 H C" },
  0xff: { m: "RST 38H", len: 1, c: 16 },
};

/** Register order used by the 0x40-0xBF regular encodings. Index = low 3 bits. */
const R = ["B", "C", "D", "E", "H", "L", "(HL)", "A"] as const;

/** Fill in the 0x40..0x7F LD r,r' block + HALT. */
function fillLoadBlock(): void {
  for (let op = 0x40; op <= 0x7f; op++) {
    if (op === 0x76) {
      BASE[op] = { m: "HALT", len: 1, c: 4 };
      continue;
    }
    const dest = R[(op >> 3) & 7]!;
    const src = R[op & 7]!;
    // Memory-touching forms cost 8 t-cycles, register-only forms 4.
    const touchesMem = dest === "(HL)" || src === "(HL)";
    BASE[op] = { m: `LD ${dest}, ${src}`, len: 1, c: touchesMem ? 8 : 4 };
  }
}

/** Fill in the 0x80..0xBF 8-bit ALU block. */
function fillAluBlock(): void {
  const ALU: { name: string; f: string }[] = [
    { name: "ADD A,", f: "Z 0 H C" },
    { name: "ADC A,", f: "Z 0 H C" },
    { name: "SUB", f: "Z 1 H C" },
    { name: "SBC A,", f: "Z 1 H C" },
    { name: "AND", f: "Z 0 1 0" },
    { name: "XOR", f: "Z 0 0 0" },
    { name: "OR", f: "Z 0 0 0" },
    { name: "CP", f: "Z 1 H C" },
  ];
  for (let op = 0x80; op <= 0xbf; op++) {
    const alu = ALU[(op >> 3) & 7]!;
    const src = R[op & 7]!;
    const touchesMem = src === "(HL)";
    BASE[op] = { m: `${alu.name} ${src}`.replace(",  ", ", "), len: 1, c: touchesMem ? 8 : 4, f: alu.f };
  }
}

fillLoadBlock();
fillAluBlock();

/**
 * CB-prefixed table, indexed by the byte AFTER 0xCB (0x00..0xFF).
 * Structure: [op group of 8] x [register index].
 * Groups: RLC RRC RL RR SLA SRA SWAP SRL  (0x00..0x3F)
 *         BIT n  (0x40..0x7F)  RES n (0x80..0xBF)  SET n (0xC0..0xFF)
 */
export const CB: Record<number, OpDef> = {};

function fillCB(): void {
  const SHIFT_OPS: { name: string; f: string }[] = [
    { name: "RLC", f: "Z 0 0 C" },
    { name: "RRC", f: "Z 0 0 C" },
    { name: "RL", f: "Z 0 0 C" },
    { name: "RR", f: "Z 0 0 C" },
    { name: "SLA", f: "Z 0 0 C" },
    { name: "SRA", f: "Z 0 0 C" },
    { name: "SWAP", f: "Z 0 0 0" },
    { name: "SRL", f: "Z 0 0 C" },
  ];
  for (let op = 0x00; op <= 0xff; op++) {
    const reg = R[op & 7]!;
    const touchesMem = reg === "(HL)";
    if (op < 0x40) {
      const so = SHIFT_OPS[(op >> 3) & 7]!;
      // (HL) shift/rotate = 16 t-cycles, register = 8
      CB[op] = { m: `${so.name} ${reg}`, len: 2, c: touchesMem ? 16 : 8, f: so.f };
    } else {
      const bit = (op >> 3) & 7;
      if (op < 0x80) {
        // BIT n,r  -- (HL) form is 12 t-cycles (read only), register 8
        CB[op] = { m: `BIT ${bit}, ${reg}`, len: 2, c: touchesMem ? 12 : 8, f: "Z 0 1 -" };
      } else if (op < 0xc0) {
        CB[op] = { m: `RES ${bit}, ${reg}`, len: 2, c: touchesMem ? 16 : 8 };
      } else {
        CB[op] = { m: `SET ${bit}, ${reg}`, len: 2, c: touchesMem ? 16 : 8 };
      }
    }
  }
}

fillCB();

/** Quick integrity check used by tests: every base & CB slot is defined. */
export function tableCoverage(): { base: number; cb: number } {
  let base = 0;
  let cb = 0;
  for (let i = 0; i <= 0xff; i++) {
    if (i === 0xcb) {
      base++; // CB prefix slot is "covered" by the CB table
      continue;
    }
    if (BASE[i]) base++;
  }
  for (let i = 0; i <= 0xff; i++) if (CB[i]) cb++;
  return { base, cb };
}
