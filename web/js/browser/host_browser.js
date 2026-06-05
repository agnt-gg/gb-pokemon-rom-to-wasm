/**
 * Browser host — instantiates the (server-recompiled) game_logic.wasm and wires the
 * hardware runtime, WITHOUT any Node/wabt dependency.
 *
 * Mirrors wasm_host.ts but takes pre-assembled wasm bytes (fetched from /api/wasm) and the
 * raw ROM bytes (fetched from /api/rom). Builds MMU/PPU/timer/joypad and exposes a Machine
 * the page drives via requestAnimationFrame.
 */
import { MMU } from "../runtime/mmu.js";
import { CPU } from "../runtime/cpu.js";
import { PPU, SCREEN_W, SCREEN_H } from "../runtime/ppu.js";
import { Timer } from "../runtime/timer.js";
import { Joypad } from "../runtime/joypad.js";
import { APU, apuIoHooks } from "../runtime/apu.js";
import { decode } from "../recompiler/decoder.js";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../recompiler/module.js";
export const CPU_HZ = 4194304;
export const CYCLES_PER_FRAME = 70224;
export class BrowserMachine {
    mmu;
    ppu;
    timer;
    joypad;
    apu;
    cpu;
    exports;
    frames = 0;
    tickCb = null;
    constructor(mmu) {
        this.mmu = mmu;
        this.cpu = new CPU(mmu);
        this.ppu = new PPU(mmu);
        this.timer = new Timer(mmu);
        this.joypad = new Joypad(mmu); // registers itself as the IO hook (FF00)
        this.apu = new APU(mmu);
        // Chain APU register IO (FF10-FF3F) in front of the joypad's hook so both coexist.
        const cgbHook = {
            readIO: (addr) => this.mmu.readCgbIo(addr),
            writeIO: (addr, value) => {
                if ((addr >= 0xff51 && addr <= 0xff55) || [0xff4d, 0xff4f, 0xff68, 0xff69, 0xff6a, 0xff6b, 0xff70].includes(addr)) {
                    this.mmu.handleCgbIoWrite(addr, value & 0xff);
                    return true;
                }
                return false;
            }
        };
        const chain = {
            readIO: (addr) => { const v = this.joypad.readIO(addr); if (v !== null)
                return v; return cgbHook.readIO(addr); },
            writeIO: (addr, value) => this.joypad.writeIO(addr, value) || cgbHook.writeIO(addr, value),
        };
        mmu.setIoHooks(apuIoHooks(this.apu, chain));
    }
    static async create(wasmBytes, romBytes) {
        const forceCgb = (romBytes[0x0143] ?? 0) === 0xc0;
        const mmu = new MMU(romBytes, forceCgb ? "CGB" : "DMG");
        const m = new BrowserMachine(mmu);
        const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
        let exportsRef = null;
        const cpu = m.cpu;
        const wasmToCpu = () => {
            cpu.a = exportsRef.get_A();
            cpu.f = exportsRef.get_F() & 0xf0;
            cpu.b = exportsRef.get_B();
            cpu.c = exportsRef.get_C();
            cpu.d = exportsRef.get_D();
            cpu.e = exportsRef.get_E();
            cpu.h = exportsRef.get_H();
            cpu.l = exportsRef.get_L();
            cpu.sp = exportsRef.get_SP();
            cpu.pc = exportsRef.get_PC();
        };
        const cpuToWasm = () => {
            exportsRef.set_A(cpu.a);
            exportsRef.set_F(cpu.f & 0xf0);
            exportsRef.set_B(cpu.b);
            exportsRef.set_C(cpu.c);
            exportsRef.set_D(cpu.d);
            exportsRef.set_E(cpu.e);
            exportsRef.set_H(cpu.h);
            exportsRef.set_L(cpu.l);
            exportsRef.set_SP(cpu.sp);
            exportsRef.set_PC(cpu.pc);
        };
        const imports = {
            env: {
                mem: memory,
                rb: (addr) => mmu.read(addr & 0xffff),
                wb: (addr, val) => mmu.write(addr & 0xffff, val & 0xff),
                tick: (c) => { cpu.cycles += c; if (m.tickCb)
                    m.tickCb(c); },
                interp: (addr) => {
                    // Execute one fallback instruction with CPU.step-like PC/EI semantics. Important:
                    // the lifter already emitted the instruction's base `$tick` before calling `$interp`,
                    // so DO NOT add cycles here or PPU/timer/cpu time double-counts fallback ops.
                    wasmToCpu();
                    const b0 = mmu.read(addr), b1 = mmu.read((addr + 1) & 0xffff), b2 = mmu.read((addr + 2) & 0xffff);
                    const ins = decode(new Uint8Array([b0, b1, b2]), 0, addr);
                    const enableImeAfter = cpu.imeScheduled;
                    cpu.pc = (addr + ins.length) & 0xffff;
                    cpu.exec(ins);
                    if (enableImeAfter) {
                        cpu.ime = true;
                        cpu.imeScheduled = false;
                    }
                    cpuToWasm();
                },
                dispatch: (pc) => pc,
                set_ime: (v) => { cpu.ime = !!v; },
                sched_ei: () => { cpu.imeScheduled = true; },
                set_halt: (v) => { cpu.halted = !!v; },
            },
        };
        const result = await WebAssembly.instantiate(wasmBytes, imports);
        exportsRef = result.instance.exports;
        m.exports = exportsRef;
        // PPU/timer/APU step in lockstep with cycles
        m.tickCb = (c) => { m.ppu.step(c); m.timer.step(c); m.apu.step(c); };
        // Seed post-boot state (skips needing the copyrighted boot ROM). Crystal is CGB-only,
        // so it must see CGB identity registers rather than the DMG boot signature.
        if (mmu.isCgb()) {
            exportsRef.set_A(0x11);
            exportsRef.set_F(0x80);
            exportsRef.set_B(0x00);
            exportsRef.set_C(0x00);
        }
        else {
            exportsRef.set_A(0x01);
            exportsRef.set_F(0xb0);
            exportsRef.set_B(0x00);
            exportsRef.set_C(0x13);
        }
        exportsRef.set_D(0x00);
        exportsRef.set_E(mmu.isCgb() ? 0x08 : 0xd8);
        exportsRef.set_H(0x01);
        exportsRef.set_L(0x4d);
        exportsRef.set_SP(0xfffe);
        exportsRef.set_PC(0x0100);
        const io = [
            [0xff40, 0x91], [0xff47, 0xfc], [0xff48, 0xff], [0xff49, 0xff], [0xff0f, 0x00], [0xffff, 0x00],
            [0xff4d, mmu.isCgb() ? 0x80 : 0x7e], [0xff4f, 0xfe], [0xff55, 0xff], [0xff68, 0x00], [0xff6a, 0x00], [0xff70, 0xf9],
        ];
        for (const [a, v] of io)
            mmu.rawIoWrite(a, v);
        return m;
    }
    // diagnostics surfaced to the page
    lastStall = "";
    // Execution mode. The hand-written interpreter is the verified oracle: it boots and renders
    // Pokemon Red correctly. The recompiled WASM fast-path is a progressive accelerator that is
    // still being validated block-by-block against the oracle, so it defaults OFF. Flip to false
    // to opt into the (faster but not-yet-fully-verified) recompiled blocks for fixed ROM bank 0.
    interpreterOnly = false;
    syncWasmToCpu() {
        const ex = this.exports, cpu = this.cpu;
        cpu.a = ex.get_A();
        cpu.f = ex.get_F() & 0xf0;
        cpu.b = ex.get_B();
        cpu.c = ex.get_C();
        cpu.d = ex.get_D();
        cpu.e = ex.get_E();
        cpu.h = ex.get_H();
        cpu.l = ex.get_L();
        cpu.sp = ex.get_SP();
        cpu.pc = ex.get_PC();
    }
    syncCpuToWasm() {
        const ex = this.exports, cpu = this.cpu;
        ex.set_A(cpu.a);
        ex.set_F(cpu.f & 0xf0);
        ex.set_B(cpu.b);
        ex.set_C(cpu.c);
        ex.set_D(cpu.d);
        ex.set_E(cpu.e);
        ex.set_H(cpu.h);
        ex.set_L(cpu.l);
        ex.set_SP(cpu.sp);
        ex.set_PC(cpu.pc);
    }
    runCycles(target) {
        const cpu = this.cpu;
        const ex = this.exports;
        const start = cpu.cycles;
        // Per-frame instruction budget. One DMG frame is ~17.5k machine cycles of work; cap at a
        // generous 200k loop iterations so a pathological path can never freeze the tab — it just
        // ends the frame early and we try again next rAF (self-healing).
        let guard = 0;
        const GUARD_MAX = 200_000;
        while (cpu.cycles - start < target && guard++ < GUARD_MAX) {
            // --- service interrupts ---
            this.syncWasmToCpu();
            const ic = cpu.serviceInterrupts();
            if (ic > 0) {
                this.syncCpuToWasm();
                if (this.tickCb)
                    this.tickCb(ic);
            }
            if (cpu.halted) {
                // burn time until an interrupt wakes us
                cpu.cycles += 4;
                if (this.tickCb)
                    this.tickCb(4);
                if (cpu.serviceInterrupts() > 0) {
                    cpu.halted = false;
                    this.syncCpuToWasm();
                }
                continue;
            }
            const cur = ex.get_PC() & 0xffff;
            const cyBefore = cpu.cycles;
            // INTERPRETER-FIRST MODE: route everything through the proven interpreter. Correct by
            // construction (the interpreter is the oracle that boots/renders the ROM). We interpret a
            // batch of instructions per outer iteration to amortize the wasm<->cpu sync cost.
            if (this.interpreterOnly) {
                this.syncWasmToCpu();
                let inner = 0;
                while (inner++ < 4096 && !cpu.halted && (cpu.cycles - start) < target) {
                    const b = cpu.cycles;
                    cpu.step();
                    if (this.tickCb)
                        this.tickCb(cpu.cycles - b);
                    // break out periodically to re-check interrupts at a sane cadence
                    const i2 = cpu.serviceInterrupts();
                    if (i2 > 0) {
                        if (this.tickCb)
                            this.tickCb(i2);
                    }
                }
                this.syncCpuToWasm();
                continue;
            }
            // BANK-WINDOW GUARD: statically-lifted blocks in the switchable ROM window
            // (0x4000-0x7FFF) were compiled from whatever bank was mapped at build time, but the
            // live bank may differ -> the static block would run phantom code. Route these through
            // the interpreter, which reads the CURRENT bank via the MMU. Interpret until PC leaves
            // the window (or a budget) so we don't pay sync cost per instruction in tight bank loops.
            // The recompiler only safely covers FIXED ROM bank 0 (0x0000-0x3FFF). Everything else —
            // the switchable bank window (0x4000-0x7FFF, may be a different live bank) and all
            // RAM-resident code (VRAM/SRAM/WRAM/echo/HRAM at >=0x8000) — must be interpreted against
            // live memory, since those bytes are written at runtime and were never statically lifted.
            const inFixedRom = cur < 0x4000;
            // TITLE/OVERWORLD TIMING GUARD:
            // Traces showed the delay is not only the 0x1d57 wait loop; the HRAM transition flags
            // it waits on are written by nearby fixed-ROM driver routines around 0x184b/0x1876/0x1d9c
            // and related 0x1dxx/0x20xx code. Running this band as multi-instruction WASM blocks
            // changes the VBlank/HRAM cadence and delays the title/overworld transition by ~180 frames.
            // Route this timing-sensitive fixed-ROM driver band through the oracle interpreter while
            // keeping the rest of fixed ROM on generated WASM blocks.
            if (cur >= 0x1800 && cur <= 0x2100) {
                this.syncWasmToCpu();
                let inner = 0;
                while ((cpu.pc & 0xffff) >= 0x1800 && (cpu.pc & 0xffff) <= 0x2100 && inner++ < 1024 && !cpu.halted && (cpu.cycles - start) < target) {
                    const b = cpu.cycles;
                    cpu.step();
                    if (this.tickCb)
                        this.tickCb(cpu.cycles - b);
                    const ic2 = cpu.serviceInterrupts();
                    if (ic2 > 0 && this.tickCb)
                        this.tickCb(ic2);
                }
                this.syncCpuToWasm();
                continue;
            }
            if (!inFixedRom) {
                this.syncWasmToCpu();
                let inner = 0;
                while (((cpu.pc & 0xffff) >= 0x4000) && inner++ < 4096 && !cpu.halted && (cpu.cycles - start) < target) {
                    const b = cpu.cycles;
                    cpu.step();
                    if (this.tickCb)
                        this.tickCb(cpu.cycles - b);
                    // Crucial for title/menu/input/audio progression: banked-code fallback can spend long
                    // stretches in 0x4000+, so service interrupts inside the stretch rather than waiting
                    // until PC returns to fixed ROM. Otherwise VBlank/Joypad/Timer work can lag or starve.
                    const ic2 = cpu.serviceInterrupts();
                    if (ic2 > 0 && this.tickCb)
                        this.tickCb(ic2);
                    if ((cpu.pc & 0xffff) < 0x4000)
                        break;
                }
                this.syncCpuToWasm();
                continue;
            }
            const next = ex.run(cur);
            if (next === SENTINEL_HALT) {
                cpu.halted = true;
                this.syncWasmToCpu();
            }
            else if (next === UNKNOWN_BLOCK) {
                // interpret one instruction (RAM code / indirect / not-yet-lifted)
                this.syncWasmToCpu();
                const b = cpu.cycles;
                cpu.step();
                if (this.tickCb)
                    this.tickCb(cpu.cycles - b);
                this.syncCpuToWasm();
            }
            // else: a recompiled block ran; it set PC + called $tick internally.
            // --- forward-progress guard ---
            // If neither cycles advanced NOR PC changed, we'd spin forever. Force a single
            // interpreted step to break the deadlock, and if THAT also fails to move, bail the frame.
            const pcAfter = ex.get_PC() & 0xffff;
            if (cpu.cycles === cyBefore && pcAfter === cur) {
                this.syncWasmToCpu();
                const pcPreStep = cpu.pc;
                cpu.step();
                if (cpu.cycles === cyBefore && cpu.pc === pcPreStep) {
                    // genuinely stuck — record and abandon this frame so the tab stays alive
                    this.lastStall = "stuck @0x" + cur.toString(16);
                    cpu.cycles += 4; // nudge so the outer guard can't infinite-loop
                }
                this.syncCpuToWasm();
                if (this.tickCb)
                    this.tickCb(4);
            }
        }
    }
    runFrame() {
        this.ppu.frameReady = false;
        this.runCycles(CYCLES_PER_FRAME);
        this.frames++;
    }
    /**
     * Real-time pacing entrypoint for browser rAF loops. Instead of assuming the browser
     * renders exactly 59.7275 times/sec, run the number of Game Boy t-cycles matching the
     * actual elapsed wall-clock milliseconds. This keeps game time correct without chunky
     * multi-frame catch-up that hides intermediate animation frames.
     */
    runForMilliseconds(ms) {
        const clamped = Math.max(1, Math.min(50, ms));
        const cycles = Math.max(4, Math.round((CPU_HZ * clamped) / 1000));
        this.ppu.frameReady = false;
        this.runCycles(cycles);
        this.frames++;
    }
    setButton(b, pressed) { this.joypad.setButton(b, pressed); }
    /** Pull accumulated stereo audio samples since the last call (host feeds these to Web Audio). */
    drainAudio() { return this.apu.drain(); }
    get audioQueued() { return this.apu.queued; }
    setAudioSampleRate(_hz) { }
    get framebuffer() { return this.ppu.framebuffer; }
    get width() { return SCREEN_W; }
    get height() { return SCREEN_H; }
    // ---------------------------------------------------------------------------
    // SAVE SYSTEM
    // ---------------------------------------------------------------------------
    /** Stable per-cartridge key (header title) used to namespace saves in storage. */
    saveKey() {
        const t = this.mmu.romTitle().replace(/[^A-Za-z0-9_]/g, "") || "UNKNOWN";
        return "gbrecomp:" + t;
    }
    hasBattery() { return this.mmu.hasBattery(); }
    // ---- Battery save (cartridge SRAM only — the real .sav file) ----
    /** The cartridge's battery-backed SRAM bytes (compatible with standard .sav files). */
    getBatterySave() { return new Uint8Array(this.mmu.getExtRam()); }
    /** Load a .sav (battery SRAM) into the cartridge. */
    loadBatterySave(data) { this.mmu.loadExtRam(data); }
    // ---- Save-state (full machine snapshot — instant restore anywhere) ----
    /** Capture CPU + MMU + PPU + Timer into a JSON-serializable object. */
    snapshot() {
        this.syncWasmToCpu(); // pull live registers out of WASM globals first
        const cpu = this.cpu;
        return {
            version: 1,
            title: this.mmu.romTitle(),
            frames: this.frames,
            cpu: {
                a: cpu.a, f: cpu.f, b: cpu.b, c: cpu.c, d: cpu.d, e: cpu.e, h: cpu.h, l: cpu.l,
                sp: cpu.sp, pc: cpu.pc, ime: cpu.ime, halted: cpu.halted, cycles: cpu.cycles,
            },
            mmu: this.mmu.serializeState(),
            ppu: this.ppu.serializeState(),
            timer: this.timer.serializeState(),
        };
    }
    /** Restore a previously captured snapshot and re-sync the CPU into WASM. */
    restore(s) {
        const cpu = this.cpu;
        cpu.a = s.cpu.a;
        cpu.f = s.cpu.f;
        cpu.b = s.cpu.b;
        cpu.c = s.cpu.c;
        cpu.d = s.cpu.d;
        cpu.e = s.cpu.e;
        cpu.h = s.cpu.h;
        cpu.l = s.cpu.l;
        cpu.sp = s.cpu.sp;
        cpu.pc = s.cpu.pc;
        cpu.ime = s.cpu.ime;
        cpu.halted = s.cpu.halted;
        cpu.cycles = s.cpu.cycles;
        this.mmu.loadState(s.mmu);
        this.ppu.loadState(s.ppu);
        this.timer.loadState(s.timer);
        this.frames = s.frames;
        this.syncCpuToWasm(); // push restored registers back into WASM globals
    }
}
