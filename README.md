# gb-recomp — Game Boy Pokémon ROM machine-code to WebAssembly

`gb-recomp` is an experimental Sharp SM83 / Game Boy ROM-to-WebAssembly recompiler and browser runtime.

It reads user-provided Game Boy / Game Boy Color-compatible Pokémon ROMs, decodes the ROMs' already-assembled SM83 machine code, discovers executable blocks, lifts safe fixed-ROM code into WebAssembly, and hosts the generated WASM inside a JavaScript Game Boy hardware runtime.

The project began with **Pokémon Red / MBC3** and now includes a multi-ROM 3D library for:

| ID | Game | Header title | Cart / mapper | Runtime status |
|---|---|---|---|---|
| `red` | Pokémon Red | `POKEMON RED` | MBC3 + RAM + Battery | Playable target |
| `blue` | Pokémon Blue | `POKEMON BLUE` | MBC3 + RAM + Battery | Playable candidate |
| `yellow` | Pokémon Yellow | `POKEMON YELLOW` | MBC5 + RAM + Battery | Playable candidate; MBC5 + LCD/STAT fixes |
| `gold` | Pokémon Gold | `POKEMON_GLD` | MBC3 + Timer + RAM + Battery | Playable candidate; RTC register/latch support |
| `silver` | Pokémon Silver | `POKEMON_SLV` | MBC3 + Timer + RAM + Battery | Playable candidate; RTC register/latch support |
| `crystal` | Pokémon Crystal | `PM_CRYSTAL` | MBC3 + Timer + RAM + Battery, CGB-only | Experimental CGB target; boots/title-smoke-tested with partial CGB runtime |

> Important: this repository does **not** include any ROM. You must provide your own legally obtained ROMs locally. Do not commit ROMs, generated game WASM, `.sav` files, or save-state exports.

## What this is

```txt
Game Boy ROM bytes
→ SM83 opcode decoder
→ control-flow graph / basic blocks
→ WAT / WASM generation
→ BrowserMachine host
→ JS hardware runtime: MMU, MBC1/MBC3/MBC5, RTC, PPU, APU, timer, joypad, saves
→ playable 2D/3D browser artifact
→ multi-ROM 3D library
```

This is not source assembly compilation. It is binary lifting from ROM machine code.

## What works now

- SM83 opcode decoding and targeted instruction tests
- static block discovery for fixed-ROM code
- WebAssembly Text / WASM generation
- hybrid execution with interpreter fallback for banked/unsafe/timing-sensitive regions
- MBC/MMU behavior including SRAM, MBC3, MBC5, and OAM DMA
- minimal MBC3 real-time-clock register select/latch behavior for Gold/Silver/Crystal
- CGB-era title parsing for clean save namespaces (`POKEMON_GLD`, `POKEMON_SLV`)
- PPU rendering: background/window/sprites
- Yellow-specific LCD/STAT blank-screen fix: no synthetic STAT interrupt storm while LCD is disabled
- APU/WebAudio output
- keyboard/touch/3D joypad input
- IndexedDB battery saves
- `.sav` import/export for cartridge SRAM
- manual save-state slots with visible occupied-slot labels
- save-state bundle export/import (`*.states.json`) for moving states between ports/origins
- protected auto checkpoint on in-game save persistence
- 2D themed browser frontend
- custom Three.js Game Boy frontend with live framebuffer texture
- ROM library page: `web/3d-library.html`
- partial CGB runtime path for Crystal: CGB boot identity, 2-bank VRAM, 8-bank WRAM, CGB palettes, tile/sprite attribute support, HDMA transfer handling, and KEY1/STOP speed-switch semantics
- transparent shell themes with internal PCB/battery details
- scientific writeup in `docs/rom-to-wasm-process.html`

## Install

```bash
npm install
```

## Build TypeScript

```bash
npm run build
npx tsc -p tsconfig.browser.json
```

## Run tests

```bash
npm test
```

Or run individual diagnostics with Node's TypeScript stripping:

```bash
node --test --experimental-strip-types tests/decoder.test.ts
node --test --experimental-strip-types tests/save_system.test.ts
node --test --experimental-strip-types tests/apu.test.ts
```

## Recompile a local ROM

```bash
npm run recomp -- "C:/path/to/your/Pokemon Red.gb" --out build
```

Generated outputs go under `build/`, which is intentionally gitignored.

## Serve the browser demo

The dev server reads local ROM paths from `tools/serve.ts`, recompiles/serves each selected ROM on demand, and exposes the browser frontends.

```bash
npm run serve
```

Then open:

```txt
http://localhost:8080/
http://localhost:8080/web/3d.html
http://localhost:8080/web/3d-library.html
```

Direct library links:

```txt
http://localhost:8080/web/3d-library.html?rom=red
http://localhost:8080/web/3d-library.html?rom=blue
http://localhost:8080/web/3d-library.html?rom=yellow
http://localhost:8080/web/3d-library.html?rom=gold
http://localhost:8080/web/3d-library.html?rom=silver
http://localhost:8080/web/3d-library.html?rom=crystal
```

Depending on your local setup, configure `ROM_ROOT` / catalog paths in `tools/serve.ts` before running. The repository intentionally does not ship ROMs.

## Save model

There are two distinct save layers:

1. **Battery / in-game save (`.sav`)** — cartridge SRAM written by the game's own SAVE menu. This is persisted to IndexedDB and can be exported/imported as standard `.sav` bytes.
2. **Save state** — full emulator/runtime snapshot: CPU registers, MMU memory, VRAM, OAM, PPU/timer state, banking state, frame count, etc. These are stored in localStorage and can be exported/imported as `*.states.json` bundles.

Browser storage is scoped by origin. `localhost:8080` and `localhost:8099` do not share save states automatically; use **Export states / Import states** to move them.

## Project layout

```txt
src/recompiler/   SM83 decoder, block discovery, lifter, WAT/WASM assembly
src/runtime/      Game Boy hardware runtime: MMU, MBC1/MBC3/MBC5, RTC, PPU, APU, timer, joypad, interpreter
src/browser/      BrowserMachine host, saves, audio, 2D/3D frontend bridges, multi-ROM 3D library, CGB boot routing
tests/            decoder, CPU, lockstep, banking, DMA, APU, save, browser diagnostics
tools/            local dev server + ROM catalog
docs/             scientific writeup
web/              browser HTML/assets/audio worklet
```

## Static recompilation vs hybrid runtime

The project intentionally separates three concepts:

1. **Static recompilation** — safe fixed-ROM SM83 blocks lifted to WASM.
2. **Interpreter fallback** — banked/RAM/unsafe/timing-sensitive dynamic code executes against live MMU bytes.
3. **Hardware runtime** — JS models memory banking, PPU, APU, timers, interrupts, input, saves, and mapper behavior.

This is why the project should be described as a hybrid static recompiler plus hardware runtime, not as a pure static compiler for all Game Boy behavior.

## Multi-ROM milestone — 2026-06-05

The live branch was extended from the original Red proof target into a Pokémon GB/GBC-compatible library:

- Blue added as another MBC3 Generation I target.
- Yellow added with MBC5 support.
- Gold and Silver added with MBC3 timer/RTC register support.
- Crystal added as an experimental CGB-only target with a partial CGB hardware path.
- 3D library page added for ROM selection.
- Battery `.sav` export/import hardened.
- Save-state slot visibility plus export/import bundles added.

## Crystal / CGB status

Crystal is possible because the runtime now has a CGB mode, but it should be treated as **experimental** rather than as a completed Game Boy Color emulator. The current CGB slice is enough for boot/title/input smoke tests and browser testing, and includes:

- CGB-only boot identity for `0x0143 == 0xC0` ROMs
- VRAM bank register `FF4F / VBK`
- WRAM bank register `FF70 / SVBK`
- CGB BG/OBJ palette registers `FF68-FF6B`
- BG/window tile attributes: palette, tile bank, horizontal/vertical flip
- OBJ CGB attributes: palette and tile bank
- VRAM DMA / HDMA register path `FF51-FF55`
- KEY1 / STOP speed-switch register semantics
- save-state serialization of CGB banks, palette RAM, HDMA state, and KEY1

Future polish for broader CGB compatibility includes exact HDMA timing, full CGB priority behavior, double-speed cycle accounting, additional CGB timing edge cases, and broader ROM corpus testing.

## Legal

This repository contains no Nintendo ROMs and no copyrighted game data by design.

Do not commit ROMs, generated game WASM, save files, or other user-provided copyrighted data.

## Asset attribution

See `ATTRIBUTION.md` for third-party 3D model attribution.
