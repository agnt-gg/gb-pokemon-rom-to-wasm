/**
 * Instrument every rb/wb/interp inside run(0x61) to see exactly what each instruction does.
 * Compare against oracle: XOR A(A=0); LDH(FF0F)=0; A=mem[FFFF]; B=A; RES0 A; mem[FFFF]=A; A=mem[FF44].
 * IE (0xFFFF) initial = 0 in this scenario -> A should stay 0 through LDH A,(FF).
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { decode } from "../src/recompiler/decoder.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
// match real run state: at first arrival, IE(FFFF)=0, FF44=0 (LCD just on)
mmu.rawIoWrite(0xff44, 0x00); mmu.write(0xffff, 0x00); mmu.rawIoWrite(0xff0f, 0xe1);

const cH=new CPU(mmu);
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any;
const w2c=()=>{cH.a=ex.get_A();cH.f=ex.get_F()&0xf0;cH.b=ex.get_B();cH.c=ex.get_C();cH.d=ex.get_D();cH.e=ex.get_E();cH.h=ex.get_H();cH.l=ex.get_L();cH.sp=ex.get_SP();cH.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cH.a);ex.set_F(cH.f&0xf0);ex.set_B(cH.b);ex.set_C(cH.c);ex.set_D(cH.d);ex.set_E(cH.e);ex.set_H(cH.h);ex.set_L(cH.l);ex.set_SP(cH.sp);ex.set_PC(cH.pc);};
const imports={env:{mem:memory,
  rb:(a:number)=>{const v=mmu.read(a&0xffff); console.log(`    rb(0x${(a&0xffff).toString(16)}) = 0x${v.toString(16)}  [A now 0x${ex.get_A().toString(16)}]`); return v;},
  wb:(a:number,v:number)=>{console.log(`    wb(0x${(a&0xffff).toString(16)}) <- 0x${(v&0xff).toString(16)}`); mmu.write(a&0xffff,v&0xff);},
  tick:()=>{},
  interp:(a:number)=>{w2c();const ins=decode(new Uint8Array([mmu.read(a),mmu.read((a+1)&0xffff),mmu.read((a+2)&0xffff)]),0,a);const aBefore=cH.a;const s=cH.pc;cH.exec(ins);if(!ins.isTerminator)cH.pc=s;console.log(`    interp 0x${a.toString(16)} ${ins.text}: A 0x${aBefore.toString(16)}->0x${cH.a.toString(16)} F->0x${cH.f.toString(16)}`);c2w();},
  dispatch:(pc:number)=>pc,set_ime:()=>{},sched_ei:()=>{},set_halt:()=>{}}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;
ex.set_A(0xff);ex.set_F(0x00);ex.set_B(0);ex.set_C(0x13);ex.set_PC(0x61);
console.log("run(0x61) with IE=0, FF44=0:");
const ret=ex.run(0x61);
console.log("RESULT: A=0x"+ex.get_A().toString(16)+" F=0x"+(ex.get_F()&0xff).toString(16)+" B=0x"+ex.get_B().toString(16)+" ret=0x"+(ret>>>0).toString(16));
console.log("EXPECT: A=0(LY) B=0(IE) ret=0x6b (LY=0 != 0x91 so loop)");
