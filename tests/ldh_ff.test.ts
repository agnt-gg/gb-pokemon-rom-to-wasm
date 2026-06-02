/**
 * Pin LDH A,($FF) and the F-flag divergence.
 * Set FFFF (IE) = 0x09. Run ONLY 0x64 (LDH A,($FF)) in both. A should become 0x09.
 * Also: oracle preserves F across LDH/LD/RES(only changes via RES? no - RES doesn't touch F);
 *   CP changes F. The hybrid's F=0x70 vs oracle F=0x80 is the bug to nail.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { decode } from "../src/recompiler/decoder.ts";
import * as alu from "../src/runtime/alu.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));

// 1) MMU read of 0xFFFF
mmu.write(0xffff, 0x09);
console.log("mmu.read(0xFFFF) after write 0x09:", mmu.read(0xffff).toString(16), "(expect 9 = IE reg)");
console.log("decode of 0x64:", JSON.stringify(decode(new Uint8Array([mmu.read(0x64),mmu.read(0x65),mmu.read(0x66)]),0,0x64).operands));

// 2) The F divergence: oracle says after the FULL block to 0x6b, F=0x80. But CP $91 hasn't run
//    yet at 0x6b (that's 0x6d). At 0x6b the last flag-affecting op was XOR A (F=0x80). RES/LDH/LD
//    don't touch F. So at block-entry-compare point (0x6b) F should be 0x80.
//    Hybrid had F=0x70 -> something in the recompiled XOR..LDH chain corrupted F.
//    Check: does recompiled RES 0,A (interp) or LDH wrongly set F?
const cp = alu.cp8(0x30, 0x91);
console.log("\nalu.cp8(0x30,0x91) -> f=0x"+cp.f.toString(16)+" (0x30-0x91 borrows: expect N=1,H?,C=1,Z=0)");

// XOR A then nothing should keep F=0x80. Let's confirm setflags_z semantics in wasm by running
// just 0x61 XOR A in isolation.
const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any;
const cH=new CPU(mmu);
const w2c=()=>{cH.a=ex.get_A();cH.f=ex.get_F()&0xf0;cH.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cH.a);ex.set_F(cH.f&0xf0);ex.set_PC(cH.pc);};
const imports={env:{mem:memory,rb:(a:number)=>mmu.read(a&0xffff),wb:(a:number,v:number)=>mmu.write(a&0xffff,v&0xff),tick:()=>{},
  interp:(a:number)=>{w2c();const ins=decode(new Uint8Array([mmu.read(a),mmu.read((a+1)&0xffff),mmu.read((a+2)&0xffff)]),0,a);const s=cH.pc;cH.exec(ins);if(!ins.isTerminator)cH.pc=s;c2w();},
  dispatch:(pc:number)=>pc,set_ime:()=>{},sched_ei:()=>{},set_halt:()=>{}}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;
// preset FF44 so block exits to 0x6b loop, and FFFF
mmu.rawIoWrite(0xff44,0x30); mmu.write(0xffff,0x09); mmu.rawIoWrite(0xff0f,0x1f);
ex.set_A(0x55);ex.set_F(0x00);ex.set_B(0);ex.set_PC(0x61);
const ret=ex.run(0x61);
console.log("\nHybrid run(0x61) full block: A=0x"+ex.get_A().toString(16)+" F=0x"+(ex.get_F()&0xff).toString(16)+" B=0x"+ex.get_B().toString(16)+" FFFF=0x"+mmu.read(0xffff).toString(16)+" ret=0x"+(ret>>>0).toString(16));
console.log("EXPECT: at 0x6b, A=0x30(LY), F=0x80(from XOR A, unchanged by LDH/LD/RES), B=0x09(IE), FFFF=0x08(IE w/ bit0 cleared), ret=0x6b");
