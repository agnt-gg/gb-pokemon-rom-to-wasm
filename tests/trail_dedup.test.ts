/** Trace block entries, dedup consecutive repeats, show last 50 distinct before 0x0038. */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { Joypad } from "../src/runtime/joypad.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const mmu = new MMU(new Uint8Array(readFileSync("C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb")));
const cpu=new CPU(mmu); const ppu=new PPU(mmu); const timer=new Timer(mmu); new Joypad(mmu);
const memory=new WebAssembly.Memory({initial:2,maximum:2}); let ex:any;
const w2c=()=>{cpu.a=ex.get_A();cpu.f=ex.get_F()&0xf0;cpu.b=ex.get_B();cpu.c=ex.get_C();cpu.d=ex.get_D();cpu.e=ex.get_E();cpu.h=ex.get_H();cpu.l=ex.get_L();cpu.sp=ex.get_SP();cpu.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cpu.a);ex.set_F(cpu.f&0xf0);ex.set_B(cpu.b);ex.set_C(cpu.c);ex.set_D(cpu.d);ex.set_E(cpu.e);ex.set_H(cpu.h);ex.set_L(cpu.l);ex.set_SP(cpu.sp);ex.set_PC(cpu.pc);};
const tk=(c:number)=>{ppu.step(c);timer.step(c);};
const imports={env:{mem:memory,rb:(a:number)=>mmu.read(a&0xffff),wb:(a:number,v:number)=>mmu.write(a&0xffff,v&0xff),
  tick:(c:number)=>{cpu.cycles+=c;tk(c);},
  interp:(a:number)=>{w2c();const ins=decode(new Uint8Array([mmu.read(a),mmu.read((a+1)&0xffff),mmu.read((a+2)&0xffff)]),0,a);const s=cpu.pc;cpu.exec(ins);if(!ins.isTerminator)cpu.pc=s;c2w();},
  dispatch:(pc:number)=>pc,set_ime:(v:number)=>{(cpu as any).ime=!!v;},sched_ei:()=>{(cpu as any).imeScheduled=true;},set_halt:(v:number)=>{cpu.halted=!!v;},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex=instance.exports;
ex.set_A(1);ex.set_F(0xb0);ex.set_B(0);ex.set_C(0x13);ex.set_D(0);ex.set_E(0xd8);ex.set_H(1);ex.set_L(0x4d);ex.set_SP(0xfffe);ex.set_PC(0x100);
mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);

const trail:{pc:number,sp:number,term:string,tgt:string}[]=[];
function pushTrail(pc:number,sp:number){
  // disasm terminator
  let a=pc,term="?",tgt="";
  for(let i=0;i<60;i++){const ins=decode(new Uint8Array([mmu.read(a),mmu.read(a+1),mmu.read(a+2)]),0,a);if(ins.isTerminator){term=ins.text;tgt=JSON.stringify((ins as any).operands?.filter((o:any)=>o.kind==="imm16"||o.kind==="cond").map((o:any)=>o.value??o.cc)||[]);break;}a+=ins.length;}
  const last=trail[trail.length-1];
  if(last && last.pc===pc) return; // dedup consecutive
  trail.push({pc,sp,term,tgt}); if(trail.length>50)trail.shift();
}

function rc(target:number){const start=cpu.cycles;let g=0;while(cpu.cycles-start<target&&g++<200000){
  w2c();const ic=cpu.serviceInterrupts();if(ic>0){c2w();tk(ic);}
  if(cpu.halted){cpu.cycles+=4;tk(4);if(cpu.serviceInterrupts()>0){cpu.halted=false;c2w();}continue;}
  const cur=ex.get_PC()&0xffff;
  pushTrail(cur, ex.get_SP()&0xffff);
  if(cur===0x0038){
    console.log("DERAIL to 0x0038. Last 50 distinct blocks (pc | SP | terminator | targets):");
    for(const t of trail) console.log(`  0x${t.pc.toString(16).padStart(4,"0")} SP=0x${t.sp.toString(16)}  [${t.term}] ${t.tgt}`);
    throw new Error("done");
  }
  if(cur>=0x4000&&cur<=0x7fff){w2c();let i=0;while((cpu.pc&0xffff)>=0x4000&&(cpu.pc&0xffff)<=0x7fff&&i++<8192&&!cpu.halted){const b=cpu.cycles;cpu.step();tk(cpu.cycles-b);}c2w();continue;}
  const cyB=cpu.cycles;const next=ex.run(cur);
  if(next===SENTINEL_HALT){cpu.halted=true;w2c();}else if(next===UNKNOWN_BLOCK){w2c();cpu.step();c2w();}
  const pcA=ex.get_PC()&0xffff;if(cpu.cycles===cyB&&pcA===cur){w2c();const p=cpu.pc;cpu.step();if(cpu.cycles===cyB&&cpu.pc===p)cpu.cycles+=4;c2w();tk(4);}
}}
try{for(let f=0;f<80;f++)rc(70224);console.log("no crash in 80 frames");}catch(e){}
