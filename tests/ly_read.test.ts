/**
 * Direct head-to-head at 0x6b with LY=0x30 mapped. Does the recompiled block READ LY=0x30,
 * or something else? Compares the wasm block's view of LY vs interpreter.
 *
 * 0x6b: LDH A,($44)  -> A = mem[0xFF44] = LY
 * The recompiled LDH uses readExpr for mem_high_imm8. Let's see what A becomes.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { decode } from "../src/recompiler/decoder.ts";

const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));

// What does the recompiled LDH A,($44) actually compile to? decode + show op
const ins = decode(new Uint8Array([mmu.read(0x6b),mmu.read(0x6c),mmu.read(0x6d)]),0,0x6b);
console.log("0x6b decodes to:", ins.text, "ops:", JSON.stringify(ins.operands));

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any; let readLog:string[]=[];
const imports={env:{mem:memory,
  rb:(a:number)=>{const v=mmu.read(a&0xffff); if((a&0xffff)===0xff44) readLog.push("rb(0xFF44)="+v.toString(16)); return v;},
  wb:(a:number,v:number)=>mmu.write(a&0xffff,v&0xff),
  tick:()=>{},interp:()=>{},dispatch:(pc:number)=>pc,set_ime:()=>{},sched_ei:()=>{},set_halt:()=>{},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;

mmu.rawIoWrite(0xff44, 0x30); // LY = 0x30, so CP $91 -> NZ -> should loop (ret 0x6b)
ex.set_A(0x00); ex.set_F(0x00); ex.set_PC(0x6b);
const ret = ex.run(0x6b);
console.log("LY=0x30: ex.run(0x6b) -> A=0x"+ex.get_A().toString(16)+" F=0x"+(ex.get_F()&0xff).toString(16)+" ret=0x"+(ret>>>0).toString(16)+" (expect A=0x30, ret=0x6b loop)");
console.log("  reads:", readLog.join(", ")); readLog=[];

mmu.rawIoWrite(0xff44, 0x91);
ex.set_PC(0x6b);
const ret2 = ex.run(0x6b);
console.log("LY=0x91: ex.run(0x6b) -> A=0x"+ex.get_A().toString(16)+" F=0x"+(ex.get_F()&0xff).toString(16)+" ret=0x"+(ret2>>>0).toString(16)+" (expect A=0x91, ret=0x71 exit)");
console.log("  reads:", readLog.join(", "));
