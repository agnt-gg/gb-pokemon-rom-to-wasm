/**
 * Test the recompiled block at 0x5876 (ends CALL $00B5). After running it:
 *   - PC should be 0x00B5
 *   - SP should have decreased by 2
 *   - the 2 bytes at SP should be the return addr 0x5882 (little-endian: 82 58)
 * If they're 00 00, the recompiled CALL/push16 is broken.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu=new CPU(mmu);
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any;
const w2c=()=>{cpu.a=ex.get_A();cpu.f=ex.get_F()&0xf0;cpu.b=ex.get_B();cpu.c=ex.get_C();cpu.d=ex.get_D();cpu.e=ex.get_E();cpu.h=ex.get_H();cpu.l=ex.get_L();cpu.sp=ex.get_SP();cpu.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cpu.a);ex.set_F(cpu.f&0xf0);ex.set_B(cpu.b);ex.set_C(cpu.c);ex.set_D(cpu.d);ex.set_E(cpu.e);ex.set_H(cpu.h);ex.set_L(cpu.l);ex.set_SP(cpu.sp);ex.set_PC(cpu.pc);};
const imports={env:{mem:memory,rb:(a:number)=>mmu.read(a&0xffff),wb:(a:number,v:number)=>mmu.write(a&0xffff,v&0xff),
  tick:(c:number)=>{cpu.cycles+=c;},
  interp:(a:number)=>{w2c();const ins=decode(new Uint8Array([mmu.read(a),mmu.read((a+1)&0xffff),mmu.read((a+2)&0xffff)]),0,a);const s=cpu.pc;cpu.exec(ins);if(!ins.isTerminator)cpu.pc=s;c2w();},
  dispatch:(pc:number)=>pc,set_ime:()=>{},sched_ei:()=>{},set_halt:()=>{},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;
ex.set_SP(0xdff5); ex.set_PC(0x5876);
console.log("Before: SP=0x"+(ex.get_SP()&0xffff).toString(16)+" PC=0x5876, CALL $00B5 should push return 0x5882");
const ret = ex.run(0x5876);
const sp = ex.get_SP()&0xffff;
const lo=mmu.read(sp), hi=mmu.read((sp+1)&0xffff);
console.log("After ex.run(0x5876): returned 0x"+(ret>>>0).toString(16)+" PC=0x"+(ex.get_PC()&0xffff).toString(16));
console.log("  SP=0x"+sp.toString(16)+"  stack bytes: ["+lo.toString(16)+","+hi.toString(16)+"] = return addr 0x"+((hi<<8)|lo).toString(16));
console.log("  EXPECT: PC=0xb5, SP=0xdff3, return=0x5882");
console.log(((ret>>>0)===0xb5 && sp===0xdff3 && ((hi<<8)|lo)===0x5882) ? "\n  ✓ CALL push CORRECT" : "\n  ✗ CALL push BROKEN");
