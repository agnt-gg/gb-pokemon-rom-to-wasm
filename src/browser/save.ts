/**
 * Persistence layer for the emulator.
 *
 *  - BATTERY SAVE  : the cartridge's SRAM (the real ".sav"). Auto-persisted to IndexedDB and
 *                    importable/exportable as a standard .sav file (compatible with other emus).
 *  - SAVE-STATES   : full machine snapshots (CPU+RAM+PPU+timer), stored in localStorage in
 *                    numbered slots for instant restore anywhere.
 *
 * Everything is namespaced by the cartridge's header title (machine.saveKey()).
 */

import type { BrowserMachine, MachineState } from "./host_browser.ts";

// ---------------------------------------------------------------------------
// IndexedDB (battery SRAM) — survives reloads, large-binary friendly.
// ---------------------------------------------------------------------------
const DB_NAME = "gb-recomp";
const STORE = "battery";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(key: string, data: Uint8Array): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    // store a copy of the bytes (detached from the live buffer)
    tx.objectStore(STORE).put(new Uint8Array(data), key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function idbGet(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  const out = await new Promise<Uint8Array | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

// ---------------------------------------------------------------------------
// Save-states (full snapshots) in localStorage, numbered slots.
// ---------------------------------------------------------------------------
function slotKey(saveKey: string, slot: number): string {
  return `${saveKey}:state:${slot}`;
}
function autoCheckpointKey(saveKey: string): string {
  return `${saveKey}:state:auto-checkpoint`;
}

export interface AutoCheckpoint {
  savedAt: number;
  state: MachineState;
}

export function writeAutoCheckpoint(saveKey: string, state: MachineState): void {
  localStorage.setItem(autoCheckpointKey(saveKey), JSON.stringify({ savedAt: Date.now(), state } satisfies AutoCheckpoint));
}

export function readAutoCheckpoint(saveKey: string): AutoCheckpoint | null {
  const raw = localStorage.getItem(autoCheckpointKey(saveKey));
  return raw ? (JSON.parse(raw) as AutoCheckpoint) : null;
}

export function writeSaveState(saveKey: string, slot: number, state: MachineState): void {
  try {
    localStorage.setItem(slotKey(saveKey, slot), JSON.stringify(state));
  } catch (e) {
    // localStorage quota (~5MB) — a snapshot is ~100KB so this is generous, but guard anyway.
    console.warn("[save] could not write save-state slot", slot, e);
    throw e;
  }
}

export function readSaveState(saveKey: string, slot: number): MachineState | null {
  const raw = localStorage.getItem(slotKey(saveKey, slot));
  return raw ? (JSON.parse(raw) as MachineState) : null;
}

export function listSaveStates(saveKey: string, slots: number): { slot: number; frames: number }[] {
  const out: { slot: number; frames: number }[] = [];
  for (let i = 0; i < slots; i++) {
    const s = readSaveState(saveKey, i);
    if (s) out.push({ slot: i, frames: s.frames });
  }
  return out;
}

export interface SaveStateBundle {
  kind: "gb-recomp-save-states";
  version: 1;
  saveKey: string;
  exportedAt: number;
  slots: { slot: number; state: MachineState }[];
}

export function exportSaveStateBundle(saveKey: string, slots: number): SaveStateBundle {
  const out: SaveStateBundle = { kind: "gb-recomp-save-states", version: 1, saveKey, exportedAt: Date.now(), slots: [] };
  for (let i = 0; i < slots; i++) {
    const state = readSaveState(saveKey, i);
    if (state) out.slots.push({ slot: i, state });
  }
  return out;
}

export function importSaveStateBundle(saveKey: string, bundle: SaveStateBundle): number {
  if (!bundle || bundle.kind !== "gb-recomp-save-states" || !Array.isArray(bundle.slots)) {
    throw new Error("Not a gb-recomp save-state bundle");
  }
  let n = 0;
  for (const row of bundle.slots) {
    if (!row || typeof row.slot !== "number" || !row.state) continue;
    writeSaveState(saveKey, row.slot, row.state);
    n++;
  }
  return n;
}

export function downloadJson(filename: string, value: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
  downloadBytes(filename, bytes);
}

// ---------------------------------------------------------------------------
// File import/export (download a .sav, .json state bundle, or load one from disk).
// ---------------------------------------------------------------------------
export function downloadBytes(filename: string, data: Uint8Array): void {
  // Copy into a fresh ArrayBuffer-backed view so it satisfies BlobPart under strict TS lib types
  // and is detached from the live SRAM buffer.
  const buf = new Uint8Array(data.length);
  buf.set(data);
  const blob = new Blob([buf.buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);

  // Some browsers are unreliable when clicking a detached <a>. Attach it for one tick, click,
  // then clean it up. This is especially important for local dev pages and sandboxed surfaces.
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.position = "fixed";
  a.style.left = "-9999px";
  a.style.top = "-9999px";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

export function pickFile(accept: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) { resolve(null); return; }
      resolve(new Uint8Array(await f.arrayBuffer()));
    };
    input.click();
  });
}

// ---------------------------------------------------------------------------
// High-level battery auto-save manager: debounced flush of SRAM -> IndexedDB.
// ---------------------------------------------------------------------------
export class BatteryAutoSaver {
  private machine: BrowserMachine;
  private key: string;
  private lastHash = 0;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  onFlush: ((bytes: number) => void) | null = null;

  constructor(machine: BrowserMachine) {
    this.machine = machine;
    this.key = machine.saveKey();
  }

  /** Load any persisted battery save at boot. Returns true if one was found. */
  async loadAtBoot(): Promise<boolean> {
    if (!this.machine.hasBattery()) return false;
    const data = await idbGet(this.key);
    if (data && data.length) { this.machine.loadBatterySave(data); return true; }
    return false;
  }

  /** Cheap rolling hash of SRAM so we only write to IndexedDB when it actually changed. */
  private hashSram(): number {
    const ram = this.machine.getBatterySave();
    let h = 2166136261 >>> 0;
    // sample stride keeps this O(1)-ish per frame; full 32KB is fine but stride is plenty
    for (let i = 0; i < ram.length; i += 7) { h ^= ram[i]!; h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  /** Call once per frame; schedules a debounced flush when SRAM changes. */
  tick(): void {
    if (!this.machine.hasBattery()) return;
    const h = this.hashSram();
    if (h === this.lastHash) return;
    this.lastHash = h;
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => this.flush(), 1200); // settle 1.2s after last change
  }

  /** Force an immediate flush (also called on tab hide / beforeunload). */
  async flush(): Promise<void> {
    if (!this.machine.hasBattery()) return;
    const data = this.machine.getBatterySave();
    await idbPut(this.key, data);
    if (this.onFlush) this.onFlush(data.length);
  }
}
