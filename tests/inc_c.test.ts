import { decode } from "../src/recompiler/decoder.ts";
const ins = decode(new Uint8Array([0x0c,0,0]),0,0);
console.log("0x0C decodes:", ins.mnemonic, JSON.stringify(ins.operands));
const ins2 = decode(new Uint8Array([0x0d,0,0]),0,0);
console.log("0x0D decodes:", ins2.mnemonic, JSON.stringify(ins2.operands));
const ins3 = decode(new Uint8Array([0x04,0,0]),0,0);
console.log("0x04 (INC B) decodes:", ins3.mnemonic, JSON.stringify(ins3.operands));
const ins4 = decode(new Uint8Array([0x0e,0x80,0]),0,0);
console.log("0x0E (LD C,n) decodes:", ins4.mnemonic, JSON.stringify(ins4.operands));
