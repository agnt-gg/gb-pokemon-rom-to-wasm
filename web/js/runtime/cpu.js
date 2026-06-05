/**
 * SM83 CPU state + reference interpreter.
 *
 * Two roles:
 *  1. ORACLE — executes decoded Instr using the proven ALU, giving us a ground-truth
 *     trace to diff the recompiled WASM against (anti-drift).
 *  2. FALLBACK — the hybrid recompiler dispatches here for indirect jumps (JP HL, RET)
 *     and any address it didn't statically recompile.
 *
 * Because the interpreter and the lifter share the SAME alu.ts semantics, the two paths
 * are guaranteed consistent by construction. The recompiler's job is to make the common
 * case fast; the interpreter guarantees it's CORRECT.
 */
import * as alu from "./alu.js";
import { decode } from "../recompiler/decoder.js";
export class CPU {
    // 8-bit registers (A,F,B,C,D,E,H,L)
    a = 0;
    f = 0;
    b = 0;
    c = 0;
    d = 0;
    e = 0;
    h = 0;
    l = 0;
    sp = 0xfffe;
    pc = 0x0100;
    // Interrupt master enable + pending EI delay
    ime = false;
    imeScheduled = false;
    halted = false;
    stopped = false;
    /** Total t-cycles executed (drives PPU/timer stepping). */
    cycles = 0;
    mmu;
    constructor(mmu) {
        this.mmu = mmu;
    }
    // --- 16-bit register pair accessors -------------------------------------
    get af() { return (this.a << 8) | (this.f & 0xf0); }
    set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xf0; }
    get bc() { return (this.b << 8) | this.c; }
    set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
    get de() { return (this.d << 8) | this.e; }
    set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
    get hl() { return (this.h << 8) | this.l; }
    set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
    get carry() { return this.f & alu.FLAG_C ? 1 : 0; }
    // --- snapshot for oracle diffing ----------------------------------------
    snapshot() {
        return {
            a: this.a, f: this.f & 0xf0, b: this.b, c: this.c,
            d: this.d, e: this.e, h: this.h, l: this.l,
            sp: this.sp, pc: this.pc, ime: this.ime, cycles: this.cycles,
        };
    }
    // --- fetch + decode at PC (reads through MMU so banking is honored) ------
    fetchDecode() {
        // Pull up to 3 bytes for the decoder. Reading via MMU respects current bank.
        const b0 = this.mmu.read(this.pc);
        const b1 = this.mmu.read((this.pc + 1) & 0xffff);
        const b2 = this.mmu.read((this.pc + 2) & 0xffff);
        const buf = new Uint8Array([b0, b1, b2]);
        return decode(buf, 0, this.pc);
    }
    /** Execute one instruction. Returns t-cycles consumed. */
    step() {
        // EI takes effect AFTER the next instruction.
        const enableImeAfter = this.imeScheduled;
        if (this.halted) {
            this.cycles += 4;
            // wake on pending interrupt
            if (this.mmu.read(0xffff) & this.mmu.rawIoRead(0xff0f) & 0x1f)
                this.halted = false;
            return 4;
        }
        const ins = this.fetchDecode();
        this.pc = (this.pc + ins.length) & 0xffff;
        const consumed = this.exec(ins);
        this.cycles += consumed;
        if (enableImeAfter) {
            this.ime = true;
            this.imeScheduled = false;
        }
        return consumed;
    }
    // --- operand resolution --------------------------------------------------
    readOperand(o) {
        switch (o.kind) {
            case "reg8": return this.getReg8(o.reg);
            case "reg16": return this.getReg16(o.reg);
            case "imm8": return o.value;
            case "imm16": return o.value;
            case "simm8": return o.value;
            case "mem_reg16": return this.mmu.read(this.getReg16(o.reg));
            case "mem_hl_inc": {
                const v = this.mmu.read(this.hl);
                this.hl = (this.hl + 1) & 0xffff;
                return v;
            }
            case "mem_hl_dec": {
                const v = this.mmu.read(this.hl);
                this.hl = (this.hl - 1) & 0xffff;
                return v;
            }
            case "mem_imm16": return this.mmu.read(o.addr);
            case "mem_high_imm8": return this.mmu.read(0xff00 + o.off);
            case "mem_high_c": return this.mmu.read(0xff00 + this.c);
            case "bit": return o.n;
            case "rst": return o.vec;
            default: return 0;
        }
    }
    writeOperand(o, value) {
        value &= 0xff;
        switch (o.kind) {
            case "reg8":
                this.setReg8(o.reg, value);
                return;
            case "mem_reg16":
                this.mmu.write(this.getReg16(o.reg), value);
                return;
            case "mem_hl_inc": {
                this.mmu.write(this.hl, value);
                this.hl = (this.hl + 1) & 0xffff;
                return;
            }
            case "mem_hl_dec": {
                this.mmu.write(this.hl, value);
                this.hl = (this.hl - 1) & 0xffff;
                return;
            }
            case "mem_imm16":
                this.mmu.write(o.addr, value);
                return;
            case "mem_high_imm8":
                this.mmu.write(0xff00 + o.off, value);
                return;
            case "mem_high_c":
                this.mmu.write(0xff00 + this.c, value);
                return;
            default: return;
        }
    }
    getReg8(r) {
        switch (r) {
            case "A": return this.a;
            case "B": return this.b;
            case "C": return this.c;
            case "D": return this.d;
            case "E": return this.e;
            case "H": return this.h;
            case "L": return this.l;
            case "F": return this.f & 0xf0;
            default: return 0;
        }
    }
    setReg8(r, v) {
        v &= 0xff;
        switch (r) {
            case "A":
                this.a = v;
                break;
            case "B":
                this.b = v;
                break;
            case "C":
                this.c = v;
                break;
            case "D":
                this.d = v;
                break;
            case "E":
                this.e = v;
                break;
            case "H":
                this.h = v;
                break;
            case "L":
                this.l = v;
                break;
            case "F":
                this.f = v & 0xf0;
                break;
        }
    }
    getReg16(r) {
        switch (r) {
            case "AF": return this.af;
            case "BC": return this.bc;
            case "DE": return this.de;
            case "HL": return this.hl;
            case "SP": return this.sp;
            case "PC": return this.pc;
            default: return 0;
        }
    }
    setReg16(r, v) {
        v &= 0xffff;
        switch (r) {
            case "AF":
                this.af = v;
                break;
            case "BC":
                this.bc = v;
                break;
            case "DE":
                this.de = v;
                break;
            case "HL":
                this.hl = v;
                break;
            case "SP":
                this.sp = v;
                break;
            case "PC":
                this.pc = v;
                break;
        }
    }
    // --- stack helpers -------------------------------------------------------
    push16(v) {
        this.sp = (this.sp - 1) & 0xffff;
        this.mmu.write(this.sp, (v >> 8) & 0xff);
        this.sp = (this.sp - 1) & 0xffff;
        this.mmu.write(this.sp, v & 0xff);
    }
    pop16() {
        const lo = this.mmu.read(this.sp);
        this.sp = (this.sp + 1) & 0xffff;
        const hi = this.mmu.read(this.sp);
        this.sp = (this.sp + 1) & 0xffff;
        return (hi << 8) | lo;
    }
    condMet(cc) {
        switch (cc) {
            case "NZ": return (this.f & alu.FLAG_Z) === 0;
            case "Z": return (this.f & alu.FLAG_Z) !== 0;
            case "NC": return (this.f & alu.FLAG_C) === 0;
            case "C": return (this.f & alu.FLAG_C) !== 0;
            default: return true;
        }
    }
    // --- the big dispatch ----------------------------------------------------
    exec(ins) {
        const ops = ins.operands;
        const cond = ops.find((o) => o.kind === "cond");
        let branched = false;
        switch (ins.mnemonic) {
            case "NOP": break;
            case "LD": {
                const src = ops[ops.length - 1];
                const dst = ops[0];
                // special: LD HL, SP+r8
                if (ins.text.startsWith("LD HL, SP")) {
                    const r = alu.addSpR8(this.sp, this.readOperand(src) & 0xff);
                    this.hl = r.v;
                    this.f = r.f;
                    break;
                }
                // special: LD (a16), SP  (16-bit store)
                if (dst.kind === "mem_imm16" && src.kind === "reg16" && src.reg === "SP") {
                    this.mmu.write16(dst.addr, this.sp);
                    break;
                }
                // 16-bit register loads
                if (dst.kind === "reg16") {
                    if (src.kind === "reg16")
                        this.setReg16(dst.reg, this.getReg16(src.reg));
                    else
                        this.setReg16(dst.reg, this.readOperand(src));
                    break;
                }
                this.writeOperand(dst, this.readOperand(src));
                break;
            }
            case "LDH": {
                const dst = ops[0];
                const src = ops[1];
                this.writeOperand(dst, this.readOperand(src));
                break;
            }
            case "PUSH":
                this.push16(this.getReg16(ops[0].reg));
                break;
            case "POP": {
                const r = ops[0].reg;
                this.setReg16(r, this.pop16());
                if (r === "AF")
                    this.f &= 0xf0;
                break;
            }
            case "ADD": {
                // ADD A, x  OR  ADD SP, r8
                if (ops[0].kind === "reg16" && ops[0].reg === "SP") {
                    const r = alu.addSpR8(this.sp, this.readOperand(ops[1]) & 0xff);
                    this.sp = r.v;
                    this.f = r.f;
                    break;
                }
                const r = alu.add8(this.a, this.readOperand(ops[ops.length - 1]));
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "ADC": {
                const r = alu.adc8(this.a, this.readOperand(ops[ops.length - 1]), this.carry);
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "SUB": {
                const r = alu.sub8(this.a, this.readOperand(ops[ops.length - 1]));
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "SBC": {
                const r = alu.sbc8(this.a, this.readOperand(ops[ops.length - 1]), this.carry);
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "AND": {
                const r = alu.and8(this.a, this.readOperand(ops[ops.length - 1]));
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "OR": {
                const r = alu.or8(this.a, this.readOperand(ops[ops.length - 1]));
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "XOR": {
                const r = alu.xor8(this.a, this.readOperand(ops[ops.length - 1]));
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "CP": {
                const r = alu.cp8(this.a, this.readOperand(ops[ops.length - 1]));
                this.f = r.f;
                break;
            }
            case "INC": {
                const o = ops[0];
                const r = alu.inc8(this.readOperand(o), this.f);
                this.writeOperand(o, r.v);
                this.f = r.f;
                break;
            }
            case "DEC": {
                const o = ops[0];
                const r = alu.dec8(this.readOperand(o), this.f);
                this.writeOperand(o, r.v);
                this.f = r.f;
                break;
            }
            case "ADD16": {
                const r = alu.add16(this.hl, this.getReg16(ops[1].reg), this.f);
                this.hl = r.v;
                this.f = r.f;
                break;
            }
            case "INC16": {
                const r = ops[0].reg;
                this.setReg16(r, alu.inc16(this.getReg16(r)));
                break;
            }
            case "DEC16": {
                const r = ops[0].reg;
                this.setReg16(r, alu.dec16(this.getReg16(r)));
                break;
            }
            case "DAA": {
                const r = alu.daa(this.a, this.f);
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "CPL": {
                const r = alu.cpl(this.a, this.f);
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "SCF":
                this.f = alu.scf(this.f);
                break;
            case "CCF":
                this.f = alu.ccf(this.f);
                break;
            case "RLCA": {
                const r = alu.rlca(this.a);
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "RRCA": {
                const r = alu.rrca(this.a);
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "RLA": {
                const r = alu.rla(this.a, this.carry);
                this.a = r.v;
                this.f = r.f;
                break;
            }
            case "RRA": {
                const r = alu.rra(this.a, this.carry);
                this.a = r.v;
                this.f = r.f;
                break;
            }
            // CB rotates/shifts/bit ops operate on the single operand (reg or (HL))
            case "RLC":
            case "RRC":
            case "RL":
            case "RR":
            case "SLA":
            case "SRA":
            case "SWAP":
            case "SRL": {
                const o = ops[0];
                const v = this.readOperand(o);
                let r;
                switch (ins.mnemonic) {
                    case "RLC":
                        r = alu.rlc(v);
                        break;
                    case "RRC":
                        r = alu.rrc(v);
                        break;
                    case "RL":
                        r = alu.rl(v, this.carry);
                        break;
                    case "RR":
                        r = alu.rr(v, this.carry);
                        break;
                    case "SLA":
                        r = alu.sla(v);
                        break;
                    case "SRA":
                        r = alu.sra(v);
                        break;
                    case "SWAP":
                        r = alu.swap(v);
                        break;
                    default:
                        r = alu.srl(v);
                        break;
                }
                this.writeOperand(o, r.v);
                this.f = r.f;
                break;
            }
            case "BIT": {
                const n = ops[0].n;
                this.f = alu.bit(n, this.readOperand(ops[1]), this.f);
                break;
            }
            case "RES": {
                const n = ops[0].n;
                const o = ops[1];
                this.writeOperand(o, alu.res(n, this.readOperand(o)));
                break;
            }
            case "SET": {
                const n = ops[0].n;
                const o = ops[1];
                this.writeOperand(o, alu.set(n, this.readOperand(o)));
                break;
            }
            // --- control flow ---
            case "JP": {
                if (ops.length === 1 && ops[0].kind === "mem_reg16") {
                    this.pc = this.hl;
                    break;
                } // JP (HL)
                const target = ops.find((o) => o.kind === "imm16")?.value ?? this.hl;
                if (!cond || this.condMet(cond.cc)) {
                    this.pc = target;
                    branched = true;
                }
                break;
            }
            case "JR": {
                const disp = ops.find((o) => o.kind === "simm8")?.value ?? 0;
                if (!cond || this.condMet(cond.cc)) {
                    this.pc = (this.pc + disp) & 0xffff;
                    branched = true;
                }
                break;
            }
            case "CALL": {
                const target = ops.find((o) => o.kind === "imm16")?.value ?? 0;
                if (!cond || this.condMet(cond.cc)) {
                    this.push16(this.pc);
                    this.pc = target;
                    branched = true;
                }
                break;
            }
            case "RET": {
                if (!cond || this.condMet(cond.cc)) {
                    this.pc = this.pop16();
                    branched = true;
                }
                break;
            }
            case "RETI": {
                this.pc = this.pop16();
                this.ime = true;
                break;
            }
            case "RST": {
                const v = ops[0].vec;
                this.push16(this.pc);
                this.pc = v;
                break;
            }
            case "DI":
                this.ime = false;
                this.imeScheduled = false;
                break;
            case "EI":
                this.imeScheduled = true;
                break;
            case "HALT":
                this.halted = true;
                break;
            case "STOP":
                this.stopped = true;
                break;
            case "ILLEGAL": /* lock up — treat as NOP for resilience */ break;
        }
        // cycle accounting: taken conditional branches cost more
        if (branched && ins.cyclesBranch !== undefined)
            return ins.cyclesBranch;
        return ins.cycles;
    }
    /** Service interrupts. Call between instructions. Returns cycles if one fired. */
    serviceInterrupts() {
        if (!this.ime && !this.halted)
            return 0;
        const ie = this.mmu.read(0xffff);
        const iff = this.mmu.rawIoRead(0xff0f);
        const pending = ie & iff & 0x1f;
        if (!pending)
            return 0;
        this.halted = false;
        if (!this.ime)
            return 0;
        // priority: VBlank(0) LCDStat(1) Timer(2) Serial(3) Joypad(4)
        for (let bit = 0; bit < 5; bit++) {
            if (pending & (1 << bit)) {
                this.ime = false;
                this.mmu.rawIoWrite(0xff0f, iff & ~(1 << bit));
                this.push16(this.pc);
                this.pc = 0x40 + bit * 8;
                this.cycles += 20;
                return 20;
            }
        }
        return 0;
    }
}
