/**
 * Joypad — the FF00 P1/JOYP register.
 *
 * The GB multiplexes 8 buttons onto 4 lines, selected by bits 4/5 of FF00:
 *   bit5 = 0 -> action buttons (Start Select B A) on bits 3..0
 *   bit4 = 0 -> direction buttons (Down Up Left Right) on bits 3..0
 * Buttons are ACTIVE-LOW (0 = pressed). A press can request the Joypad interrupt (IF bit 4).
 *
 * The host wires keydown/keyup to setButton(). The MMU routes FF00 reads here via IoHooks.
 */
export class Joypad {
    mmu;
    // state: true = pressed
    dir = { right: false, left: false, up: false, down: false };
    act = { a: false, b: false, select: false, start: false };
    selectButtons = false; // bit5 low
    selectDirs = false; // bit4 low
    constructor(mmu) {
        this.mmu = mmu;
        mmu.setIoHooks(this);
    }
    setButton(b, pressed) {
        const before = this.anyPressed();
        if (b in this.dir)
            this.dir[b] = pressed;
        else
            this.act[b] = pressed;
        // Request joypad interrupt on a fresh press (high->low transition).
        if (!before && pressed) {
            const iff = this.mmu.rawIoRead(0xff0f);
            this.mmu.rawIoWrite(0xff0f, iff | 0x10);
        }
    }
    anyPressed() {
        return Object.values(this.dir).some(Boolean) || Object.values(this.act).some(Boolean);
    }
    readIO(addr) {
        if (addr !== 0xff00)
            return null;
        let nibble = 0x0f; // all released (high)
        if (this.selectDirs) {
            nibble =
                (this.dir.down ? 0 : 8) |
                    (this.dir.up ? 0 : 4) |
                    (this.dir.left ? 0 : 2) |
                    (this.dir.right ? 0 : 1);
        }
        else if (this.selectButtons) {
            nibble =
                (this.act.start ? 0 : 8) |
                    (this.act.select ? 0 : 4) |
                    (this.act.b ? 0 : 2) |
                    (this.act.a ? 0 : 1);
        }
        // upper bits: 11 + the two select bits (active low)
        const sel = (this.selectButtons ? 0 : 0x20) | (this.selectDirs ? 0 : 0x10);
        return 0xc0 | sel | (nibble & 0x0f);
    }
    writeIO(addr, value) {
        if (addr !== 0xff00)
            return false;
        // game selects which group by clearing bit4 (dirs) or bit5 (buttons)
        this.selectDirs = (value & 0x10) === 0;
        this.selectButtons = (value & 0x20) === 0;
        return true;
    }
}
