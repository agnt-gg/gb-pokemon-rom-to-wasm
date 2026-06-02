/**
 * The hybrid reaches 0x00B5 with SP=0xdff3 holding 0x0000 at the RET.
 * Does the ORACLE (pure interpreter) ever execute 0x00B5->0x00BD, and if so, with what SP
 * and what's on the stack? This tells us if the bug is "wrong path INTO b5" vs "b5 itself".
 *
 * We need the PPU on for the oracle too (so it progresses identically).
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu = new CPU(mmu); const ppu = new PPU(mmu);
// tick the ppu from the interpreter too
const origStep = cpu.step.bind(cpu);
cpu.a=1;cpu.f=0xb0;cpu.b=0;cpu.c=0x13;cpu.d=0;cpu.e=0xd8;cpu.h=1;cpu.l=0x4d;cpu.sp=0xfffe;cpu.pc=0x100;
mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);

let n=0; let reachedB5=false; let prevPc=0;
const trail: string[]=[];
while(n++<3_000_000){
  const pc=cpu.pc&0xffff;
  if(pc===0x00b5 && !reachedB5){
    reachedB5=true;
    console.log(`Oracle reached 0x00B5 at step ${n}. SP=0x${cpu.sp.toString(16)} (came from 0x${prevPc.toString(16)})`);
    const sp=cpu.sp; console.log(`  stack[SP]=0x${((mmu.read((sp+1)&0xffff)<<8)|mmu.read(sp)).toString(16)}`);
    console.log("  trail into b5:"); for(const t of trail) console.log("    "+t);
  }
  if(pc===0x00bd && reachedB5){
    console.log(`Oracle at 0x00BD (RET) step ${n}: SP=0x${cpu.sp.toString(16)} will pop 0x${((mmu.read((cpu.sp+1)&0xffff)<<8)|mmu.read(cpu.sp)).toString(16)}`);
    break;
  }
  if(pc===0x0038){console.log("oracle hit crash?! step",n);break;}
  trail.push(`0x${pc.toString(16)}`); if(trail.length>12)trail.shift();
  prevPc=pc;
  const before=cpu.cycles; origStep(); ppu.step(cpu.cycles-before);
}
if(!reachedB5) console.log("oracle never reached 0x00B5 in 3M steps");
