/**
 * Machine — the whole Game Boy: recompiled CPU + PPU + timer + joypad + MMU.
 *
 * This is what the browser shell talks to. It builds the recompiled WASM from the ROM,
 * wires the hardware runtime, and exposes a frame loop:
 *
 *   const m = await Machine.create(romBytes);
 *   m.setButton("a", true);
 *   m.runFrame();              // advance ~70224 t-cycles (one DMG frame)
 *   const fb = m.framebuffer;  // 160x144 RGBA, blit to canvas
 *
 * The PPU/timer step in lockstep with CPU cycles via the host's tick callback, so VBlank,
 * STAT, and timer interrupts fire at the right moments — which is what actually drives the
 * game's main loop forward (Pokemon's engine waits on VBlank every frame).
 */

import { MMU } from "./mmu.ts";
import { PPU, SCREEN_W, SCREEN_H } from "./ppu.ts";
import { Timer } from "./timer.ts";
import { Joypad, type Button } from "./joypad.ts";
import { instantiateRecomp, type RecompInstance } from "./wasm_host.ts";
import { buildBlocks, buildModuleWat } from "../recompiler/module.ts";

// One DMG frame = 154 scanlines * 456 t-cycles = 70224 t-cycles (~59.7 Hz).
export const CYCLES_PER_FRAME = 70224;

const STANDARD_ENTRIES = [
  0x0100, 0x0150,
  0x0000, 0x0008, 0x0010, 0x0018, 0x0020, 0x0028, 0x0030, 0x0038,
  0x0040, 0x0048, 0x0050, 0x0058, 0x0060,
];

export class Machine {
  mmu: MMU;
  ppu: PPU;
  timer: Timer;
  joypad: Joypad;
  recomp: RecompInstance;
  frames = 0;

  private constructor(mmu: MMU, ppu: PPU, timer: Timer, joypad: Joypad, recomp: RecompInstance) {
    this.mmu = mmu; this.ppu = ppu; this.timer = timer; this.joypad = joypad; this.recomp = recomp;
  }

  static async create(rom: Uint8Array, opts: { maxBlocks?: number } = {}): Promise<Machine> {
    const mmu = new MMU(rom);
    const ppu = new PPU(mmu);
    const timer = new Timer(mmu);
    const joypad = new Joypad(mmu);

    // Statically recompile the reachable ROM blocks.
    const mem = (a: number) => mmu.read(a);
    const blocks = buildBlocks(mem, STANDARD_ENTRIES, { maxBlocks: opts.maxBlocks ?? 20000 });
    const wat = buildModuleWat(blocks);
    const recomp = await instantiateRecomp(wat, mmu);

    // Drive PPU + timer in lockstep with every CPU cycle the recompiled/interpreted code burns.
    recomp.onTick((cycles) => {
      ppu.step(cycles);
      timer.step(cycles);
    });

    // Seed post-boot CPU state. The DMG boot ROM leaves these well-known values; jumping
    // straight to 0x0100 with them set lets the cartridge's own init run correctly without
    // needing the (copyrighted) boot ROM.
    const ex = recomp.exports;
    ex.set_A(0x01); ex.set_F(0xb0);
    ex.set_B(0x00); ex.set_C(0x13);
    ex.set_D(0x00); ex.set_E(0xd8);
    ex.set_H(0x01); ex.set_L(0x4d);
    ex.set_SP(0xfffe);
    ex.set_PC(0x0100);

    // Post-boot I/O register state (what the boot ROM leaves behind).
    const io: [number, number][] = [
      [0xff05, 0x00], [0xff06, 0x00], [0xff07, 0x00],
      [0xff10, 0x80], [0xff11, 0xbf], [0xff12, 0xf3], [0xff14, 0xbf],
      [0xff40, 0x91], [0xff42, 0x00], [0xff43, 0x00], [0xff45, 0x00],
      [0xff47, 0xfc], [0xff48, 0xff], [0xff49, 0xff], [0xff4a, 0x00], [0xff4b, 0x00],
      [0xff0f, 0x00], [0xffff, 0x00],
    ];
    for (const [a, v] of io) mmu.rawIoWrite(a, v);

    return new Machine(mmu, ppu, timer, joypad, recomp);
  }

  /** Advance one full frame (~70224 t-cycles). The PPU sets frameReady at VBlank. */
  runFrame(): void {
    this.ppu.frameReady = false;
    this.recomp.runCycles(CYCLES_PER_FRAME);
    this.frames++;
  }

  setButton(b: Button, pressed: boolean): void {
    this.joypad.setButton(b, pressed);
  }

  get framebuffer(): Uint8Array { return this.ppu.framebuffer; }
  get width(): number { return SCREEN_W; }
  get height(): number { return SCREEN_H; }

  /** Battery-backed save RAM (for export/import). */
  getSaveRam(): Uint8Array { return this.mmu.getExtRam(); }
  loadSaveRam(data: Uint8Array): void { this.mmu.loadExtRam(data); }
}
