/**
 * Pinpoint the SP leak: log EVERY interrupt service (vector + SP delta) and EVERY RETI,
 * count pushes vs RETI pops between the last clean state and the crash.
 */
import { readFileSync } from "node:fs";
import { MMU } from "../src/runtime/mmu.ts";
import { CPU } from "../src/runtime/cpu.ts";
import { PPU } from "../src/runtime/ppu.ts";
import { Timer } from "../src/runtime/timer.ts";
import { Joypad } from "../src/runtime/joypad.ts";
import { decode } from "../src/recompiler/decoder.ts";
import { UNKNOWN_BLOCK, SENTINEL_HALT } from "../src/recompiler/module.ts";

const wasm = new Uint8Array(readFileSync("build/served.wasm"));
const rom = new Uint8Array(readFileSync(
  "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb"
));
const mmu = new MMU(rom); const cpu = new CPU(mmu); const ppu = new PPU(mmu); const timer = new Timer(mmu); new Joypad(mmu);
const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
let ex: any;
const w2c=()=>{cpu.a=ex.get_A();cpu.f=ex.get_F()&0xf0;cpu.b=ex.get_B();cpu.c=ex.get_C();cpu.d=ex.get_D();cpu.e=ex.get_E();cpu.h=ex.get_H();cpu.l=ex.get_L();cpu.sp=ex.get_SP();cpu.pc=ex.get_PC();};
const c2w=()=>{ex.set_A(cpu.a);ex.set_F(cpu.f&0xf0);ex.set_B(cpu.b);ex.set_C(cpu.c);ex.set_D(cpu.d);ex.set_E(cpu.e);ex.set_H(cpu.h);ex.set_L(cpu.l);ex.set_SP(cpu.sp);ex.set_PC(cpu.pc);};

let imeOn = 0, retiCount = 0, irqCount = 0;
const imports = { env: {
  mem: memory, rb:(a:number)=>mmu.read(a&0xffff), wb:(a:number,v:number)=>mmu.write(a&0xffff,v&0xff),
  tick:(c:number)=>{cpu.cycles+=c;ppu.step(c);timer.step(c);},
  interp:(addr:number)=>{w2c();const ins=decode(new Uint8Array([mmu.read(addr),mmu.read((addr+1)&0xffff),mmu.read((addr+2)&0xffff)]),0,addr);const s=cpu.pc;cpu.exec(ins);if(!ins.isTerminator)cpu.pc=s;c2w();},
  dispatch:(pc:number)=>pc,
  set_ime:(v:number)=>{(cpu as any).ime=!!v; if(v){imeOn++;retiCount++;}},
  sched_ei:()=>{(cpu as any).imeScheduled=true;},
  set_halt:(v:number)=>{cpu.halted=!!v;},
}};
const { instance } = await WebAssembly.instantiate(wasm, imports as any); ex = instance.exports;
ex.set_A(1);ex.set_F(0xb0);ex.set_B(0);ex.set_C(0x13);ex.set_D(0);ex.set_E(0xd8);ex.set_H(1);ex.set_L(0x4d);ex.set_SP(0xfffe);ex.set_PC(0x100);
mmu.rawIoWrite(0xff40,0x91);mmu.rawIoWrite(0xff47,0xfc);

let n=0;
while(n++<2_000_000){
  w2c();
  const ic=cpu.serviceInterrupts();
  if(ic>0){ irqCount++; c2w(); }
  const pcIn=ex.get_PC()&0xffff;
  if(pcIn===0x0038){console.log(`crash@${n}  IRQs serviced=${irqCount}  RETI/EI(set_ime1)=${retiCount}  leak=${irqCount-retiCount}`);break;}
  const ret=ex.run(pcIn);
  if(ret===UNKNOWN_BLOCK){w2c();cpu.step();c2w();}
  else if(ret===SENTINEL_HALT)cpu.halted=true;
}
