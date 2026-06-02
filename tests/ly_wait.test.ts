/**
 * The hybrid falls through the "wait LY==0x91" loop at 0x6b instantly. Why?
 * Hypothesis: the recompiled block at 0x6b reads LY ONCE, and since blocks run atomically
 * the loop's JR-back re-enters the SAME wasm block which re-reads LY — but if the host loop
 * lets the block tail-call itself in wasm without returning, the PPU tick never advances LY.
 *
 * Check: when hybrid is at 0x6b, what does ex.run(0x6b) return, and what is LY before/after?
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

// run until first arrival at 0x6b
let n=0;
while(n++<200000){
  const pc=ex.get_PC()&0xffff;
  if(pc>=0x4000&&pc<=0x7fff){ w2c(); let i=0; while((cpu.pc&0xffff)>=0x4000&&(cpu.pc&0xffff)<=0x7fff&&i++<8192&&!cpu.halted){const b=cpu.cycles;cpu.step();ppu.step(cpu.cycles-b);} c2w(); continue; }
  if(pc===0x6b){
    console.log("Arrived at 0x6b. LY=0x"+mmu.rawIoRead(0xff44).toString(16)+" LCDC=0x"+mmu.rawIoRead(0xff40).toString(16));
    // run the block ~5 times and watch LY + return
    for(let k=0;k<8;k++){
      const lyBefore=mmu.rawIoRead(0xff44);
      const ret=ex.run(0x6b);
      console.log(`  run #${k}: LY ${lyBefore.toString(16)}->${mmu.rawIoRead(0xff44).toString(16)}  A=0x${ex.get_A().toString(16)} F=0x${(ex.get_F()&0xff).toString(16)} ret=0x${(ret>>>0).toString(16)}`);
      if((ret>>>0)!==0x6b){console.log("  -> exited loop (ret != 0x6b)");break;}
    }
    break;
  }
  const ret=ex.run(pc);
  if(ret===UNKNOWN_BLOCK){w2c();cpu.step();c2w();}
  else if(ret===SENTINEL_HALT)cpu.halted=true;
}
