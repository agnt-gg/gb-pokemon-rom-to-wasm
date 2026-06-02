/**
 * Direct test of the mis-lifted block at 0x6b:
 *   0x6b LDH A,($44) ; 0x6d CP $91 ; 0x6f JR NZ,-6
 * Set LY=0x30 (not 0x91). Expect: JR NZ taken -> next PC 0x6b (loop). Bug: goes to 0x71.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu = new CPU(mmu);
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any;
const w2c=()=>{cpu.a=ex.get_A();cpu.f=ex.get_F()&0xf0;cpu.b=ex.get_B();cpu.c=ex.get_C();cpu.d=ex.get_D();cpu.e=ex.get_E();cpu.h=ex.get_H();cpu.l=ex.get_L();cpu.sp=ex.get_SP();cpu.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cpu.a);ex.set_F(cpu.f&0xf0);ex.set_B(cpu.b);ex.set_C(cpu.c);ex.set_D(cpu.d);ex.set_E(cpu.e);ex.set_H(cpu.h);ex.set_L(cpu.l);ex.set_SP(cpu.sp);ex.set_PC(cpu.pc);};
const imports={env:{mem:memory,rb:(a:number)=>mmu.read(a&0xffff),wb:(a:number,v:number)=>mmu.write(a&0xffff,v&0xff),
  tick:(c:number)=>{cpu.cycles+=c;},
  interp:(a:number)=>{w2c();const ins=decode(new Uint8Array([mmu.read(a),mmu.read((a+1)&0xffff),mmu.read((a+2)&0xffff)]),0,a);console.log(`    [interp] 0x${a.toString(16)} ${ins.text}  A=0x${cpu.a.toString(16)} F=0x${cpu.f.toString(16)}`);const s=cpu.pc;cpu.exec(ins);if(!ins.isTerminator)cpu.pc=s;console.log(`    [interp]  -> F=0x${cpu.f.toString(16)}`);c2w();},
  dispatch:(pc:number)=>pc,set_ime:()=>{},sched_ei:()=>{},set_halt:()=>{},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;

// LY = 0x30
mmu.rawIoWrite(0xff44, 0x30);
ex.set_PC(0x6b);
console.log("Before: LY=0x" + mmu.rawIoRead(0xff44).toString(16) + ", expect JR NZ TAKEN (A=0x30 != 0x91) -> loop to 0x6b");
const ret = ex.run(0x6b);
console.log("ex.run(0x6b) returned 0x" + (ret>>>0).toString(16) + "  (0x6b=correct loop, 0x71=BUG fallthrough)");
console.log("final A=0x"+(ex.get_A()).toString(16)+" F=0x"+(ex.get_F()&0xff).toString(16)+" PC=0x"+(ex.get_PC()&0xffff).toString(16));

// also test the equal case
mmu.rawIoWrite(0xff44, 0x91);
ex.set_PC(0x6b);
console.log("\nNow LY=0x91, expect JR NZ NOT taken -> fall to 0x71");
const ret2 = ex.run(0x6b);
console.log("ex.run(0x6b) returned 0x" + (ret2>>>0).toString(16) + "  (0x71=correct exit)");
