/**
 * Browser entry: fetch wasm + rom, build the machine, run the frame loop, wire input.
 */
import { BrowserMachine } from "./host_browser.ts";
import type { Button } from "../runtime/joypad.ts";
import {
  BatteryAutoSaver, writeSaveState, readSaveState, listSaveStates,
  writeAutoCheckpoint, readAutoCheckpoint,
  downloadBytes, pickFile,
} from "./save.ts";
import { AudioSink } from "./audio.ts";

const NUM_STATE_SLOTS = 3;

const KEYMAP: Record<string, Button> = {
  ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down",
  KeyD: "right", KeyA: "left", KeyW: "up", KeyS: "down",
  KeyZ: "a", KeyX: "b", KeyK: "a", KeyJ: "b",
  Enter: "start", ShiftRight: "select", ShiftLeft: "select", Backspace: "select",
};

async function boot() {
  const statusEl = document.getElementById("status")!;
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const fpsEl = document.getElementById("fps")!;
  const infoEl = document.getElementById("rominfo")!;

  statusEl.textContent = "fetching recompiled wasm…";
  const [info, wasm, rom] = await Promise.all([
    fetch("/api/rom-info").then((r) => r.json()),
    fetch("/api/wasm").then((r) => r.arrayBuffer()),
    fetch("/api/rom").then((r) => r.arrayBuffer()),
  ]);

  infoEl.innerHTML =
    `<b>${info.title}</b> · ${info.mbc} · ${info.romSizeKB}KB<br>` +
    `${info.blocks} SM83 blocks / ${info.instrs} instrs → ${(info.wasmBytes / 1024).toFixed(0)}KB WASM module`;

  console.log("[gb] fetched: rom-info, wasm(" + wasm.byteLength + "), rom(" + rom.byteLength + ")");
  statusEl.textContent = "instantiating WebAssembly…";
  const machine = await BrowserMachine.create(new Uint8Array(wasm), new Uint8Array(rom));
  console.log("[gb] machine created, PC=0x" + machine.exports.get_PC().toString(16));

  // ---- SAVE SYSTEM ----------------------------------------------------------
  const saver = new BatteryAutoSaver(machine);
  const toastEl = document.getElementById("savetoast")!;
  const battEl = document.getElementById("battstatus")!;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const toast = (msg: string) => {
    toastEl.textContent = msg; toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  };

  // Load any persisted battery save BEFORE the first frame runs.
  const hadSave = await saver.loadAtBoot();
  battEl.textContent = machine.hasBattery()
    ? (hadSave ? "loaded from this browser" : "new — autosaves on change")
    : "cartridge has no battery";
  const autoEl = document.getElementById("autostatus");
  const fmtAge = (ms: number) => {
    const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    return Math.floor(m / 60) + "h ago";
  };
  const refreshAuto = () => {
    const cp = readAutoCheckpoint(machine.saveKey());
    if (autoEl) autoEl.textContent = cp ? "checkpoint " + fmtAge(cp.savedAt) : "none yet";
    const btn = document.getElementById("btn-load-auto") as HTMLButtonElement | null;
    if (btn) btn.disabled = !cp;
  };
  refreshAuto();
  const writeAuto = () => {
    try { writeAutoCheckpoint(machine.saveKey(), machine.snapshot()); refreshAuto(); }
    catch (e) { console.warn("[save] auto-checkpoint failed", e); }
  };
  saver.onFlush = (bytes) => {
    battEl.textContent = "saved ✓ (" + (bytes / 1024).toFixed(0) + "KB)";
    // When an in-game SAVE mutates SRAM and the battery save persists, also create/update a
    // protected auto-checkpoint save-state. This never touches manual slots 1/2/3.
    writeAuto();
  };

  // Reflect which save-state slots already exist.
  const refreshSlots = () => {
    const have = new Set(listSaveStates(machine.saveKey(), NUM_STATE_SLOTS).map((s) => s.slot));
    document.querySelectorAll<HTMLButtonElement>("[data-state-load]").forEach((el) => {
      el.disabled = !have.has(Number(el.dataset.stateLoad));
    });
  };
  refreshSlots();

  // Overwrite guard: saving into an OCCUPIED slot requires a second click within 3s.
  // Empty slots save immediately (no nag). Hotkeys go through the same guard.
  const pendingOverwrite: { slot: number; timer: ReturnType<typeof setTimeout> | null } = { slot: -1, timer: null };
  const clearPending = () => {
    if (pendingOverwrite.timer) clearTimeout(pendingOverwrite.timer);
    const prev = pendingOverwrite.slot;
    pendingOverwrite.slot = -1; pendingOverwrite.timer = null;
    if (prev >= 0) {
      const btn = document.querySelector<HTMLButtonElement>(`[data-state-save="${prev}"]`);
      if (btn) { btn.classList.remove("confirm"); btn.textContent = "Save\u00a0" + (prev + 1); }
    }
  };
  const writeSlot = (slot: number) => {
    try {
      writeSaveState(machine.saveKey(), slot, machine.snapshot());
      refreshSlots(); toast("State saved to slot " + (slot + 1));
    } catch { toast("⚠ slot " + (slot + 1) + " save failed (storage full?)"); }
  };
  const doSaveState = (slot: number) => {
    const occupied = !!readSaveState(machine.saveKey(), slot);
    if (!occupied) { clearPending(); writeSlot(slot); return; }
    if (pendingOverwrite.slot === slot) { clearPending(); writeSlot(slot); return; } // confirmed
    // first click on an occupied slot — arm confirmation
    clearPending();
    pendingOverwrite.slot = slot;
    const btn = document.querySelector<HTMLButtonElement>(`[data-state-save="${slot}"]`);
    if (btn) { btn.classList.add("confirm"); btn.textContent = "Overwrite?"; }
    toast("Slot " + (slot + 1) + " has a save — click again to overwrite");
    pendingOverwrite.timer = setTimeout(clearPending, 3000);
  };
  const doLoadState = (slot: number) => {
    const st = readSaveState(machine.saveKey(), slot);
    if (!st) { toast("Slot " + (slot + 1) + " is empty"); return; }
    machine.restore(st); toast("State loaded from slot " + (slot + 1));
  };

  // Toolbar buttons
  document.getElementById("btn-save-now")!.addEventListener("click", async () => {
    await saver.flush(); toast("Battery saved to this browser");
  });
  document.getElementById("btn-export-sav")!.addEventListener("click", () => {
    const name = (machine.saveKey().split(":")[1] || "game") + ".sav";
    downloadBytes(name, machine.getBatterySave()); toast("Exported " + name);
  });
  document.getElementById("btn-import-sav")!.addEventListener("click", async () => {
    const data = await pickFile(".sav,application/octet-stream");
    if (!data) return;
    machine.loadBatterySave(data); await saver.flush();
    toast("Imported .sav (" + (data.length / 1024).toFixed(0) + "KB) — reset/continue in-game");
  });
  document.getElementById("btn-load-auto")?.addEventListener("click", () => {
    const cp = readAutoCheckpoint(machine.saveKey());
    if (!cp) { toast("No auto checkpoint yet"); return; }
    machine.restore(cp.state); toast("Loaded auto checkpoint from " + fmtAge(cp.savedAt));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-state-save]").forEach((el) =>
    el.addEventListener("click", () => doSaveState(Number(el.dataset.stateSave))));
  document.querySelectorAll<HTMLButtonElement>("[data-state-load]").forEach((el) =>
    el.addEventListener("click", () => doLoadState(Number(el.dataset.stateLoad))));

  // Hotkeys: F5/F6/F7 = save slot 1/2/3, F8/F9/F10 = load slot 1/2/3.
  const STATE_KEYS: Record<string, () => void> = {
    F5: () => doSaveState(0), F6: () => doSaveState(1), F7: () => doSaveState(2),
    F8: () => doLoadState(0), F9: () => doLoadState(1), F10: () => doLoadState(2),
    KeyM: () => { const muted = audio.toggleMute(); if (soundBtn && audio.isStarted) soundBtn.textContent = muted ? "🔇 Sound off" : "🔊 Sound on"; toast(muted ? "Muted" : "Unmuted"); },
  };

  // Persist on tab hide / close so progress is never lost.
  document.addEventListener("visibilitychange", () => { if (document.hidden) void saver.flush(); });
  window.addEventListener("beforeunload", () => { void saver.flush(); });

  // ---- AUDIO ----------------------------------------------------------------
  // Browsers block autoplay; the AudioContext must start inside a user gesture.
  const audio = new AudioSink();
  const soundBtn = document.getElementById("btn-sound") as HTMLButtonElement | null;
  const startAudio = async () => {
    try {
      await audio.ensureStarted();
      if (soundBtn) soundBtn.textContent = audio.muted ? "🔇 Sound off" : "🔊 Sound on";
    } catch (e) { console.warn("[gb] audio start failed", e); }
  };
  // First click/keydown anywhere starts audio.
  const gestureStart = () => { void startAudio(); window.removeEventListener("pointerdown", gestureStart); window.removeEventListener("keydown", gestureStart); };
  window.addEventListener("pointerdown", gestureStart);
  window.addEventListener("keydown", gestureStart);
  if (soundBtn) soundBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!audio.isStarted) { await startAudio(); return; }
    const muted = audio.toggleMute();
    soundBtn.textContent = muted ? "🔇 Sound off" : "🔊 Sound on";
  });

  statusEl.textContent = "running ▶";

  const img = ctx.createImageData(machine.width, machine.height);

  // input
  window.addEventListener("keydown", (e) => {
    const st = STATE_KEYS[e.code];
    if (st) { st(); e.preventDefault(); return; }
    const b = KEYMAP[e.code]; if (b) { machine.setButton(b, true); e.preventDefault(); }
  });
  window.addEventListener("keyup", (e) => {
    const b = KEYMAP[e.code]; if (b) { machine.setButton(b, false); e.preventDefault(); }
  });
  // on-screen buttons
  document.querySelectorAll("[data-btn]").forEach((el) => {
    const b = (el as HTMLElement).dataset.btn as Button;
    const down = (ev: Event) => { ev.preventDefault(); machine.setButton(b, true); };
    const up = (ev: Event) => { ev.preventDefault(); machine.setButton(b, false); };
    el.addEventListener("mousedown", down); el.addEventListener("touchstart", down, { passive: false });
    el.addEventListener("mouseup", up); el.addEventListener("mouseleave", up);
    el.addEventListener("touchend", up);
  });

  let last = performance.now();
  let frameCount = 0;
  let fpsAccum = 0;

  const SPEED_STORAGE_KEY = "gb-playback-speed";
  const validSpeed = (v: number) => ([1, 2, 4].includes(v) ? v : 2);
  let PLAYBACK_SPEED = validSpeed(Number(localStorage.getItem(SPEED_STORAGE_KEY) || "2"));
  const speedStatus = document.getElementById("speedstatus");
  const speedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-speed]"));
  function applyPlaybackSpeed(v: number) {
    PLAYBACK_SPEED = validSpeed(v);
    localStorage.setItem(SPEED_STORAGE_KEY, String(PLAYBACK_SPEED));
    // Gameplay/PPU run at PLAYBACK_SPEED, but APU stays near 1x so music/SFX pitch and tempo
    // do not speed up when we boost perceived walking speed.
    // Gameplay speed automatically sets inverse audio speed: 1x=>1x, 2x=>0.5x, 4x=>0.25x.
    machine.audioCycleScale = 1 / PLAYBACK_SPEED;
    audio.setPlaybackSpeed(1 / PLAYBACK_SPEED);
    if (speedStatus) speedStatus.textContent = PLAYBACK_SPEED + "x gameplay · audio " + (1 / PLAYBACK_SPEED) + "x";
    speedButtons.forEach((b) => {
      const on = Number(b.dataset.speed) === PLAYBACK_SPEED;
      b.setAttribute("aria-pressed", String(on));
      b.style.borderColor = on ? "var(--accent2)" : "var(--border)";
      b.style.color = on ? "var(--accent2)" : "var(--ink)";
    });
  }
  speedButtons.forEach((b) => b.addEventListener("click", () => applyPlaybackSpeed(Number(b.dataset.speed))));
  applyPlaybackSpeed(PLAYBACK_SPEED);

  let dead = false;
  function loop(now: number) {
    if (dead) return;
    const rawDt = now - last;
    const dt = (frameCount === 0 ? (1000 / 59.7275) : Math.min(50, Math.max(1, rawDt))) * PLAYBACK_SPEED;
    last = now;
    try {
      // Smooth real-time pacing: advance Game Boy time by elapsed wall-clock milliseconds,
      // then render once. This avoids both slow game-time at <60 rAF and chunky hidden
      // multi-frame catch-up that skips visible animation frames.
      machine.runForMilliseconds(dt);
    } catch (err) {
      dead = true;
      statusEl.textContent = "frame error: " + (err as Error).message;
      console.error("[gb] runFrame threw at frame", frameCount, err);
      return;
    }
    img.data.set(machine.framebuffer);
    ctx.putImageData(img, 0, 0);
    const a = machine.drainAudio();
    if (a.left.length) audio.push(a.left, a.right);
    saver.tick();

    frameCount++;
    fpsAccum += dt;
    if (frameCount % 15 === 0) {
      const stall = (machine as any).lastStall;
      fpsEl.textContent = (1000 / (fpsAccum / 15)).toFixed(0) + " fps · realtime cycles · " + PLAYBACK_SPEED.toFixed(1) + "x";
      statusEl.textContent = stall ? ("running ✓ (" + stall + ")") : ("running ✓ frame " + frameCount);
      fpsAccum = 0;
    }
    if (frameCount === 1) console.log("[gb] first frame rendered");
    requestAnimationFrame(loop);
  }
  console.log("[gb] starting frame loop");
  requestAnimationFrame(loop);
}

boot().catch((e) => {
  document.getElementById("status")!.textContent = "error: " + e.message;
  console.error(e);
});
