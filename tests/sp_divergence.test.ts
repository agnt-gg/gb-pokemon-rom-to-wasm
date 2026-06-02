/**
 * Run interpreter (oracle) and hybrid in lockstep at BLOCK granularity. At each block entry
 * PC, compare SP. First divergence = the culprit block. Then disassemble it.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const romPath = "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";

// --- oracle: pure interpreter, stepped one instruction at a time ---
const mmuO = new MMU(new Uint8Array(readFileSync(romPath)));
const cpuO = new CPU(mmuO);
cpuO.a=1;cpuO.f=0xb0;cpuO.b=0;cpuO.c=0x13;cpuO.d=0;cpuO.e=0xd8;cpuO.h=1;cpuO.l=0x4d;cpuO.sp=0xfffe;cpuO.pc=0x100;
mmuO.rawIoWrite(0xff40,0x91);mmuO.rawIoWrite(0xff47,0xfc);

// --- hybrid ---
const mmuH = new MMU(new Uint8Array(readFileSync(romPath)));
const cpuH = new CPU(mmuH);
const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
let ex: any;
const w2c=()=>{cpuH.a=ex.get_A();cpuH.f=ex.get_F()&0xf0;cpuH.b=ex.get_B();cpuH.c=ex.get_C();cpuH.d=ex.get_D();cpuH.e=ex.get_E();cpuH.h=ex.get_H();cpuH.l=ex.get_L();cpuH.sp=ex.get_SP();cpuH.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cpuH.a);ex.set_F(cpuH.f&0xf0);ex.set_B(cpuH.b);ex.set_C(cpuH.c);ex.set_D(cpuH.d);ex.set_E(cpuH.e);ex.set_H(cpuH.h);ex.set_L(cpuH.l);ex.set_SP(cpuH.sp);ex.set_PC(cpuH.pc);};
const imports={env:{mem:memory,rb:(a:number)=>mmuH.read(a&0xffff),wb:(a:number,v:number)=>mmuH.write(a&0xffff,v&0xff),
  tick:(c:number)=>{cpuH.cycles+=c;},
  interp:(addr:number)=>{w2c();const ins=decode(new Uint8Array([mmuH.read(addr),mmuH.read((addr+1)&0xffff),mmuH.read((addr+2)&0xffff)]),0,addr);const s=cpuH.pc;cpuH.exec(ins);if(!ins.isTerminator)cpuH.pc=s;c2w();},
  dispatch:(pc:number)=>pc,set_ime:(v:number)=>{(cpuH as any).ime=!!v;},sched_ei:()=>{(cpuH as any).imeScheduled=true;},set_halt:(v:number)=>{cpuH.halted=!!v;},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;
ex.set_A(1);ex.set_F(0xb0);ex.set_B(0);ex.set_C(0x13);ex.set_D(0);ex.set_E(0xd8);ex.set_H(1);ex.set_L(0x4d);ex.set_SP(0xfffe);ex.set_PC(0x100);
mmuH.rawIoWrite(0xff40,0x91);mmuH.rawIoWrite(0xff47,0xfc);

// step oracle until its PC == a block boundary the hybrid will also be at.
// Simpler: step oracle one instr at a time; step hybrid one BLOCK at a time but compare only
// when both PCs match. Since both are deterministic & identical semantics, PCs should track.
let dispatch = 0;
let lastBlockPC = ex.get_PC()&0xffff;
while (dispatch++ < 200000) {
  const pcH = ex.get_PC()&0xffff;
  // advance oracle until its PC equals pcH (catch up), max 5000 instrs
  let guard=0;
  while ((cpuO.pc & 0xffff) !== pcH && guard++ < 5000) cpuO.step();
  if ((cpuO.pc&0xffff)!==pcH) { console.log(`oracle couldn't reach hybrid PC 0x${pcH.toString(16)} at dispatch ${dispatch} (oracle stuck at 0x${cpuO.pc.toString(16)})`); break; }
  // compare SP at this synchronized point
  if ((cpuO.sp&0xffff) !== (ex.get_SP()&0xffff)) {
    console.log(`SP DIVERGES at block 0x${pcH.toString(16)} (dispatch ${dispatch}): oracle SP=0x${(cpuO.sp&0xffff).toString(16)} hybrid SP=0x${(ex.get_SP()&0xffff).toString(16)}`);
    console.log(`  prev block was 0x${lastBlockPC.toString(16)}`);
    // disasm prev block
    let a=lastBlockPC; console.log("  prev block disasm:");
    for(let i=0;i<12;i++){const ins=decode(new Uint8Array([mmuH.read(a),mmuH.read(a+1),mmuH.read(a+2)]),0,a);console.log(`    0x${a.toString(16)}: ${ins.text}`);if(ins.isTerminator)break;a+=ins.length;}
    break;
  }
  lastBlockPC = pcH;
  if (pcH===0x0038){console.log("both at crash (no divergence found earlier)");break;}
  const ret=ex.run(pcH);
  if(ret===UNKNOWN_BLOCK){w2c();cpuH.step();c2w();}
  else if(ret===SENTINEL_HALT)cpuH.halted=true;
}
console.log("done, dispatches:", dispatch);
