/**
 * WAT -> WASM assembler wrapper around wabt (the official WebAssembly Binary Toolkit,
 * compiled to WASM itself, so zero native deps).
 */
// @ts-ignore - wabt ships its own types loosely
import wabtInit from "wabt";

let wabtPromise: Promise<any> | null = null;

export async function assembleWat(wat: string): Promise<Uint8Array> {
  if (!wabtPromise) wabtPromise = wabtInit();
  const wabt = await wabtPromise;
  const mod = wabt.parseWat("module.wat", wat, {
    mutable_globals: true,
    sign_extension: true,
    bulk_memory: true,
  });
  try {
    const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
    return new Uint8Array(buffer);
  } finally {
    mod.destroy();
  }
}
