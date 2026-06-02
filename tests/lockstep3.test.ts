/**
 * Proper lockstep: drive the HYBRID one block at a time. For each block, record the entry PC.
 * Drive the ORACLE forward instruction-by-instruction until ITS pc == the hybrid's NEXT block
 * entry (i.e. the hybrid's post-block PC). At THAT point both are at a real block boundary, so
 * compare full register state. This avoids the mid-block false positive.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const romPath = "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";

const mO=new MMU(new Uint8Array(readFileSync(romPath))); const cO=new CPU(mO); const pO=new PPU(mO); const tO=new Timer(mO);
cO.a=1;cO.f=0xb0;cO.b=0;cO.c=0x13;cO.d=0;cO.e=0xd8;cO.h=1;cO.l=0x4d;cO.sp=0xfffe;cO.pc=0x100;
mO.rawIoWrite(0xff40,0x91);mO.rawIoWrite(0xff47,0xfc);
// oracle MUST also service interrupts to track hybrid
const stepO=()=>{ const ic=cO.serviceInterrupts(); if(ic>0){pO.step(ic);tO.step(ic);} const b=cO.cycles;cO.step();const d=cO.cycles-b;pO.step(d);tO.step(d); };

const mH=new MMU(new Uint8Array(readFileSync(romPath))); const cH=new CPU(mH); const pH=new PPU(mH); const tH=new Timer(mH);
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any;
const w2c=()=>{cH.a=ex.get_A();cH.f=ex.get_F()&0xf0;cH.b=ex.get_B();cH.c=ex.get_C();cH.d=ex.get_D();cH.e=ex.get_E();cH.h=ex.get_H();cH.l=ex.get_L();cH.sp=ex.get_SP();cH.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cH.a);ex.set_F(cH.f&0xf0);ex.set_B(cH.b);ex.set_C(cH.c);ex.set_D(cH.d);ex.set_E(cH.e);ex.set_H(cH.h);ex.set_L(cH.l);ex.set_SP(cH.sp);ex.set_PC(cH.pc);};
const tkH=(c:number)=>{pH.step(c);tH.step(c);};
const imports={env:{mem:memory,rb:(a:number)=>mH.read(a&0xffff),wb:(a:number,v:number)=>mH.write(a&0xffff,v&0xff),
  tick:(c:number)=>{cH.cycles+=c;tkH(c);},
  interp:(a:number)=>{w2c();const ins=decode(new Uint8Array([mH.read(a),mH.read((a+1)&0xffff),mH.read((a+2)&0xffff)]),0,a);const s=cH.pc;cH.exec(ins);if(!ins.isTerminator)cH.pc=s;c2w();},
  dispatch:(pc:number)=>pc,set_ime:(v:number)=>{(cH as any).ime=!!v;},sched_ei:()=>{(cH as any).imeScheduled=true;},set_halt:(v:number)=>{cH.halted=!!v;},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;
ex.set_A(1);ex.set_F(0xb0);ex.set_B(0);ex.set_C(0x13);ex.set_D(0);ex.set_E(0xd8);ex.set_H(1);ex.set_L(0x4d);ex.set_SP(0xfffe);ex.set_PC(0x100);
mH.rawIoWrite(0xff40,0x91);mH.rawIoWrite(0xff47,0xfc);

const rH=()=>`A=${ex.get_A().toString(16)} F=${(ex.get_F()&0xf0).toString(16)} BC=${(ex.get_B()<<8|ex.get_C()).toString(16)} DE=${(ex.get_D()<<8|ex.get_E()).toString(16)} HL=${(ex.get_H()<<8|ex.get_L()).toString(16)} SP=${(ex.get_SP()&0xffff).toString(16)}`;
const rO=()=>`A=${cO.a.toString(16)} F=${cO.f.toString(16)} BC=${(cO.b<<8|cO.c).toString(16)} DE=${(cO.d<<8|cO.e).toString(16)} HL=${(cO.h<<8|cO.l).toString(16)} SP=${cO.sp.toString(16)}`;

let lastBlock=0x100, lastRO="", lastRH="";
let d=0;
while(d++<400000){
  // hybrid services interrupts at block boundary
  w2c(); const icH=cH.serviceInterrupts(); if(icH>0){c2w();tkH(icH);}
  const pcH=ex.get_PC()&0xffff;
  if(pcH===0x0038){console.log("hybrid reached crash @ dispatch "+d+", last good block 0x"+lastBlock.toString(16));console.log("  last oracle regs: "+lastRO+"\n  last hybrid regs: "+lastRH);break;}

  // run one hybrid block
  let nextH:number;
  if(pcH>=0x4000&&pcH<=0x7fff){w2c();let i=0;while((cH.pc&0xffff)>=0x4000&&(cH.pc&0xffff)<=0x7fff&&i++<8192&&!cH.halted){const b=cH.cycles;cH.step();tkH(cH.cycles-b);}c2w();nextH=ex.get_PC()&0xffff;}
  else { const ret=ex.run(pcH); if(ret===UNKNOWN_BLOCK){w2c();cH.step();c2w();} else if(ret===SENTINEL_HALT)cH.halted=true; nextH=ex.get_PC()&0xffff; }

  // drive oracle to nextH
  let g=0; while((cO.pc&0xffff)!==nextH && g++<20000) stepO();
  if((cO.pc&0xffff)!==nextH){
    console.log(`PC DIVERGENCE @ dispatch ${d}: after block 0x${pcH.toString(16)} hybrid-> 0x${nextH.toString(16)}, oracle couldn't reach (stuck 0x${(cO.pc&0xffff).toString(16)})`);
    console.log("  block 0x"+pcH.toString(16)+" disasm:"); let a=pcH;for(let i=0;i<20;i++){const ins=decode(new Uint8Array([mH.read(a),mH.read(a+1),mH.read(a+2)]),0,a);console.log(`    0x${a.toString(16)}: ${ins.text}`);if(ins.isTerminator)break;a+=ins.length;}
    console.log("  hybrid regs after block: "+rH());
    console.log("  oracle regs (stuck):     "+rO());
    break;
  }
  // both at nextH boundary — compare
  if(rO()!==rH()){
    console.log(`REG DIVERGENCE at block boundary 0x${nextH.toString(16)} (dispatch ${d}) after running block 0x${pcH.toString(16)}:`);
    console.log("  oracle: "+rO());
    console.log("  hybrid: "+rH());
    console.log("  block 0x"+pcH.toString(16)+" disasm:"); let a=pcH;for(let i=0;i<24;i++){const ins=decode(new Uint8Array([mH.read(a),mH.read(a+1),mH.read(a+2)]),0,a);console.log(`    0x${a.toString(16)}: ${ins.text} [${mH.read(a).toString(16)}]`);if(ins.isTerminator)break;a+=ins.length;}
    break;
  }
  lastBlock=pcH; lastRO=rO(); lastRH=rH();
}
console.log("dispatches:",d);
