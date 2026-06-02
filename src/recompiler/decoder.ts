/**
 * SM83 decoder: bytes -> structured Instr.
 *
 * Given a byte buffer (a ROM bank's view) and an offset, produce a fully-resolved
 * Instruction with parsed operands, immediates filled in, length, cycles, and
 * control-flow classification. The lifter consumes Instr directly.
 */

import { BASE, CB, ILLEGAL_OPCODES, type OpDef } from "./opcodes.ts";
import type {
  Cond,
  Instr,
  Mnemonic,
  Operand,
  Reg16,
  Reg8,
} from "./types.ts";

const REG8 = new Set<Reg8>(["A", "B", "C", "D", "E", "H", "L", "F"]);
const REG16 = new Set<Reg16>(["AF", "BC", "DE", "HL", "SP", "PC"]);
const CONDS = new Set(["NZ", "Z", "NC", "C"]);

/** read little-endian u16 */
function rd16(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8)) & 0xffff;
}

/** signed 8-bit */
function s8(v: number): number {
  return v & 0x80 ? v - 0x100 : v;
}

/**
 * Parse one operand token from an opcode template, resolving immediates against
 * the byte stream. `imm8`/`imm16`/`r8` placeholders read from `buf` at `immOff`.
 */
function parseOperand(
  tok: string,
  buf: Uint8Array,
  immOff: number,
  allowCond: boolean,
): Operand | null {
  tok = tok.trim();
  if (tok === "") return null;

  // Condition codes (NZ/Z/NC/C) ONLY apply to control-flow ops (JP/JR/CALL/RET).
  // Otherwise the token "C" is the 8-bit register C, not the carry condition.
  // This is critical: misreading register C as a condition turns INC C / DEC C / LD C,n
  // into no-ops, which silently breaks copy loops (e.g. the OAM-DMA-to-HRAM routine).
  if (allowCond && CONDS.has(tok)) return { kind: "cond", cc: tok as Cond };

  // immediates
  if (tok === "d8") return { kind: "imm8", value: buf[immOff]! };
  if (tok === "d16" || tok === "a16") return { kind: "imm16", value: rd16(buf, immOff) };
  if (tok === "r8") return { kind: "simm8", value: s8(buf[immOff]!) };
  if (tok === "a8") return { kind: "imm8", value: buf[immOff]! };

  // special pointer/offset forms
  if (tok === "(a16)") return { kind: "mem_imm16", addr: rd16(buf, immOff) };
  if (tok === "(a8)") return { kind: "mem_high_imm8", off: buf[immOff]! };
  if (tok === "(C)") return { kind: "mem_high_c" };
  if (tok === "(HL+)") return { kind: "mem_hl_inc" };
  if (tok === "(HL-)") return { kind: "mem_hl_dec" };
  if (tok === "(BC)") return { kind: "mem_reg16", reg: "BC" };
  if (tok === "(DE)") return { kind: "mem_reg16", reg: "DE" };
  if (tok === "(HL)") return { kind: "mem_reg16", reg: "HL" };

  // SP+r8 (special; encode as reg16 SP, the lifter recognizes the mnemonic)
  if (tok === "SP+r8") return { kind: "simm8", value: s8(buf[immOff]!) };

  // RST vectors come from the mnemonic, handled by caller; here treat "00H".."38H"
  if (/^[0-9A-F]{2}H$/.test(tok)) {
    return { kind: "rst", vec: parseInt(tok.slice(0, 2), 16) };
  }

  // bit index (CB ops)  e.g. operand "3"
  if (/^[0-7]$/.test(tok)) return { kind: "bit", n: parseInt(tok, 10) };

  // registers
  if (REG16.has(tok as Reg16)) return { kind: "reg16", reg: tok as Reg16 };
  if (REG8.has(tok as Reg8)) return { kind: "reg8", reg: tok as Reg8 };

  return null;
}

/** Map a template head word to a canonical Mnemonic, accounting for 16-bit ALU variants. */
function resolveMnemonic(head: string, def: OpDef): Mnemonic {
  // 16-bit add: "ADD HL, ..." or "ADD SP, r8" stay as ADD/ADD16 distinction
  if (head === "ADD") {
    if (def.m.startsWith("ADD HL")) return "ADD16";
    return "ADD"; // ADD A,.. and ADD SP,r8 (lifter checks operands)
  }
  if (head === "INC") return def.m.match(/INC (BC|DE|HL|SP)/) ? "INC16" : "INC";
  if (head === "DEC") return def.m.match(/DEC (BC|DE|HL|SP)/) ? "DEC16" : "DEC";
  return head as Mnemonic;
}

/**
 * Decode a single instruction at buf[off].
 * `baseAddr` is the logical address the instruction lives at (for addr field & JR math).
 */
export function decode(buf: Uint8Array, off: number, baseAddr: number): Instr {
  const opcode = buf[off]!;

  // CB prefix
  if (opcode === 0xcb) {
    const cbByte = buf[off + 1]!;
    const def = CB[cbByte]!;
    const instr = expand(def, buf, off, baseAddr, opcode, cbByte);
    return instr;
  }

  const def = BASE[opcode];
  if (!def || def.m === "ILLEGAL" || ILLEGAL_OPCODES.has(opcode)) {
    return {
      addr: baseAddr,
      opcode,
      mnemonic: "ILLEGAL",
      operands: [],
      length: 1,
      cycles: 4,
      text: `ILLEGAL ${hex2(opcode)}`,
      isTerminator: true,
    };
  }

  return expand(def, buf, off, baseAddr, opcode);
}

function expand(
  def: OpDef,
  buf: Uint8Array,
  off: number,
  baseAddr: number,
  opcode: number,
  cbByte?: number,
): Instr {
  // template like "LD B, d8" -> head="LD", rest="B, d8"
  const spaceIdx = def.m.indexOf(" ");
  const head = spaceIdx === -1 ? def.m : def.m.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : def.m.slice(spaceIdx + 1);

  const mnemonic = resolveMnemonic(head, def);

  // Immediates begin after the opcode byte(s). For CB ops the operands are register/bit,
  // never immediates, so immOff only matters for base ops.
  const immOff = off + (cbByte !== undefined ? 2 : 1);

  // Only JP/JR/CALL/RET take condition-code operands; for every other mnemonic the bare
  // tokens NZ/Z/NC/C must be parsed as registers/other forms (in practice only "C" collides).
  const allowCond = head === "JP" || head === "JR" || head === "CALL" || head === "RET";
  const operands: Operand[] = [];
  if (rest) {
    for (const tok of rest.split(",")) {
      const o = parseOperand(tok, buf, immOff, allowCond);
      if (o) operands.push(o);
    }
  }

  // RST vector lives in the mnemonic text ("RST 00H")
  if (mnemonic === "RST") {
    const vecTok = rest.trim();
    operands.length = 0;
    operands.push({ kind: "rst", vec: parseInt(vecTok.slice(0, 2), 16) });
  }

  const { isTerminator, staticTargets } = classifyFlow(
    mnemonic,
    operands,
    baseAddr,
    def.len,
  );

  return {
    addr: baseAddr,
    opcode,
    cbByte,
    mnemonic,
    operands,
    length: def.len,
    cycles: def.c,
    cyclesBranch: def.br,
    text: renderText(def.m, operands),
    isTerminator,
    staticTargets,
  };
}

/** Determine if an instruction ends a basic block and what static targets it has. */
function classifyFlow(
  m: Mnemonic,
  operands: Operand[],
  baseAddr: number,
  len: number,
): { isTerminator: boolean; staticTargets?: number[] } {
  const next = (baseAddr + len) & 0xffff;
  switch (m) {
    case "JP": {
      // JP (HL) is indirect -> terminator, no static target (runtime dispatch)
      const imm = operands.find((o) => o.kind === "imm16");
      const cond = operands.find((o) => o.kind === "cond");
      if (!imm) return { isTerminator: true }; // JP (HL)
      const tgt = imm.kind === "imm16" ? imm.value : 0;
      return cond
        ? { isTerminator: true, staticTargets: [tgt, next] }
        : { isTerminator: true, staticTargets: [tgt] };
    }
    case "JR": {
      const simm = operands.find((o) => o.kind === "simm8");
      const cond = operands.find((o) => o.kind === "cond");
      const disp = simm && simm.kind === "simm8" ? simm.value : 0;
      const tgt = (next + disp) & 0xffff;
      return cond
        ? { isTerminator: true, staticTargets: [tgt, next] }
        : { isTerminator: true, staticTargets: [tgt] };
    }
    case "CALL": {
      const imm = operands.find((o) => o.kind === "imm16");
      const tgt = imm && imm.kind === "imm16" ? imm.value : 0;
      // CALL continues to `next` after return; target is a separate block entry
      return { isTerminator: true, staticTargets: [tgt, next] };
    }
    case "RST": {
      const r = operands.find((o) => o.kind === "rst");
      const tgt = r && r.kind === "rst" ? r.vec : 0;
      return { isTerminator: true, staticTargets: [tgt, next] };
    }
    case "RET":
    case "RETI":
      return { isTerminator: true }; // indirect via stack
    case "ILLEGAL":
    case "HALT":
    case "STOP":
      return { isTerminator: true };
    default:
      return { isTerminator: false };
  }
}

function renderText(template: string, operands: Operand[]): string {
  // Replace immediate placeholders with concrete hex for readable disassembly.
  let i = 0;
  return template.replace(/d8|d16|a16|r8|a8/g, () => {
    const o = operands.filter(
      (x) =>
        x.kind === "imm8" ||
        x.kind === "imm16" ||
        x.kind === "simm8" ||
        x.kind === "mem_imm16" ||
        x.kind === "mem_high_imm8",
    )[i++];
    if (!o) return "??";
    if (o.kind === "imm8") return "$" + hex2(o.value);
    if (o.kind === "imm16") return "$" + hex4(o.value);
    if (o.kind === "simm8") return (o.value >= 0 ? "+" : "") + o.value;
    if (o.kind === "mem_imm16") return "$" + hex4(o.addr);
    if (o.kind === "mem_high_imm8") return "$" + hex2(o.off);
    return "??";
  });
}

export function hex2(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, "0");
}
export function hex4(v: number): string {
  return v.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Linear-sweep disassemble a byte range. Returns instructions in address order.
 * (The block-graph builder uses recursive-descent from entry points instead;
 *  this linear sweep is for inspection, tests, and coverage reporting.)
 */
export function disassembleRange(
  buf: Uint8Array,
  start: number,
  end: number,
  baseAddr: number,
): Instr[] {
  const out: Instr[] = [];
  let off = start;
  let addr = baseAddr;
  while (off < end) {
    const instr = decode(buf, off, addr);
    out.push(instr);
    off += instr.length;
    addr = (addr + instr.length) & 0xffff;
  }
  return out;
}
