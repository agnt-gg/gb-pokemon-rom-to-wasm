import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { decode } from "../src/recompiler/decoder.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));

// 1) direct HRAM write/read
mmu.write(0xff80, 0xAB);
console.log("HRAM write/read 0xFF80:", mmu.read(0xff80).toString(16), "(expect ab)");
mmu.write(0xfffe, 0xCD);
console.log("HRAM write/read 0xFFFE:", mmu.read(0xfffe).toString(16), "(expect cd)");

// 2) LD ($FF00+C),A  (opcode 0xE2) writing to HRAM via interpreter
const cpu=new CPU(mmu);
cpu.a=0x3e; cpu.c=0x80; cpu.pc=0xc000;
mmu.write(0xc000, 0xe2); // LD (FF00+C),A
const ins=decode(new Uint8Array([0xe2,0,0]),0,0xc000);
console.log("\n0xE2 decodes:", ins.text, JSON.stringify(ins.operands));
cpu.step();
console.log("After LD (FF00+C),A with C=0x80,A=0x3e: mem[FF80]=0x"+mmu.read(0xff80).toString(16)+" (expect 3e)");

// 3) LDH (n),A to 0xFF80? n=0x80 -> LDH ($80),A opcode E0 80
cpu.a=0x99; cpu.pc=0xc010; mmu.write(0xc010,0xe0); mmu.write(0xc011,0x80);
cpu.step();
console.log("After LDH ($80),A with A=0x99: mem[FF80]=0x"+mmu.read(0xff80).toString(16)+" (expect 99)");

// 4) the actual copy loop: ld hl,src; ld c,$80; ld b,$0a; loop: ld a,(hl+); ld (FF00+c),a; inc c; dec b; jr nz
// emulate in WRAM
const prog=[0x21,0x00,0xd0, 0x0e,0x80, 0x06,0x0a, 0x2a, 0xe2, 0x0c, 0x05, 0x20,0xfb];
let addr=0xc100; for(const b of prog) mmu.write(addr++, b);
// source data at 0xd000
for(let i=0;i<10;i++) mmu.write(0xd000+i, 0xf0+i);
cpu.pc=0xc100; cpu.sp=0xfffe;
for(let i=0;i<200 && (cpu.pc&0xffff)<0xc110 && (cpu.pc&0xffff)>=0xc100;i++) cpu.step();
let dump="  HRAM after copy loop: "; for(let i=0;i<10;i++) dump+=mmu.read(0xff80+i).toString(16).padStart(2,"0")+" ";
console.log("\n"+dump+"  (expect f0 f1 f2 ... f9)");
