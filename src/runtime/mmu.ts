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

export type MbcKind = "NONE" | "MBC1" | "MBC3";

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
    // pokered is MBC3 (0x13: MBC3+RAM+BATTERY). Default to MBC3 for safety on Pokemon carts.
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
      if (!this.extRamEnabled || this.extRam.length === 0) return 0xff;
      const off = this.ramBank * 0x2000 + (addr - 0xa000);
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
      if (this.extRamEnabled && this.extRam.length > 0) {
        const off = this.ramBank * 0x2000 + (addr - 0xa000);
        this.extRam[off % this.extRam.length] = value;
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
        // RAM bank number (0-3) or RTC register select (0x08-0x0C)
        this.ramBank = value & 0x0f;
      }
      // 0x6000-0x7FFF: latch clock data (RTC) — ignored for base pokered
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
    };
  }
  /** Restore a previously serialized MMU state. */
  loadState(s: MmuState): void {
    this.vram.set(s.vram); this.wram.set(s.wram); this.oam.set(s.oam);
    this.hram.set(s.hram); this.io.set(s.io); this.ie = s.ie;
    this.extRam.set(Uint8Array.from(s.extRam).subarray(0, this.extRam.length));
    this.romBank = s.romBank; this.ramBank = s.ramBank;
    this.bankingMode = s.bankingMode; this.extRamEnabled = s.extRamEnabled;
  }

  /** Header title (0x0134-0x0143), trimmed. */
  romTitle(): string {
    let s = "";
    for (let i = 0x0134; i <= 0x0143; i++) {
      const c = this.rom[i] ?? 0;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }
}
