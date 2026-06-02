/**
 * Run block 0x61 in BOTH hybrid (wasm) and oracle from identical state, instruction by
 * instruction in the oracle, and compare. Pin the exact instruction that diverges.
 * Block: XOR A; LDH (FF0F),A; LDH A,(FFFF); LD B,A; RES 0,A; LDH (FFFF),A; LDH A,(FF44); CP 91; JR NZ
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { decode } from "../src/recompiler/decoder.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const romPath = "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";

// set up identical initial state at 0x61
const init = { a:0x11, f:0x80, b:0, c:0x13, d:0, e:0xd8, h:1, l:0x4d, sp:0xfffc };

// oracle: step each instr, print state
const mO=new MMU(new Uint8Array(readFileSync(romPath))); const cO=new CPU(mO);
Object.assign(cO, init); cO.pc=0x61;
mO.rawIoWrite(0xff44, 0x30); mO.rawIoWrite(0xffff, 0x01); mO.rawIoWrite(0xff0f, 0x05);
console.log("ORACLE step-by-step from 0x61:");
for(let i=0;i<7;i++){
  const pc=cO.pc; const ins=decode(new Uint8Array([mO.read(pc),mO.read(pc+1),mO.read(pc+2)]),0,pc);
  cO.step();
  console.log(`  0x${pc.toString(16)} ${ins.text.padEnd(16)} -> A=0x${cO.a.toString(16)} F=0x${cO.f.toString(16)} B=0x${cO.b.toString(16)} FFFF=0x${mO.read(0xffff).toString(16)} FF0F=0x${mO.rawIoRead(0xff0f).toString(16)} PC=0x${cO.pc.toString(16)}`);
  if(ins.isTerminator) break;
}

// hybrid: run the block via wasm
const mH=new MMU(new Uint8Array(readFileSync(romPath))); const cH=new CPU(mH);
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any;
const w2c=()=>{cH.a=ex.get_A();cH.f=ex.get_F()&0xf0;cH.b=ex.get_B();cH.c=ex.get_C();cH.d=ex.get_D();cH.e=ex.get_E();cH.h=ex.get_H();cH.l=ex.get_L();cH.sp=ex.get_SP();cH.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cH.a);ex.set_F(cH.f&0xf0);ex.set_B(cH.b);ex.set_C(cH.c);ex.set_D(cH.d);ex.set_E(cH.e);ex.set_H(cH.h);ex.set_L(cH.l);ex.set_SP(cH.sp);ex.set_PC(cH.pc);};
const imports={env:{mem:memory,rb:(a:number)=>mH.read(a&0xffff),wb:(a:number,v:number)=>mH.write(a&0xffff,v&0xff),
  tick:()=>{},
  interp:(a:number)=>{w2c();const ins=decode(new Uint8Array([mH.read(a),mH.read((a+1)&0xffff),mH.read((a+2)&0xffff)]),0,a);const s=cH.pc;cH.exec(ins);if(!ins.isTerminator)cH.pc=s;c2w();console.log(`    [interp ran 0x${a.toString(16)} ${ins.text}]`);},
  dispatch:(pc:number)=>pc,set_ime:()=>{},sched_ei:()=>{},set_halt:()=>{},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;
mH.rawIoWrite(0xff44, 0x30); mH.rawIoWrite(0xffff, 0x01); mH.rawIoWrite(0xff0f, 0x05);
ex.set_A(init.a);ex.set_F(init.f);ex.set_B(init.b);ex.set_C(init.c);ex.set_D(init.d);ex.set_E(init.e);ex.set_H(init.h);ex.set_L(init.l);ex.set_SP(init.sp);ex.set_PC(0x61);
console.log("\nHYBRID run(0x61):");
const ret=ex.run(0x61);
console.log(`  -> A=0x${ex.get_A().toString(16)} F=0x${(ex.get_F()&0xff).toString(16)} B=0x${ex.get_B().toString(16)} FFFF=0x${mH.read(0xffff).toString(16)} FF0F=0x${mH.rawIoRead(0xff0f).toString(16)} ret=0x${(ret>>>0).toString(16)}`);
console.log("\nEXPECT (oracle final): A=0, F=0x80 region... check above");
