/**
 * Lockstep oracle (interp) vs hybrid, BOTH with PPU, at instruction granularity.
 * Report the first PC where the two take different next-PCs (the mis-lifted branch).
 *
 * To keep PPU state identical, both drive their own PPU with identical cycle counts.
 * We step the hybrid one BLOCK at a time, and the oracle instruction-by-instruction to the
 * same PC, comparing the decision at each block terminator.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const romPath = "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";

// hybrid
const mH = new MMU(new Uint8Array(readFileSync(romPath))); const cH=new CPU(mH); const pH=new PPU(mH);
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any;
const w2c=()=>{cH.a=ex.get_A();cH.f=ex.get_F()&0xf0;cH.b=ex.get_B();cH.c=ex.get_C();cH.d=ex.get_D();cH.e=ex.get_E();cH.h=ex.get_H();cH.l=ex.get_L();cH.sp=ex.get_SP();cH.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cH.a);ex.set_F(cH.f&0xf0);ex.set_B(cH.b);ex.set_C(cH.c);ex.set_D(cH.d);ex.set_E(cH.e);ex.set_H(cH.h);ex.set_L(cH.l);ex.set_SP(cH.sp);ex.set_PC(cH.pc);};
const imports={env:{mem:memory,rb:(a:number)=>mH.read(a&0xffff),wb:(a:number,v:number)=>mH.write(a&0xffff,v&0xff),
  tick:(c:number)=>{cH.cycles+=c;pH.step(c);},
  interp:(a:number)=>{w2c();const ins=decode(new Uint8Array([mH.read(a),mH.read((a+1)&0xffff),mH.read((a+2)&0xffff)]),0,a);const s=cH.pc;cH.exec(ins);if(!ins.isTerminator)cH.pc=s;c2w();},
  dispatch:(pc:number)=>pc,set_ime:(v:number)=>{(cH as any).ime=!!v;},sched_ei:()=>{(cH as any).imeScheduled=true;},set_halt:(v:number)=>{cH.halted=!!v;},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;
ex.set_A(1);ex.set_F(0xb0);ex.set_B(0);ex.set_C(0x13);ex.set_D(0);ex.set_E(0xd8);ex.set_H(1);ex.set_L(0x4d);ex.set_SP(0xfffe);ex.set_PC(0x100);
mH.rawIoWrite(0xff40,0x91);mH.rawIoWrite(0xff47,0xfc);

// oracle
const mO=new MMU(new Uint8Array(readFileSync(romPath))); const cO=new CPU(mO); const pO=new PPU(mO);
cO.a=1;cO.f=0xb0;cO.b=0;cO.c=0x13;cO.d=0;cO.e=0xd8;cO.h=1;cO.l=0x4d;cO.sp=0xfffe;cO.pc=0x100;
mO.rawIoWrite(0xff40,0x91);mO.rawIoWrite(0xff47,0xfc);
const stepO=()=>{const b=cO.cycles;cO.step();pO.step(cO.cycles-b);};

// Drive both instruction-by-instruction. Hybrid: step one block, then re-derive the instrs it
// executed by stepping the oracle the same number of *instructions*? Simpler: step BOTH as pure
// interpreters EXCEPT the hybrid uses ex.run. Compare PC after each unit. To align, we step the
// oracle until its PC matches the hybrid's pre-run PC, then run one hybrid block and one oracle
// stretch to the same resulting PC; if they can't match, that's divergence.
let guard=0;
let lastPC=0x100;
while(guard++<300000){
  const pcH=ex.get_PC()&0xffff;
  // step oracle to reach pcH
  let g2=0; while((cO.pc&0xffff)!==pcH && g2++<2000) stepO();
  if((cO.pc&0xffff)!==pcH){
    console.log(`DIVERGENCE: hybrid at 0x${pcH.toString(16)} but oracle stuck at 0x${(cO.pc&0xffff).toString(16)} (last common ~0x${lastPC.toString(16)})`);
    // Disassemble lastPC block to find the mis-lifted branch
    let a=lastPC; console.log("last common block disasm:");
    for(let i=0;i<16;i++){const ins=decode(new Uint8Array([mH.read(a),mH.read(a+1),mH.read(a+2)]),0,a);console.log(`  0x${a.toString(16)}: ${ins.text}`);if(ins.isTerminator)break;a+=ins.length;}
    console.log(`oracle regs: A=${cO.a.toString(16)} F=${cO.f.toString(16)} BC=${(cO.b<<8|cO.c).toString(16)} HL=${(cO.h<<8|cO.l).toString(16)}`);
    break;
  }
  lastPC=pcH;
  if(pcH===0x0038){console.log("both reached crash");break;}
  // bank-window guard (match real host)
  if(pcH>=0x4000&&pcH<=0x7fff){ w2c(); let i=0; while((cH.pc&0xffff)>=0x4000&&(cH.pc&0xffff)<=0x7fff&&i++<8192&&!cH.halted){const b=cH.cycles;cH.step();pH.step(cH.cycles-b);} c2w(); continue; }
  const ret=ex.run(pcH);
  if(ret===UNKNOWN_BLOCK){w2c();cH.step();c2w();}
  else if(ret===SENTINEL_HALT)cH.halted=true;
}
console.log("guard:",guard);
