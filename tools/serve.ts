/**
 * Dev server for gb-recomp.
 *
 * Backward-compatible endpoints:
 *   GET /api/wasm      -> default/current ROM wasm (Red unless --rom is provided)
 *   GET /api/rom       -> default/current ROM bytes
 *   GET /api/rom-info  -> default/current ROM manifest
 *
 * Multi-ROM endpoints for web/3d-library.html:
 *   GET /api/roms              -> supported local ROM catalog
 *   GET /api/wasm?id=red|blue|yellow|gold|silver|crystal  -> per-ROM recompiled wasm, compiled on demand and cached
 *   GET /api/rom?id=red|blue|yellow|gold|silver|crystal   -> per-ROM bytes
 *   GET /api/rom-info?id=...   -> per-ROM manifest
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { MMU } from "../src/runtime/mmu.ts";
import { buildBlocks, buildModuleWat } from "../src/recompiler/module.ts";
import { assembleWat } from "../src/recompiler/assemble.ts";

const ROM_ROOT = "C:\\Users\\Studio\\Documents\\Torrents\\Games\\Pokemon GBA collection + emulator";
const DEFAULT_ROM = `${ROM_ROOT}\\Pokemon Red\\Pokemon Red.gb`;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const ROM_PATH = arg("--rom", DEFAULT_ROM);
const PORT = parseInt(arg("--port", "8080"), 10);
const ROOT = process.cwd();

const ROM_CATALOG = [
  {
    id: "red",
    label: "Pokemon Red",
    version: "Red Version",
    path: `${ROM_ROOT}\\Pokemon Red\\Pokemon Red.gb`,
    theme: "fire",
    status: "playable",
    notes: "Existing target; MBC3 + RAM + Battery.",
  },
  {
    id: "blue",
    label: "Pokemon Blue",
    version: "Blue Version",
    path: `${ROM_ROOT}\\Pokemon Blue\\Pokemon Blue.gb`,
    theme: "water",
    status: "playable-candidate",
    notes: "New target; same MBC3 cartridge family as Red, built on demand.",
  },
  {
    id: "yellow",
    label: "Pokemon Yellow",
    version: "Special Pikachu Edition",
    path: `${ROM_ROOT}\\Pokemon Yellow\\Pokemon Yellow.gb`,
    theme: "electric",
    status: "playable-candidate",
    notes: "New target; MBC5 + RAM + Battery. DMG-compatible despite CGB-enhanced header.",
  },
  {
    id: "gold",
    label: "Pokemon Gold",
    version: "Gold Version",
    path: `${ROM_ROOT}\\Pokemon Gold\\Pokemon Gold.gbc`,
    theme: "gold",
    status: "playable-candidate",
    notes: "New target; MBC3 + TIMER + RAM + Battery, DMG-compatible CGB-enhanced cart.",
  },
  {
    id: "silver",
    label: "Pokemon Silver",
    version: "Silver Version",
    path: `${ROM_ROOT}\\Pokemon Silver\\Pokemon Silver.gbc`,
    theme: "silver",
    status: "playable-candidate",
    notes: "New target; MBC3 + TIMER + RAM + Battery, DMG-compatible CGB-enhanced cart.",
  },
  {
    id: "crystal",
    label: "Pokemon Crystal",
    version: "Crystal Version",
    path: `${ROM_ROOT}\\Pokemon Crystal\\Pokemon Crystal.gbc`,
    theme: "crystal",
    status: "experimental-cgb",
    notes: "CGB-only target; uses CGB VRAM/WRAM banking, palettes, HDMA, and MBC3 RTC.",
  },
] as const;

type RomId = typeof ROM_CATALOG[number]["id"];

const STANDARD_ENTRIES = [
  0x0100, 0x0150, 0x0000, 0x0008, 0x0010, 0x0018, 0x0020, 0x0028, 0x0030, 0x0038,
  0x0040, 0x0048, 0x0050, 0x0058, 0x0060,
];

interface BuildRecord {
  id: string;
  path: string;
  rom: Uint8Array;
  wasm: Uint8Array;
  manifest: any;
}

const buildCache = new Map<string, Promise<BuildRecord>>();
let defaultId: RomId | "custom" = "red";

function parseUrl(reqUrl: string | undefined): URL {
  return new URL(reqUrl ?? "/", `http://localhost:${PORT}`);
}

function catalogEntry(id: string | null) {
  return ROM_CATALOG.find((r) => r.id === id) ?? null;
}

function requestBuildKey(url: URL): { id: string; path: string; catalog: any | null } {
  const id = url.searchParams.get("id") || url.searchParams.get("rom");
  const entry = catalogEntry(id);
  if (entry) return { id: entry.id, path: entry.path, catalog: entry };
  if (!id) {
    if (defaultId !== "custom") {
      const def = catalogEntry(defaultId)!;
      return { id: def.id, path: def.path, catalog: def };
    }
    return { id: "custom", path: ROM_PATH, catalog: null };
  }
  throw new Error(`Unknown ROM id '${id}'. Available: ${ROM_CATALOG.map((r) => r.id).join(", ")}`);
}

async function buildRom(id: string, path: string, catalog: any | null): Promise<BuildRecord> {
  if (!existsSync(path)) throw new Error(`ROM not found: ${path}`);

  const rom = new Uint8Array(readFileSync(path));
  const mmu = new MMU(rom);
  const mem = (a: number) => mmu.read(a);
  const t0 = Date.now();
  const blocks = buildBlocks(mem, STANDARD_ENTRIES, { maxBlocks: 20000 });
  const wat = buildModuleWat(blocks);
  const wasm = await assembleWat(wat);
  let instrs = 0;
  for (const b of blocks.values()) instrs += b.instrCount;

  const manifest = {
    id,
    label: catalog?.label ?? mmu.romTitle(),
    version: catalog?.version ?? "Custom ROM",
    status: catalog?.status ?? "custom",
    notes: catalog?.notes ?? "Loaded from --rom.",
    title: mmu.romTitle(),
    mbc: mmu.mbc,
    cartType: `0x${(rom[0x0147] ?? 0).toString(16).padStart(2, "0")}`,
    cgbFlag: `0x${(rom[0x0143] ?? 0).toString(16).padStart(2, "0")}`,
    banks: mmu.romBankCount,
    ramSizeKB: Math.round(MMU.detectRamSize(rom) / 1024),
    romSizeKB: Math.round(rom.length / 1024),
    blocks: blocks.size,
    instrs,
    wasmBytes: wasm.length,
    recompileMs: Date.now() - t0,
    _romLen: rom.length,
  };

  return { id, path, rom, wasm, manifest };
}

function getBuild(id: string, path: string, catalog: any | null): Promise<BuildRecord> {
  const key = `${id}:${path}`;
  let p = buildCache.get(key);
  if (!p) {
    p = buildRom(id, path, catalog);
    buildCache.set(key, p);
  }
  return p;
}

async function resolveBuild(url: URL): Promise<BuildRecord> {
  const { id, path, catalog } = requestBuildKey(url);
  return getBuild(id, path, catalog);
}

function json(res: any, body: any): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".ico": "image/x-icon",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const parsed = parseUrl(req.url);
  const url = parsed.pathname;

  try {
    if (url === "/api/roms") {
      const items = await Promise.all(ROM_CATALOG.map(async (r) => {
        if (!existsSync(r.path)) return { ...r, exists: false };
        const rom = new Uint8Array(readFileSync(r.path));
        const mmu = new MMU(rom);
        return {
          ...r,
          exists: true,
          title: mmu.romTitle(),
          mbc: mmu.mbc,
          cartType: `0x${(rom[0x0147] ?? 0).toString(16).padStart(2, "0")}`,
          cgbFlag: `0x${(rom[0x0143] ?? 0).toString(16).padStart(2, "0")}`,
          banks: mmu.romBankCount,
          romSizeKB: Math.round(rom.length / 1024),
          ramSizeKB: Math.round(MMU.detectRamSize(rom) / 1024),
          cached: buildCache.has(`${r.id}:${r.path}`),
        };
      }));
      json(res, { defaultId, items });
      return;
    }

    if (url === "/api/wasm") {
      const b = await resolveBuild(parsed);
      res.writeHead(200, { "content-type": "application/wasm" });
      res.end(Buffer.from(b.wasm));
      return;
    }
    if (url === "/api/rom") {
      const b = await resolveBuild(parsed);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from(b.rom));
      return;
    }
    if (url === "/api/rom-info") {
      const b = await resolveBuild(parsed);
      json(res, b.manifest);
      return;
    }

    const file = url === "/" ? "web/index.html" : url.replace(/^\//, "");
    const path = join(ROOT, file);
    if (!path.startsWith(ROOT) || !existsSync(path)) {
      res.writeHead(404); res.end("not found"); return;
    }
    const ext = extname(path);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(readFileSync(path));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String((e as Error).message));
  }
});

if (ROM_PATH !== DEFAULT_ROM) defaultId = "custom";
const initial = await getBuild(defaultId, ROM_PATH, defaultId === "custom" ? null : catalogEntry(defaultId));
server.listen(PORT, () => {
  console.log("");
  console.log("  gb-recomp dev server");
  console.log(`    Default : ${initial.manifest.title} (${initial.manifest.mbc}, ${initial.manifest.romSizeKB} KB)`);
  console.log(`    Recomp  : ${initial.manifest.blocks} blocks / ${initial.manifest.instrs} instrs -> ${(initial.manifest.wasmBytes / 1024).toFixed(0)} KB wasm (${initial.manifest.recompileMs}ms)`);
  console.log(`    2D      : http://localhost:${PORT}/`);
  console.log(`    3D old  : http://localhost:${PORT}/web/3d.html`);
  console.log(`    3D lib  : http://localhost:${PORT}/web/3d-library.html`);
  console.log(`    ROMs    : ${ROM_CATALOG.map((r) => r.id).join(", ")}`);
  console.log("");
});
