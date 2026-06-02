# gb-recomp — Game Boy ROM machine-code to WebAssembly

`gb-recomp` is an experimental Sharp SM83 / Game Boy ROM-to-WebAssembly recompiler and browser runtime.

It reads a user-provided Game Boy ROM, decodes the ROM's already-assembled SM83 machine code, discovers executable blocks, lifts safe fixed-ROM code into WebAssembly, and hosts the generated WASM inside a JavaScript Game Boy hardware runtime.

The project was developed around Pokémon Red / MBC3 as the initial proof target.

> Important: this repository does **not** include any ROM. You must provide your own legally obtained Game Boy ROM locally.

## What this is

```txt
Game Boy ROM bytes
→ SM83 opcode decoder
→ control-flow graph / basic blocks
→ WAT / WASM generation
→ BrowserMachine host
→ JS hardware runtime: MMU, MBC, PPU, APU, timer, joypad, saves
→ playable 2D/3D browser artifact
```

This is not source assembly compilation. It is binary lifting from ROM machine code.

## What works in the current proof target

- SM83 opcode decoding and targeted instruction tests
- static block discovery for fixed-ROM code
- WebAssembly Text / WASM generation
- hybrid execution with interpreter fallback for banked/unsafe regions
- MBC/MMU behavior including SRAM and OAM DMA
- PPU rendering: background/window/sprites
- APU/WebAudio output
- keyboard/touch/3D joypad input
- IndexedDB battery saves
- manual save-state slots with overwrite protection
- protected auto checkpoint on in-game save persistence
- 2D themed browser frontend
- custom Three.js Game Boy frontend with live framebuffer texture
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

The dev server recompiles/serves the local ROM and frontend.

```bash
npm run serve
```

Then open:

```txt
http://localhost:8080/
http://localhost:8080/web/3d.html
http://localhost:8080/web/3d-model.html
```

Depending on your local setup, you may need to configure the ROM path in `tools/serve.ts` or extend the server to accept a CLI/env ROM path before publishing broadly.

## Project layout

```txt
src/recompiler/   SM83 decoder, block discovery, lifter, WAT/WASM assembly
src/runtime/      Game Boy hardware runtime: MMU, PPU, APU, timer, joypad, interpreter
src/browser/      BrowserMachine host, saves, audio, 2D/3D frontend bridges
tests/            decoder, CPU, lockstep, banking, DMA, APU, save, browser diagnostics
tools/            local dev server
docs/             scientific writeup
web/              browser HTML/assets/models/audio worklet
```

## Static recompilation vs hybrid runtime

The project intentionally separates three concepts:

1. **Static recompilation** — safe fixed-ROM SM83 blocks lifted to WASM.
2. **Interpreter fallback** — banked/RAM/unsafe dynamic code executes against live MMU bytes.
3. **Hardware runtime** — JS models memory banking, PPU, APU, timers, interrupts, input, and saves.

This is why the project should be described as a hybrid static recompiler plus hardware runtime, not as a pure static compiler for all Game Boy behavior.

## Legal

This repository contains no Nintendo ROMs and no copyrighted game data by design.

Do not commit ROMs, generated game WASM, save files, or other user-provided copyrighted data.

## Asset attribution

See `ATTRIBUTION.md` for third-party 3D model attribution.
