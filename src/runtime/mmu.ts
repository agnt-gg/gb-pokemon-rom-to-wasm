/**
 * Memory bus + MBC (Memory Bank Controller) for the Game Boy.
 *
 * The recompiled code never touches a raw array — every load/store goes through read()/write()
 * so that bank switching, MMIO side effects, and echo/forbidden regions behave faithfully.
 *
 * Pokemon Red uses MBC3 (no RTC in the base cart): 2 MB ROM max (128 banks of 16 KB),
 * 32 KB RAM max (4 banks of 8 KB). We implement MBC1/MBC3 well enough for pokered/pokeyellow.
 *
 * Address map (16-bit space):
 *   0x0000-0x3FFF  ROM bank 00 (fixed)
 *   0x4000-0x7FFF  ROM bank NN (switchable)
 *   0x8000-0x9FFF  VRAM (8 KB)
 *   0xA000-0xBFFF  External cart RAM (switchable, if present)
 *   0xC000-0xDFFF  WRAM (8 KB)
 *   0xE000-0xFDFF  Echo of WRAM (mirror of C000-DDFF)
 *   0xFE00-0xFE9F  OAM (sprite attribute table)
 *   0xFEA0-0xFEFF  Forbidden / unusable
 *   0xFF00-0xFF7F  I/O registers (handled via the IO hook)
 *   0xFF80-0xFFFE  HRAM (high RAM)
 *   0xFFFF         IE (interrupt enable)
 */

export type MbcKind = "NONE" | "MBC1" | "MBC3" | "MBC5";

export interface IoHooks {
  /** Called for reads in 0xFF00-0xFF7F. Return the byte, or null to fall through to raw IO array. */
  readIO(addr: number): number | null;
  /** Called for writes in 0xFF00-0xFF7F. Return true if handled. */
  writeIO(addr: number, value: number): boolean;
}

/** Full snapshot of all mutable MMU memory + MBC banking state (for save-states). */
export interface MmuState {
  vram: number[]; wram: number[]; oam: number[]; hram: number[]; io: number[];
  ie: number; extRam: number[];
  romBank: number; ramBank: number; bankingMode: number; extRamEnabled: boolean;
  rtcBaseUnixMs?: number; rtcLatched?: boolean; rtcLatchLast?: number; rtcLatchedRegs?: number[]; rtcRegs?: number[];
}

export class MMU {
  readonly rom: Uint8Array;
  readonly romBankCount: number;
  readonly mbc: MbcKind;

  // Memory regions
  private vram = new Uint8Array(0x2000);
  private wram = new Uint8Array(0x2000);
  private oam = new Uint8Array(0xa0);
  private hram = new Uint8Array(0x7f);
  private io = new Uint8Array(0x80);
  private ie = 0;

  // External cart RAM
  private extRam: Uint8Array;
  private extRamEnabled = false;

  // MBC state
  private romBank = 1; // bank mapped at 0x4000-0x7FFF (never 0 for the switchable window)
  private ramBank = 0;
  private bankingMode = 0; // MBC1 mode select

  // MBC3 real-time clock state. Gold/Silver use cart type 0x10 (MBC3+TIMER+RAM+BATTERY).
  // We keep a simple wall-clock-backed RTC and implement register select + latch semantics.
  private rtcBaseUnixMs = Date.now();
  private rtcLatched = false;
  private rtcLatchLast = 0xff;
  private rtcLatchedRegs = new Uint8Array(5);
  private rtcRegs = new Uint8Array(5); // writable halted snapshot registers; index 0..4 maps 0x08..0x0c

  private hooks: IoHooks | null = null;

  constructor(rom: Uint8Array) {
    this.rom = rom;
    this.romBankCount = Math.max(2, Math.floor(rom.length / 0x4000));
    this.mbc = MMU.detectMbc(rom);
    const ramSize = MMU.detectRamSize(rom);
    this.extRam = new Uint8Array(ramSize);
  }

  setIoHooks(h: IoHooks): void {
    this.hooks = h;
  }

  /** Cartridge type byte at 0x0147 -> MBC family. */
  static detectMbc(rom: Uint8Array): MbcKind {
    const t = rom[0x0147] ?? 0;
    if (t === 0x00 || t === 0x08 || t === 0x09) return "NONE";
    if (t >= 0x01 && t <= 0x03) return "MBC1";
    if (t >= 0x0f && t <= 0x13) return "MBC3";
    if (t >= 0x19 && t <= 0x1e) return "MBC5";
    // pokered/pokeblue are MBC3. Unknown Pokemon-era carts are more likely banked than ROM-only,
    // so default to MBC3 for backwards compatibility with the original Red target.
    return "MBC3";
  }

  /** RAM size byte at 0x0149. */
  static detectRamSize(rom: Uint8Array): number {
    const s = rom[0x0149] ?? 0;
    switch (s) {
      case 0x00: return 0;
      case 0x01: return 0x800; // 2 KB
      case 0x02: return 0x2000; // 8 KB
      case 0x03: return 0x8000; // 32 KB (4 banks)
      case 0x04: return 0x20000; // 128 KB
      case 0x05: return 0x10000; // 64 KB
      default: return 0x2000;
    }
  }

  get currentRomBank(): number {
    return this.romBank;
  }

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------
  read(addr: number): number {
    addr &= 0xffff;

    if (addr < 0x4000) {
      // Fixed bank 0 (MBC1 advanced mode can remap this, but pokered doesn't rely on it)
      return this.rom[addr] ?? 0xff;
    }
    if (addr < 0x8000) {
      const bank = this.romBank % this.romBankCount;
      const off = bank * 0x4000 + (addr - 0x4000);
      return this.rom[off] ?? 0xff;
    }
    if (addr < 0xa000) {
      return this.vram[addr - 0x8000]!;
    }
    if (addr < 0xc000) {
      if (!this.extRamEnabled) return 0xff;
      if (this.mbc === "MBC3" && this.ramBank >= 0x08 && this.ramBank <= 0x0c) {
        return this.readRtcReg(this.ramBank);
      }
      if (this.extRam.length === 0) return 0xff;
      const bank = this.ramBank & 0x03;
      const off = bank * 0x2000 + (addr - 0xa000);
      return this.extRam[off % this.extRam.length] ?? 0xff;
    }
    if (addr < 0xe000) {
      return this.wram[addr - 0xc000]!;
    }
    if (addr < 0xfe00) {
      // Echo RAM
      return this.wram[addr - 0xe000]!;
    }
    if (addr < 0xfea0) {
      return this.oam[addr - 0xfe00]!;
    }
    if (addr < 0xff00) {
      return 0xff; // forbidden region reads as 0xFF (approx)
    }
    if (addr < 0xff80) {
      if (this.hooks) {
        const v = this.hooks.readIO(addr);
        if (v !== null) return v & 0xff;
      }
      return this.io[addr - 0xff00]!;
    }
    if (addr < 0xffff) {
      return this.hram[addr - 0xff80]!;
    }
    return this.ie;
  }

  read16(addr: number): number {
    return this.read(addr) | (this.read((addr + 1) & 0xffff) << 8);
  }

  // -------------------------------------------------------------------------
  // WRITE
  // -------------------------------------------------------------------------
  write(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;

    if (addr < 0x8000) {
      this.mbcWrite(addr, value);
      return;
    }
    if (addr < 0xa000) {
      this.vram[addr - 0x8000] = value;
      return;
    }
    if (addr < 0xc000) {
      if (this.extRamEnabled) {
        if (this.mbc === "MBC3" && this.ramBank >= 0x08 && this.ramBank <= 0x0c) {
          this.writeRtcReg(this.ramBank, value);
          return;
        }
        if (this.extRam.length > 0) {
          const bank = this.mbc === "MBC3" ? (this.ramBank & 0x03) : this.ramBank;
          const off = bank * 0x2000 + (addr - 0xa000);
          this.extRam[off % this.extRam.length] = value;
        }
      }
      return;
    }
    if (addr < 0xe000) {
      this.wram[addr - 0xc000] = value;
      return;
    }
    if (addr < 0xfe00) {
      this.wram[addr - 0xe000] = value; // echo
      return;
    }
    if (addr < 0xfea0) {
      this.oam[addr - 0xfe00] = value;
      return;
    }
    if (addr < 0xff00) {
      return; // forbidden
    }
    if (addr < 0xff80) {
      if (this.hooks && this.hooks.writeIO(addr, value)) return;
      this.io[addr - 0xff00] = value;
      // OAM DMA: writing FF46 copies 160 bytes from page (value << 8) into OAM (0xFE00).
      // Pokemon (and virtually every commercial game) uploads its sprite attribute table
      // this way every frame from a WRAM shadow buffer (page 0xC3). Without this, OAM stays
      // empty and ALL sprites — the player, NPCs, Oak — are invisible while the BG renders fine.
      if (addr === 0xff46) {
        const src = (value & 0xff) << 8;
        for (let i = 0; i < 0xa0; i++) {
          this.oam[i] = this.read((src + i) & 0xffff);
        }
      }
      return;
    }
    if (addr < 0xffff) {
      this.hram[addr - 0xff80] = value;
      return;
    }
    this.ie = value;
  }

  write16(addr: number, value: number): void {
    this.write(addr, value & 0xff);
    this.write((addr + 1) & 0xffff, (value >> 8) & 0xff);
  }

  // -------------------------------------------------------------------------
  // MBC register writes (the bank-switching logic)
  // -------------------------------------------------------------------------
  private mbcWrite(addr: number, value: number): void {
    if (this.mbc === "MBC5") {
      if (addr < 0x2000) {
        // RAM enable (0x0A in low nibble), same external RAM gate convention as MBC1/MBC3.
        this.extRamEnabled = (value & 0x0f) === 0x0a;
      } else if (addr < 0x3000) {
        // MBC5 ROM bank lower 8 bits. Unlike MBC1/MBC3, bank 0 is valid in the switchable window.
        this.romBank = (this.romBank & 0x100) | value;
      } else if (addr < 0x4000) {
        // MBC5 ROM bank bit 8. Yellow is 1 MiB (64 banks), but keep the full 9-bit behavior.
        this.romBank = (this.romBank & 0x0ff) | ((value & 0x01) << 8);
      } else if (addr < 0x6000) {
        // RAM bank select. Non-rumble MBC5 carts expose up to 16 RAM banks.
        this.ramBank = value & 0x0f;
      }
      this.romBank %= this.romBankCount;
      return;
    }

    if (this.mbc === "MBC3") {
      if (addr < 0x2000) {
        // RAM + timer enable (0x0A in low nibble)
        this.extRamEnabled = (value & 0x0f) === 0x0a;
      } else if (addr < 0x4000) {
        // ROM bank number (7 bits). Bank 0 maps to 1.
        let b = value & 0x7f;
        if (b === 0) b = 1;
        this.romBank = b;
      } else if (addr < 0x6000) {
        // RAM bank number (0-3) or RTC register select (0x08-0x0C).
        this.ramBank = value & 0x0f;
      } else {
        // RTC latch sequence: write 0 then 1 to 0x6000-0x7FFF.
        const v = value & 0x01;
        if (this.rtcLatchLast === 0 && v === 1) this.latchRtc();
        this.rtcLatchLast = v;
      }
      return;
    }

    if (this.mbc === "MBC1") {
      if (addr < 0x2000) {
        this.extRamEnabled = (value & 0x0f) === 0x0a;
      } else if (addr < 0x4000) {
        // lower 5 bits of ROM bank; 0 -> 1
        let lo = value & 0x1f;
        if (lo === 0) lo = 1;
        this.romBank = (this.romBank & 0x60) | lo;
      } else if (addr < 0x6000) {
        const hi = value & 0x03;
        if (this.bankingMode === 0) {
          this.romBank = (this.romBank & 0x1f) | (hi << 5);
        } else {
          this.ramBank = hi;
        }
      } else {
        this.bankingMode = value & 1;
      }
      return;
    }

    // NONE: ignore
  }

  // -------------------------------------------------------------------------
  // Direct region access for the PPU / debugger / save system
  // -------------------------------------------------------------------------
  getVram(): Uint8Array { return this.vram; }
  getOam(): Uint8Array { return this.oam; }
  getIoArray(): Uint8Array { return this.io; }
  rawIoRead(addr: number): number { return this.io[addr - 0xff00] ?? 0; }
  rawIoWrite(addr: number, v: number): void { this.io[addr - 0xff00] = v & 0xff; }
  getExtRam(): Uint8Array { return this.extRam; }
  loadExtRam(data: Uint8Array): void { this.extRam.set(data.subarray(0, this.extRam.length)); }

  private currentRtcRegs(): Uint8Array {
    const out = new Uint8Array(5);
    const control = this.rtcRegs[4] ?? 0;
    if (control & 0x40) { // halted: expose the writable frozen values
      out.set(this.rtcRegs);
      return out;
    }
    let seconds = Math.max(0, Math.floor((Date.now() - this.rtcBaseUnixMs) / 1000));
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    out[0] = seconds % 60;
    out[1] = Math.floor(seconds / 60) % 60;
    out[2] = Math.floor(seconds / 3600) % 24;
    out[3] = days & 0xff;
    out[4] = (control & 0x40) | ((days >> 8) & 0x01) | (days > 511 ? 0x80 : 0x00);
    return out;
  }

  private latchRtc(): void {
    this.rtcLatchedRegs.set(this.currentRtcRegs());
    this.rtcLatched = true;
  }

  private readRtcReg(sel: number): number {
    const idx = sel - 0x08;
    const regs = this.rtcLatched ? this.rtcLatchedRegs : this.currentRtcRegs();
    return regs[idx] ?? 0xff;
  }

  private writeRtcReg(sel: number, value: number): void {
    const idx = sel - 0x08;
    if (idx < 0 || idx > 4) return;
    const regs = this.currentRtcRegs();
    regs[idx] = value & 0xff;
    // Rebase the wall clock so the written h/m/s/day values become the new current time.
    const days = (regs[3] | ((regs[4] & 0x01) << 8)) & 0x1ff;
    const seconds = days * 86400 + (regs[2] % 24) * 3600 + (regs[1] % 60) * 60 + (regs[0] % 60);
    this.rtcBaseUnixMs = Date.now() - seconds * 1000;
    this.rtcRegs.set(regs);
  }

  /** True if the cartridge has battery-backed save RAM (so saving is meaningful). */
  hasBattery(): boolean {
    const type = this.rom[0x0147] ?? 0;
    // MBC1/2/3/5 +RAM+BATTERY cartridge type bytes
    return [0x03, 0x06, 0x09, 0x0d, 0x0f, 0x10, 0x13, 0x1b, 0x1e, 0xff].includes(type);
  }

  // ---- Full save-state serialization (snapshot of ALL volatile memory + MBC state) ----
  /** Snapshot every mutable memory region + banking state into one object. */
  serializeState(): MmuState {
    return {
      vram: Array.from(this.vram),
      wram: Array.from(this.wram),
      oam: Array.from(this.oam),
      hram: Array.from(this.hram),
      io: Array.from(this.io),
      ie: this.ie,
      extRam: Array.from(this.extRam),
      romBank: this.romBank,
      ramBank: this.ramBank,
      bankingMode: this.bankingMode,
      extRamEnabled: this.extRamEnabled,
      rtcBaseUnixMs: this.rtcBaseUnixMs,
      rtcLatched: this.rtcLatched,
      rtcLatchLast: this.rtcLatchLast,
      rtcLatchedRegs: Array.from(this.rtcLatchedRegs),
      rtcRegs: Array.from(this.rtcRegs),
    };
  }
  /** Restore a previously serialized MMU state. */
  loadState(s: MmuState): void {
    this.vram.set(s.vram); this.wram.set(s.wram); this.oam.set(s.oam);
    this.hram.set(s.hram); this.io.set(s.io); this.ie = s.ie;
    this.extRam.set(Uint8Array.from(s.extRam).subarray(0, this.extRam.length));
    this.romBank = s.romBank; this.ramBank = s.ramBank;
    this.bankingMode = s.bankingMode; this.extRamEnabled = s.extRamEnabled;
    if (s.rtcBaseUnixMs !== undefined) this.rtcBaseUnixMs = s.rtcBaseUnixMs;
    if (s.rtcLatched !== undefined) this.rtcLatched = s.rtcLatched;
    if (s.rtcLatchLast !== undefined) this.rtcLatchLast = s.rtcLatchLast;
    if (s.rtcLatchedRegs) this.rtcLatchedRegs.set(Uint8Array.from(s.rtcLatchedRegs).subarray(0, 5));
    if (s.rtcRegs) this.rtcRegs.set(Uint8Array.from(s.rtcRegs).subarray(0, 5));
  }

  /** Header title. Old carts use 0x0134-0x0143; CGB-era carts shorten title to 0x0134-0x013E and use 0x013F-0x0142 as manufacturer code. */
  romTitle(): string {
    let s = "";
    const cgb = this.rom[0x0143] ?? 0;
    const end = (cgb === 0x80 || cgb === 0xc0) ? 0x013e : 0x0143;
    for (let i = 0x0134; i <= end; i++) {
      const c = this.rom[i] ?? 0;
      if (c === 0) break;
      // Keep printable ASCII title bytes only; avoids manufacturer/CGB flag artifacts in save keys.
      if (c >= 0x20 && c <= 0x7e) s += String.fromCharCode(c);
    }
    return s.trim();
  }
}
