/**
 * Dev server for gb-recomp.
 *
 *   node --experimental-strip-types tools/serve.ts [--rom "<path>"] [--port 8080]
 *
 * Serves the web/ shell and exposes:
 *   GET /                  -> web/index.html
 *   GET /web/*             -> static assets
 *   GET /api/wasm          -> the recompiled game_logic.wasm (recompiled live from the ROM)
 *   GET /api/rom-info      -> JSON { title, mbc, banks, blocks, instrs }
 *
 * The browser instantiates the wasm itself and runs the frame loop client-side; the server
 * only does the heavy SM83->WASM recompilation (which needs Node + wabt) and hands over the
 * binary + a tiny manifest.
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { MMU } from "../src/runtime/mmu.ts";
import { buildBlocks, buildModuleWat } from "../src/recompiler/module.ts";
import { assembleWat } from "../src/recompiler/assemble.ts";

const DEFAULT_ROM =
  "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator\\Pokemon Red\\Pokemon Red.gb";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const ROM_PATH = arg("--rom", DEFAULT_ROM);
const PORT = parseInt(arg("--port", "8080"), 10);
const ROOT = process.cwd();

const STANDARD_ENTRIES = [
  0x0100, 0x0150, 0x0000, 0x0008, 0x0010, 0x0018, 0x0020, 0x0028, 0x0030, 0x0038,
  0x0040, 0x0048, 0x0050, 0x0058, 0x0060,
];

// Recompile once at startup, cache the bytes + manifest.
let wasmBytes: Uint8Array;
let manifest: any;

async function recompile(): Promise<void> {
  if (!existsSync(ROM_PATH)) {
    console.error(`\n  ✗ ROM not found: ${ROM_PATH}\n    Pass --rom "<path to .gb>"`);
    process.exit(1);
  }
  const rom = new Uint8Array(readFileSync(ROM_PATH));
  const mmu = new MMU(rom);
  const mem = (a: number) => mmu.read(a);
  const t0 = Date.now();
  const blocks = buildBlocks(mem, STANDARD_ENTRIES, { maxBlocks: 20000 });
  const wat = buildModuleWat(blocks);
  wasmBytes = await assembleWat(wat);
  let instrs = 0; for (const b of blocks.values()) instrs += b.instrCount;
  manifest = {
    title: mmu.romTitle(),
    mbc: mmu.mbc,
    banks: mmu.romBankCount,
    romSizeKB: Math.round(rom.length / 1024),
    blocks: blocks.size,
    instrs,
    wasmBytes: wasmBytes.length,
    recompileMs: Date.now() - t0,
  };
  // Stash the ROM bytes too — the browser needs them to seed VRAM/MMU mirror & banking reads
  // are served via the /api/rom endpoint.
  (manifest as any)._romLen = rom.length;
  cachedRom = rom;
}
let cachedRom: Uint8Array;

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".ico": "image/x-icon",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;

  try {
    if (url === "/api/wasm") {
      res.writeHead(200, { "content-type": "application/wasm" });
      res.end(Buffer.from(wasmBytes));
      return;
    }
    if (url === "/api/rom") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from(cachedRom));
      return;
    }
    if (url === "/api/rom-info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }

    let file = url === "/" ? "web/index.html" : url.replace(/^\//, "");
    const path = join(ROOT, file);
    if (!path.startsWith(ROOT) || !existsSync(path)) {
      res.writeHead(404); res.end("not found"); return;
    }
    const ext = extname(path);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(readFileSync(path));
  } catch (e) {
    res.writeHead(500); res.end(String((e as Error).message));
  }
});

await recompile();
server.listen(PORT, () => {
  console.log("");
  console.log("  ╔══════════════════════════════════════════════════════╗");
  console.log("  ║              gb-recomp  ·  dev server                  ║");
  console.log("  ╚══════════════════════════════════════════════════════╝");
  console.log(`    ROM      : ${manifest.title}  (${manifest.mbc}, ${manifest.romSizeKB} KB)`);
  console.log(`    Recomp   : ${manifest.blocks} blocks / ${manifest.instrs} instrs -> ${(manifest.wasmBytes/1024).toFixed(0)} KB wasm (${manifest.recompileMs}ms)`);
  console.log("");
  console.log(`    ▶  PLAY:  http://localhost:${PORT}`);
  console.log("");
});
