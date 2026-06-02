/**
 * Trace the hybrid's block-entry path leading into 0x00B5, capturing how it ENTERS b5
 * (was the entry preceded by a CALL that pushed a return addr, or a JP/JR/RET that didn't?).
 * Print the 40 block-heads before the FIRST time we enter 0x00B5.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu=new CPU(mmu); const ppu=new PPU(mmu);
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any;
const w2c=()=>{cpu.a=ex.get_A();cpu.f=ex.get_F()&0xf0;cpu.b=ex.get_B();cpu.c=ex.get_C();cpu.d=ex.get_D();cpu.e=ex.get_E();cpu.h=ex.get_H();cpu.l=ex.get_L();cpu.sp=ex.get_SP();cpu.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cpu.a);ex.set_F(cpu.f&0xf0);ex.set_B(cpu.b);ex.set_C(cpu.c);ex.set_D(cpu.d);ex.set_E(cpu.e);ex.set_H(cpu.h);ex.set_L(cpu.l);ex.set_SP(cpu.sp);ex.set_PC(cpu.pc);};
const imports={env:{mem:memory,rb:(a:number)=>mmu.read(a&0xffff),wb:(a:number,v:number)=>mmu.write(a&0xffff,v&0xff),
  tick:(c:number)=>{cpu.cycles+=c;ppu.step(c);},
  interp:(a:number)=>{w2c();const ins=decode(new Uint8Array([mmu.read(a),mmu.read((a+1)&0xffff),mmu.read((a+2)&0xffff)]),0,a);const s=cpu.pc;cpu.exec(ins);if(!ins.isTerminator)cpu.pc=s;c2w();},
  dispatch:(pc:number)=>pc,set_ime:(v:number)=>{(cpu as any).ime=!!v;},sched_ei:()=>{(cpu as any).imeScheduled=true;},set_halt:(v:number)=>{cpu.halted=!!v;},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;
ex.set_A(1);ex.set_F(0xb0);ex.set_B(0);ex.set_C(0x13);ex.set_D(0);ex.set_E(0xd8);ex.set_H(1);ex.set_L(0x4d);ex.set_SP(0xfffe);ex.set_PC(0x100);
mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);

const trail:string[]=[];
let n=0; let prevTerm="";
while(n++<200000){
  const pc=ex.get_PC()&0xffff; const sp=ex.get_SP()&0xffff;
  // disasm terminator of this block
  let a=pc, term="?", tgts="";
  for(let i=0;i<40;i++){const ins=decode(new Uint8Array([mmu.read(a),mmu.read(a+1),mmu.read(a+2)]),0,a);if(ins.isTerminator){term=ins.text;tgts=JSON.stringify((ins as any).staticTargets||[]);break;}a+=ins.length;}
  trail.push(`0x${pc.toString(16).padStart(4,"0")} SP=0x${sp.toString(16)} term=[${term}] tgts=${tgts}`);
  if(trail.length>40)trail.shift();
  if(pc===0x00b5){console.log("FIRST entry to 0x00b5. Path (40 blocks):");for(const t of trail)console.log("  "+t);break;}
  const ret=ex.run(pc);
  if(ret===UNKNOWN_BLOCK){w2c();cpu.step();c2w();}
  else if(ret===SENTINEL_HALT)cpu.halted=true;
}
