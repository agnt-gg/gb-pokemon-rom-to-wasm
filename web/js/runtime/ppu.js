/**
 * PPU — the Game Boy Pixel Processing Unit.
 *
 * This is the "console" half that turns the recompiled CPU's VRAM/OAM/register writes into
 * actual pixels. It implements:
 *   - the 4 LCD modes + STAT interrupt + LY/LYC compare + VBlank interrupt
 *   - background rendering (LCDC tile-map / tile-data selection, SCX/SCY scroll)
 *   - window rendering (WX/WY)
 *   - sprite (OBJ) rendering (8x8 and 8x16, X/Y flip, priority, palette OBP0/OBP1)
 *   - the DMG 4-shade palette (BGP/OBP0/OBP1)
 *
 * Output is a 160x144 RGBA framebuffer the browser blits to a <canvas>.
 *
 * Registers (all in 0xFF40-0xFF4B):
 *   FF40 LCDC  FF41 STAT  FF42 SCY  FF43 SCX  FF44 LY  FF45 LYC
 *   FF47 BGP   FF48 OBP0  FF49 OBP1 FF4A WY   FF4B WX
 */
export const SCREEN_W = 160;
export const SCREEN_H = 144;
// LCD mode timing in t-cycles (DMG):
//   Mode 2 (OAM scan)   = 80
//   Mode 3 (draw)       = 172 (approx, fixed here)
//   Mode 0 (HBlank)     = 204
//   total per scanline  = 456 ; 144 visible lines + 10 VBlank lines = 154 lines/frame
const OAM_CYCLES = 80;
const DRAW_CYCLES = 172;
const LINE_CYCLES = 456;
const VBLANK_LINE = 144;
const TOTAL_LINES = 154;
// The classic DMG green-tinted 4-shade palette (lightest -> darkest), RGBA.
const SHADES = [
    [0xe0, 0xf8, 0xd0], // 0 lightest
    [0x88, 0xc0, 0x70], // 1
    [0x34, 0x68, 0x56], // 2
    [0x08, 0x18, 0x20], // 3 darkest
];
export class PPU {
    mmu;
    /** 160*144*4 RGBA bytes. */
    framebuffer = new Uint8Array(SCREEN_W * SCREEN_H * 4);
    /** Set true at the end of a frame (line 153 -> 0 wrap). The host blits & clears it. */
    frameReady = false;
    modeClock = 0;
    windowLine = 0;
    /** Snapshot PPU timing state for save-states (LCD regs live in MMU.io). */
    serializeState() {
        return { modeClock: this.modeClock, windowLine: this.windowLine };
    }
    loadState(s) {
        this.modeClock = s.modeClock;
        this.windowLine = s.windowLine;
    }
    constructor(mmu) {
        this.mmu = mmu;
        // Init LCDC to a sane "on" value so a fresh boot isn't a black void before the game writes it.
        this.mmu.rawIoWrite(0xff40, 0x91);
        this.mmu.rawIoWrite(0xff47, 0xfc); // BGP
    }
    get lcdc() { return this.mmu.rawIoRead(0xff40); }
    get scy() { return this.mmu.rawIoRead(0xff42); }
    get scx() { return this.mmu.rawIoRead(0xff43); }
    get ly() { return this.mmu.rawIoRead(0xff44); }
    set ly(v) { this.mmu.rawIoWrite(0xff44, v & 0xff); }
    get lyc() { return this.mmu.rawIoRead(0xff45); }
    get wy() { return this.mmu.rawIoRead(0xff4a); }
    get wx() { return this.mmu.rawIoRead(0xff4b); }
    get bgp() { return this.mmu.rawIoRead(0xff47); }
    get obp0() { return this.mmu.rawIoRead(0xff48); }
    get obp1() { return this.mmu.rawIoRead(0xff49); }
    get stat() { return this.mmu.rawIoRead(0xff41); }
    set stat(v) { this.mmu.rawIoWrite(0xff41, v & 0xff); }
    requestInterrupt(bit) {
        const iff = this.mmu.rawIoRead(0xff0f);
        this.mmu.rawIoWrite(0xff0f, iff | (1 << bit));
    }
    setMode(mode) {
        this.stat = (this.stat & ~0x03) | (mode & 0x03);
        // STAT interrupt sources: bit3 HBlank(0), bit4 VBlank(1), bit5 OAM(2)
        if (mode === 0 && this.stat & 0x08)
            this.requestInterrupt(1);
        if (mode === 2 && this.stat & 0x20)
            this.requestInterrupt(1);
    }
    checkLyc() {
        if (this.ly === this.lyc) {
            this.stat |= 0x04;
            if (this.stat & 0x40)
                this.requestInterrupt(1); // LYC=LY STAT interrupt
        }
        else {
            this.stat &= ~0x04;
        }
    }
    /** Advance the PPU by `cycles` t-cycles, driven from the machine's frame loop. */
    step(cycles) {
        // LCD off? hold LY=0, mode 0.
        // Important: do NOT call setMode(0) here. setMode() raises STAT interrupts when the
        // corresponding mode interrupt source bit is enabled. On real hardware, disabling the LCD
        // does not create an endless stream of fresh HBlank STAT interrupts every CPU tick. Yellow's
        // attract/title transition temporarily disables LCD while STAT bit 3 can remain set; raising
        // a synthetic interrupt here traps the CPU in the 0x48 STAT vector forever with LCDC bit 7
        // off. Just force the mode bits to 0 silently while LCD is disabled.
        if (!(this.lcdc & 0x80)) {
            this.modeClock = 0;
            this.ly = 0;
            this.stat = this.stat & ~0x03;
            return;
        }
        this.modeClock += cycles;
        const mode = this.stat & 0x03;
        switch (mode) {
            case 2: // OAM scan
                if (this.modeClock >= OAM_CYCLES) {
                    this.modeClock -= OAM_CYCLES;
                    this.setMode(3);
                }
                break;
            case 3: // drawing
                if (this.modeClock >= DRAW_CYCLES) {
                    this.modeClock -= DRAW_CYCLES;
                    this.renderScanline(this.ly);
                    this.setMode(0); // -> HBlank
                    this.mmu.stepHdmaHblank?.();
                }
                break;
            case 0: // HBlank
                if (this.modeClock >= LINE_CYCLES - OAM_CYCLES - DRAW_CYCLES) {
                    this.modeClock -= LINE_CYCLES - OAM_CYCLES - DRAW_CYCLES;
                    this.ly = this.ly + 1;
                    this.checkLyc();
                    if (this.ly === VBLANK_LINE) {
                        this.setMode(1); // -> VBlank
                        this.requestInterrupt(0); // VBlank interrupt (bit 0)
                        this.frameReady = true;
                    }
                    else {
                        this.setMode(2);
                    }
                }
                break;
            case 1: // VBlank (10 lines)
                if (this.modeClock >= LINE_CYCLES) {
                    this.modeClock -= LINE_CYCLES;
                    this.ly = this.ly + 1;
                    if (this.ly > TOTAL_LINES - 1) {
                        this.ly = 0;
                        this.windowLine = 0;
                        this.setMode(2); // back to OAM scan for new frame
                        this.checkLyc();
                    }
                    else {
                        this.checkLyc();
                    }
                }
                break;
        }
    }
    // --- rendering -----------------------------------------------------------
    vram(addr, bank = 0) {
        // addr is 0x8000-0x9FFF logical
        return this.mmu.readVram ? this.mmu.readVram(addr, bank) : (this.mmu.getVram()[addr - 0x8000] ?? 0);
    }
    shadeForColor(palette, colorId) {
        const shade = (palette >> (colorId * 2)) & 0x03;
        return SHADES[shade];
    }
    renderScanline(line) {
        const lcdc = this.lcdc;
        const fb = this.framebuffer;
        const rowBase = line * SCREEN_W * 4;
        // Per-pixel BG color id buffer (for sprite priority vs BG color 0).
        const bgColorIds = new Uint8Array(SCREEN_W);
        // --- Background ---
        if (lcdc & 0x01) {
            const bgMapBase = lcdc & 0x08 ? 0x9c00 : 0x9800;
            const tileDataBase = lcdc & 0x10 ? 0x8000 : 0x9000; // signed when 0x9000
            const signed = !(lcdc & 0x10);
            const y = (line + this.scy) & 0xff;
            const tileRow = (y >> 3) & 0x1f;
            for (let x = 0; x < SCREEN_W; x++) {
                const sx = (x + this.scx) & 0xff;
                const tileCol = (sx >> 3) & 0x1f;
                const mapAddr = bgMapBase + tileRow * 32 + tileCol;
                let tileIdx = this.vram(mapAddr, 0);
                const attr = this.mmu.isCgb() ? this.vram(mapAddr, 1) : 0;
                let tileAddr;
                if (signed) {
                    const ss = tileIdx > 127 ? tileIdx - 256 : tileIdx;
                    tileAddr = tileDataBase + ss * 16;
                }
                else {
                    tileAddr = tileDataBase + tileIdx * 16;
                }
                let py = y & 7;
                if (attr & 0x40)
                    py = 7 - py;
                const tileBank = this.mmu.isCgb() ? ((attr >> 3) & 1) : 0;
                const lo = this.vram(tileAddr + py * 2, tileBank);
                const hi = this.vram(tileAddr + py * 2 + 1, tileBank);
                const bit = (attr & 0x20) ? (sx & 7) : 7 - (sx & 7);
                const colorId = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
                bgColorIds[x] = colorId;
                const [r, g, b] = this.mmu.isCgb() ? this.mmu.getBgPaletteColor(attr & 7, colorId) : this.shadeForColor(this.bgp, colorId);
                const o = rowBase + x * 4;
                fb[o] = r;
                fb[o + 1] = g;
                fb[o + 2] = b;
                fb[o + 3] = 255;
            }
        }
        else {
            // BG off -> white
            for (let x = 0; x < SCREEN_W; x++) {
                const o = rowBase + x * 4;
                fb[o] = SHADES[0][0];
                fb[o + 1] = SHADES[0][1];
                fb[o + 2] = SHADES[0][2];
                fb[o + 3] = 255;
            }
        }
        // --- Window ---
        if (lcdc & 0x20 && line >= this.wy) {
            const wxAdj = this.wx - 7;
            if (wxAdj < SCREEN_W) {
                const winMapBase = lcdc & 0x40 ? 0x9c00 : 0x9800;
                const tileDataBase = lcdc & 0x10 ? 0x8000 : 0x9000;
                const signed = !(lcdc & 0x10);
                const wy = this.windowLine;
                const tileRow = (wy >> 3) & 0x1f;
                let drew = false;
                for (let x = Math.max(0, wxAdj); x < SCREEN_W; x++) {
                    const wxp = x - wxAdj;
                    const tileCol = (wxp >> 3) & 0x1f;
                    const mapAddr = winMapBase + tileRow * 32 + tileCol;
                    const tileIdx = this.vram(mapAddr, 0);
                    const attr = this.mmu.isCgb() ? this.vram(mapAddr, 1) : 0;
                    let tileAddr;
                    if (signed) {
                        const ss = tileIdx > 127 ? tileIdx - 256 : tileIdx;
                        tileAddr = tileDataBase + ss * 16;
                    }
                    else {
                        tileAddr = tileDataBase + tileIdx * 16;
                    }
                    let py = wy & 7;
                    if (attr & 0x40)
                        py = 7 - py;
                    const tileBank = this.mmu.isCgb() ? ((attr >> 3) & 1) : 0;
                    const lo = this.vram(tileAddr + py * 2, tileBank);
                    const hi = this.vram(tileAddr + py * 2 + 1, tileBank);
                    const bit = (attr & 0x20) ? (wxp & 7) : 7 - (wxp & 7);
                    const colorId = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
                    bgColorIds[x] = colorId;
                    const [r, g, b] = this.mmu.isCgb() ? this.mmu.getBgPaletteColor(attr & 7, colorId) : this.shadeForColor(this.bgp, colorId);
                    const o = rowBase + x * 4;
                    fb[o] = r;
                    fb[o + 1] = g;
                    fb[o + 2] = b;
                    fb[o + 3] = 255;
                    drew = true;
                }
                if (drew)
                    this.windowLine++;
            }
        }
        // --- Sprites (OBJ) ---
        if (lcdc & 0x02) {
            const tall = (lcdc & 0x04) !== 0;
            const spriteH = tall ? 16 : 8;
            const oam = this.mmu.getOam();
            // GB renders up to 10 sprites/line; lower OAM index = higher priority on DMG.
            let drawn = 0;
            for (let i = 0; i < 40 && drawn < 10; i++) {
                const sy = oam[i * 4] - 16;
                const sx = oam[i * 4 + 1] - 8;
                let tile = oam[i * 4 + 2];
                const attr = oam[i * 4 + 3];
                if (line < sy || line >= sy + spriteH)
                    continue;
                drawn++;
                const flipY = (attr & 0x40) !== 0;
                const flipX = (attr & 0x20) !== 0;
                const palette = attr & 0x10 ? this.obp1 : this.obp0;
                const objPalette = attr & 0x07;
                const objBank = this.mmu.isCgb() ? ((attr >> 3) & 1) : 0;
                const behindBg = (attr & 0x80) !== 0;
                let row = line - sy;
                if (flipY)
                    row = spriteH - 1 - row;
                if (tall)
                    tile &= 0xfe; // 8x16 ignores low bit
                const tileAddr = 0x8000 + tile * 16 + row * 2;
                const lo = this.vram(tileAddr, objBank);
                const hi = this.vram(tileAddr + 1, objBank);
                for (let px = 0; px < 8; px++) {
                    const xx = sx + px;
                    if (xx < 0 || xx >= SCREEN_W)
                        continue;
                    const bit = flipX ? px : 7 - px;
                    const colorId = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
                    if (colorId === 0)
                        continue; // transparent
                    if (behindBg && bgColorIds[xx] !== 0)
                        continue; // BG priority
                    const [r, g, b] = this.mmu.isCgb() ? this.mmu.getObjPaletteColor(objPalette, colorId) : this.shadeForColor(palette, colorId);
                    const o = rowBase + xx * 4;
                    fb[o] = r;
                    fb[o + 1] = g;
                    fb[o + 2] = b;
                    fb[o + 3] = 255;
                }
            }
        }
    }
}
