/**
 * Reproduce the browser instantiation in Node to surface the REAL error.
 * The browser fetched rom-info + rom but /api/wasm never resolved — meaning
 * WebAssembly.instantiate either rejected or hung. This isolates it.
 */
import { readFileSync } from "node:fs";

const bytes = new Uint8Array(readFileSync("build/served.wasm"));
console.log("wasm bytes:", bytes.length);

// Minimal stub imports matching the module's import section.
const noop = () => {};
const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
const imports = {
  env: {
    mem: memory,
    rb: (_a: number) => 0,
    wb: noop,
    interp: noop,
    tick: noop,
    dispatch: (pc: number) => pc,
    set_ime: noop,
    sched_ei: noop,
    set_halt: noop,
  },
};

try {
  const t0 = Date.now();
  const { instance } = await WebAssembly.instantiate(bytes, imports as any);
  console.log("instantiate OK in", Date.now() - t0, "ms");
  console.log("exports:", Object.keys(instance.exports).slice(0, 20).join(", "), "...");
  // sanity: run the entry
  const ex: any = instance.exports;
  ex.set_PC(0x0100);
  const next = ex.run(0x0100);
  console.log("run(0x0100) ->", next.toString(16));
} catch (e) {
  console.error("INSTANTIATE FAILED:");
  console.error((e as Error).message);
}
