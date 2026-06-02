/**
 * Real hybrid (working interp + PPU). Run to 0x6b, then run the loop block repeatedly WITH
 * the host tick driving the PPU, and log A/F/ret each time LY changes, until A hits 0x91.
 * This tells us if the recompiled CP+JR exits correctly when A==0x91 in the REAL setup.
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

let n=0;
while(n++<200000){
  const pc=ex.get_PC()&0xffff;
  if(pc>=0x4000&&pc<=0x7fff){w2c();let i=0;while((cpu.pc&0xffff)>=0x4000&&(cpu.pc&0xffff)<=0x7fff&&i++<8192&&!cpu.halted){const b=cpu.cycles;cpu.step();ppu.step(cpu.cycles-b);}c2w();continue;}
  if(pc===0x6b){
    console.log("At 0x6b. Looping with PPU driven; watching for A->0x91 and exit:");
    let lastLY=-1, iters=0;
    while(iters++<2_000_000){
      const ret=ex.run(0x6b);
      const ly=mmu.rawIoRead(0xff44), a=ex.get_A(), f=ex.get_F()&0xff;
      if(ly!==lastLY){ console.log(`  LY=0x${ly.toString(16).padStart(2,"0")} A=0x${a.toString(16)} F=0x${f.toString(16)} ret=0x${(ret>>>0).toString(16)}`); lastLY=ly; }
      if((ret>>>0)!==0x6b){ console.log(`  EXITED to 0x${(ret>>>0).toString(16)} when A=0x${a.toString(16)} (LY=0x${ly.toString(16)})`); break; }
      if(iters>2_000_000-2) console.log("  ...never exited in 2M iters");
    }
    break;
  }
  const ret=ex.run(pc);
  if(ret===UNKNOWN_BLOCK){w2c();cpu.step();c2w();}
  else if(ret===SENTINEL_HALT)cpu.halted=true;
}
