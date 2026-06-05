/**
 * Timer + divider registers.
 *   FF04 DIV   — increments at 16384 Hz (every 256 t-cycles); any write resets to 0
 *   FF05 TIMA  — timer counter; increments at the rate selected by TAC
 *   FF06 TMA   — timer modulo; TIMA reloads to this on overflow
 *   FF07 TAC   — bit2 enable; bits1-0 clock select (00:4096 01:262144 10:65536 11:16384 Hz)
 * On TIMA overflow, requests the Timer interrupt (IF bit 2).
 */
const TAC_PERIODS = [1024, 16, 64, 256]; // t-cycles per TIMA tick for clock-select 0..3
export class Timer {
    mmu;
    divCounter = 0;
    timaCounter = 0;
    constructor(mmu) {
        this.mmu = mmu;
    }
    /** Snapshot timer prescaler state for save-states. */
    serializeState() {
        return { divCounter: this.divCounter, timaCounter: this.timaCounter };
    }
    loadState(s) {
        this.divCounter = s.divCounter;
        this.timaCounter = s.timaCounter;
    }
    step(cycles) {
        // DIV
        this.divCounter += cycles;
        while (this.divCounter >= 256) {
            this.divCounter -= 256;
            const div = (this.mmu.rawIoRead(0xff04) + 1) & 0xff;
            this.mmu.rawIoWrite(0xff04, div);
        }
        // TIMA
        const tac = this.mmu.rawIoRead(0xff07);
        if (!(tac & 0x04))
            return; // timer disabled
        const period = TAC_PERIODS[tac & 0x03];
        this.timaCounter += cycles;
        while (this.timaCounter >= period) {
            this.timaCounter -= period;
            let tima = this.mmu.rawIoRead(0xff05) + 1;
            if (tima > 0xff) {
                tima = this.mmu.rawIoRead(0xff06); // reload from TMA
                const iff = this.mmu.rawIoRead(0xff0f);
                this.mmu.rawIoWrite(0xff0f, iff | 0x04); // request Timer interrupt
            }
            this.mmu.rawIoWrite(0xff05, tima & 0xff);
        }
    }
}
