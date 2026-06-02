import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import * as alu from "../src/runtime/alu.ts";
import { decode } from "../src/recompiler/decoder.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu=new CPU(mmu);

// DEC B from 0x0a -> 0x09, Z should be 0 (not zero)
cpu.b=0x0a; cpu.f=0x00; cpu.pc=0xc000; mmu.write(0xc000,0x05); // DEC B
cpu.step();
console.log("DEC B (0x0a): B=0x"+cpu.b.toString(16)+" F=0x"+cpu.f.toString(16)+" Z="+((cpu.f&0x80)?1:0)+" (expect B=9, Z=0)");

// INC C from 0x80 -> 0x81
cpu.c=0x80; cpu.f=0x00; cpu.pc=0xc010; mmu.write(0xc010,0x0c); // INC C
cpu.step();
console.log("INC C (0x80): C=0x"+cpu.c.toString(16)+" F=0x"+cpu.f.toString(16)+" (expect C=81)");

// JR NZ when Z=0 should branch
cpu.f=0x00; cpu.pc=0xc020; mmu.write(0xc020,0x20); mmu.write(0xc021,0xfb); // JR NZ,-5
cpu.step();
console.log("JR NZ,-5 with Z=0: PC=0x"+(cpu.pc&0xffff).toString(16)+" (expect 0x"+(0xc022-5).toString(16)+" = branch taken)");

// JR NZ when Z=1 should NOT branch
cpu.f=0x80; cpu.pc=0xc030; mmu.write(0xc030,0x20); mmu.write(0xc031,0xfb);
cpu.step();
console.log("JR NZ,-5 with Z=1: PC=0x"+(cpu.pc&0xffff).toString(16)+" (expect 0xc032 = NOT taken)");

// alu.dec8 direct
console.log("\nalu.dec8(0x0a):", JSON.stringify(alu.dec8(0x0a, 0x00)));
console.log("alu.inc8(0x80):", JSON.stringify(alu.inc8(0x80, 0x00)));

// Now the FULL loop again but trace each step
console.log("\n--- full loop trace ---");
const prog=[0x21,0x00,0xd0, 0x0e,0x80, 0x06,0x05, 0x2a, 0xe2, 0x0c, 0x05, 0x20,0xfb];
let addr=0xc100; for(const b of prog) mmu.write(addr++, b);
for(let i=0;i<5;i++) mmu.write(0xd000+i, 0xf0+i);
cpu.pc=0xc100; cpu.sp=0xfffe; cpu.f=0;
for(let i=0;i<60;i++){
  const pc=cpu.pc&0xffff; if(pc>=0xc10d||pc<0xc100)break;
  const ins=decode(new Uint8Array([mmu.read(pc),mmu.read(pc+1),mmu.read(pc+2)]),0,pc);
  cpu.step();
  if(pc>=0xc107) console.log(`  0x${pc.toString(16)} ${ins.text.padEnd(12)} A=${cpu.a.toString(16)} B=${cpu.b.toString(16)} C=${cpu.c.toString(16)} HL=${(cpu.h<<8|cpu.l).toString(16)} F=${cpu.f.toString(16)} ->PC=0x${(cpu.pc&0xffff).toString(16)}`);
}
let d="  HRAM: "; for(let i=0;i<5;i++) d+=mmu.read(0xff80+i).toString(16).padStart(2,"0")+" "; console.log(d+"(expect f0 f1 f2 f3 f4)");
