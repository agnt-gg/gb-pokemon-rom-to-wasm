/**
 * 3D front-end. Boots the SAME recompiled machine as main.ts, but instead of blitting the
 * framebuffer to a 2D <canvas>, it draws into an offscreen canvas that is used as a live
 * THREE.CanvasTexture on a fully-modeled 3D Game Boy. Keyboard + 3D on-model buttons both
 * drive the joypad; audio + battery saves + save-states are wired identically.
 *
 * Three.js is loaded from a CDN importmap in gb3d.html (THREE + OrbitControls).
 */
import { BrowserMachine } from "./host_browser.ts";
import type { Button } from "../runtime/joypad.ts";
import {
  BatteryAutoSaver, writeSaveState, readSaveState, listSaveStates,
  writeAutoCheckpoint, readAutoCheckpoint,
  downloadBytes, pickFile,
} from "./save.ts";
import { AudioSink } from "./audio.ts";

// THREE is provided as a global via the importmap module in the HTML (window.__THREE).
declare const THREE: any;
declare const OrbitControls: any;
declare const RoundedBoxGeometry: any;

const NUM_STATE_SLOTS = 3;

const KEYMAP: Record<string, Button> = {
  ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down",
  KeyD: "right", KeyA: "left", KeyW: "up", KeyS: "down",
  KeyZ: "a", KeyX: "b", KeyK: "a", KeyJ: "b",
  Enter: "start", ShiftRight: "select", ShiftLeft: "select", Backspace: "select",
};

// ---- THEME PALETTES (mirror the 2D page's 5 themes) ----
interface GBTheme {
  shell: number; shellDark: number; accent: number;
  btn: number; btnDark: number; bezel: number; screenTint: number;
  fog: number; rim1: number; rim2: number;
}
const THEMES: Record<string, GBTheme> = {
  midnight:  { shell: 0xc9c5bd, shellDark: 0x9a968d, accent: 0x8b1a4f, btn: 0x9c2152, btnDark: 0x2a2730, bezel: 0x1d1b22, screenTint: 0x8faa2b, fog: 0x05060a, rim1: 0xe53d8f, rim2: 0x12e0ff },
  pikachu:   { shell: 0xffd500, shellDark: 0xd9b400, accent: 0x1f3b8f, btn: 0x3b6dff, btnDark: 0x14224a, bezel: 0x0a142e, screenTint: 0xcfe34a, fog: 0x060b20, rim1: 0xffd500, rim2: 0x3b6dff },
  atomic:    { shell: 0x8a3df0, shellDark: 0x6320b8, accent: 0xff5cc8, btn: 0xc061ff, btnDark: 0x2a103c, bezel: 0x180a2e, screenTint: 0xb8e0c0, fog: 0x0a0418, rim1: 0xc061ff, rim2: 0xff5cc8 },
  grass:     { shell: 0x8b9d3a, shellDark: 0x6b7a2a, accent: 0x3a4416, btn: 0x4a5520, btnDark: 0x222a14, bezel: 0x0a0d06, screenTint: 0x9bbc0f, fog: 0x0d1109, rim1: 0x9bbc0f, rim2: 0xcfe34a },
  fire:      { shell: 0x2a1a12, shellDark: 0x1a0f08, accent: 0xff7a18, btn: 0xff7a18, btnDark: 0x140804, bezel: 0x0e0503, screenTint: 0xe0c14a, fog: 0x0e0503, rim1: 0xff7a18, rim2: 0xffd23b },
  water:     { shell: 0x2aa8ff, shellDark: 0x0d5fa8, accent: 0xb7f4ff, btn: 0x1b7dff, btnDark: 0x06254a, bezel: 0x06172b, screenTint: 0xb6e9ff, fog: 0x020814, rim1: 0x5dcfff, rim2: 0x1b7dff },
};
// active palette (mutated by applyTheme); start with persisted choice or midnight
const normalizeTheme = (t: string | null) => t === "dmg" ? "grass" : (t === "charizard" ? "fire" : (t || "midnight"));
let PAL: GBTheme = THEMES[normalizeTheme(localStorage.getItem("gb-theme"))] || THEMES.midnight;
const SHELL = PAL.shell, SHELL_DARK = PAL.shellDark, ACCENT = PAL.accent;
const BTN_RED = PAL.btn, BTN_DARK = PAL.btnDark, BEZEL = PAL.bezel, SCREEN_GREEN = PAL.screenTint;

async function boot() {
  const statusEl = document.getElementById("status")!;
  const fpsEl = document.getElementById("fps")!;
  const infoEl = document.getElementById("rominfo")!;

  // ---- fetch + build the machine (identical to main.ts) ----
  statusEl.textContent = "fetching recompiled wasm…";
  const [info, wasm, rom] = await Promise.all([
    fetch("/api/rom-info").then((r) => r.json()),
    fetch("/api/wasm").then((r) => r.arrayBuffer()),
    fetch("/api/rom").then((r) => r.arrayBuffer()),
  ]);
  infoEl.innerHTML = `<b>${info.title}</b> · ${info.mbc} · ${info.romSizeKB}KB`;
  const machine = await BrowserMachine.create(new Uint8Array(wasm), new Uint8Array(rom));

  // ---- offscreen 2D canvas → becomes the GB screen texture ----
  const gbCanvas = document.createElement("canvas");
  gbCanvas.width = machine.width; gbCanvas.height = machine.height;
  const gbCtx = gbCanvas.getContext("2d")!;
  const img = gbCtx.createImageData(machine.width, machine.height);

  // ---- audio ----
  const audio = new AudioSink();
  const startAudio = () => { void audio.ensureStarted(); };
  window.addEventListener("pointerdown", startAudio, { once: true });
  window.addEventListener("keydown", startAudio, { once: true });

  // ---- battery autosave ----
  const saver = new BatteryAutoSaver(machine);
  const hadSave = await saver.loadAtBoot();

  // ---- Settings / Saves drawer (3D HUD) ----
  const toastEl = document.getElementById("savetoast");
  const battEl = document.getElementById("battstatus");
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const toast = (msg: string) => {
    if (!toastEl) return;
    toastEl.textContent = msg; toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  };
  if (battEl) battEl.textContent = machine.hasBattery()
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
    if (battEl) battEl.textContent = "saved ✓ (" + (bytes / 1024).toFixed(0) + "KB)";
    // Protected auto-checkpoint for in-game SAVE persistence. Never overwrites slots 1/2/3.
    writeAuto();
  };

  const refreshSlots = () => {
    const have = new Set(listSaveStates(machine.saveKey(), NUM_STATE_SLOTS).map((s) => s.slot));
    document.querySelectorAll<HTMLButtonElement>("[data-state-load]").forEach((el) => {
      el.disabled = !have.has(Number(el.dataset.stateLoad));
    });
  };
  refreshSlots();

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
    try { writeSaveState(machine.saveKey(), slot, machine.snapshot()); refreshSlots(); toast("State saved to slot " + (slot + 1)); }
    catch { toast("⚠ slot " + (slot + 1) + " save failed"); }
  };
  const doSaveState = (slot: number) => {
    const occupied = !!readSaveState(machine.saveKey(), slot);
    if (!occupied) { clearPending(); writeSlot(slot); return; }
    if (pendingOverwrite.slot === slot) { clearPending(); writeSlot(slot); return; }
    clearPending(); pendingOverwrite.slot = slot;
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

  document.getElementById("btn-save-now")?.addEventListener("click", async () => {
    await saver.flush(); toast("Battery saved to this browser");
  });
  document.getElementById("btn-export-sav")?.addEventListener("click", () => {
    const name = (machine.saveKey().split(":")[1] || "game") + ".sav";
    downloadBytes(name, machine.getBatterySave()); toast("Exported " + name);
  });
  document.getElementById("btn-import-sav")?.addEventListener("click", async () => {
    const data = await pickFile(".sav,application/octet-stream");
    if (!data) return;
    machine.loadBatterySave(data); await saver.flush(); toast("Imported .sav");
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

  const STATE_KEYS: Record<string, () => void> = {
    F5: () => doSaveState(0), F6: () => doSaveState(1), F7: () => doSaveState(2),
    F8: () => doLoadState(0), F9: () => doLoadState(1), F10: () => doLoadState(2),
    KeyM: () => { const muted = audio.toggleMute(); const sb = document.getElementById("btn-sound"); if (sb && audio.isStarted) sb.textContent = muted ? "🔇 Sound off" : "🔊 Sound on"; toast(muted ? "Muted" : "Unmuted"); },
  };

  document.addEventListener("visibilitychange", () => { if (document.hidden) void saver.flush(); });
  window.addEventListener("beforeunload", () => { void saver.flush(); });

  // ===========================================================================
  // THREE.JS SCENE
  // ===========================================================================
  const mount = document.getElementById("gl")!;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  // Keep the 3D shell responsive: high-DPI + antialiasing can cut rAF below 60Hz and make
  // gameplay feel slow even when emulation is fast. 1.25 is a good quality/perf compromise.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = false;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(PAL.fog, 0.035);

  const camera = new THREE.PerspectiveCamera(38, mount.clientWidth / mount.clientHeight, 0.1, 100);
  camera.position.set(0, 1.2, 9);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 5.5;
  controls.maxDistance = 16;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.target.set(0, 0.2, 0);
  controls.autoRotate = false;

  // ---- lighting ----
  scene.add(new THREE.AmbientLight(0x44485e, 1.1));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
  key.position.set(5, 9, 6); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 30;
  key.shadow.camera.left = -8; key.shadow.camera.right = 8;
  key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const rimPink = new THREE.PointLight(PAL.rim1, 60, 30); rimPink.position.set(-6, 2, -4); scene.add(rimPink);
  const rimCyan = new THREE.PointLight(PAL.rim2, 50, 30); rimCyan.position.set(6, -1, -5); scene.add(rimCyan);

  // ---- ground (reflection-ish dark plane) ----
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 64),
    new THREE.MeshStandardMaterial({ color: 0x0a0b12, roughness: 0.85, metalness: 0.2 })
  );
  ground.rotation.x = -Math.PI / 2; ground.position.y = -3.2; ground.receiveShadow = true;
  scene.add(ground);

  // ===========================================================================
  // GAME BOY MODEL  (group, scaled to ~5.5 tall)
  // ===========================================================================
  const gb = new THREE.Group();
  scene.add(gb);

  // Rounded box if the addon global is present, else a plain box (visually fine).
  const rounded = (w: number, h: number, d: number, r: number): any =>
    (typeof RoundedBoxGeometry !== "undefined")
      ? new RoundedBoxGeometry(w, h, d, 4, r)
      : new THREE.BoxGeometry(w, h, d);

  const matte = (color: number, rough = 0.72, metal = 0.05) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

  // body
  // Body: an extruded rounded rectangle. Bottom-right has a LARGER RADIUS (the classic DMG
  // signature rounded corner — a soft sweep, not an angled cut). Built as a THREE.Shape.
  const bw = 4.3, bh = 6.6, bd = 0.95, br = 0.32, bigR = 1.05;
  const hw = bw / 2, hh = bh / 2;
  const shape = new THREE.Shape();
  // clockwise around the outline
  shape.moveTo(-hw + br, -hh);                          // bottom edge start (after bottom-left round)
  shape.lineTo(hw - bigR, -hh);                          // along the bottom toward the big-radius corner
  shape.quadraticCurveTo(hw, -hh, hw, -hh + bigR);      // soft bottom-right RADIUS (DMG signature)
  shape.lineTo(hw, hh - br);                             // right edge up
  shape.quadraticCurveTo(hw, hh, hw - br, hh);          // top-right round
  shape.lineTo(-hw + br, hh);                            // top edge
  shape.quadraticCurveTo(-hw, hh, -hw, hh - br);        // top-left round
  shape.lineTo(-hw, -hh + br);                           // left edge down
  shape.quadraticCurveTo(-hw, -hh, -hw + br, -hh);      // bottom-left round
  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: bd, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 3, curveSegments: 12 }),
    matte(SHELL)
  );
  body.position.z = -bd / 2; // center the extrusion depth on z=0 like the old box
  body.castShadow = true; body.receiveShadow = true; gb.add(body);

  // ---------------------------------------------------------------------------
  // INTERNALS — visible through translucent shell themes
  // ---------------------------------------------------------------------------
  // A stylized PCB + chips + copper traces + twin battery cells, tucked inside the shell.
  // Opaque themes hide this naturally; translucent themes reveal the hardware layer.
  const internals = new THREE.Group();
  // Show the internals through the BACK shell: move them rearward and flip the assembly 180°
  // so the chip/traces side faces outward through the transparent back plastic.
  internals.position.set(0.08, 0.66, -0.16);
  internals.rotation.y = Math.PI;
  internals.scale.set(1.22, 1.18, 1);
  gb.add(internals);

  const pcbMat = new THREE.MeshStandardMaterial({ color: 0x164f37, roughness: 0.52, metalness: 0.08 });
  const pcbEdgeMat = new THREE.MeshStandardMaterial({ color: 0x0b2c1f, roughness: 0.6, metalness: 0.05 });
  const copperMat = new THREE.MeshStandardMaterial({ color: 0xd69b45, roughness: 0.32, metalness: 0.45, emissive: 0x2a1200, emissiveIntensity: 0.05 });
  const chipMat = new THREE.MeshStandardMaterial({ color: 0x11131a, roughness: 0.42, metalness: 0.18 });
  const chipTopMat = new THREE.MeshStandardMaterial({ color: 0x242735, roughness: 0.36, metalness: 0.2 });
  const solderMat = new THREE.MeshStandardMaterial({ color: 0xc8d2d8, roughness: 0.28, metalness: 0.8 });
  const battBodyMat = new THREE.MeshStandardMaterial({ color: 0x252832, roughness: 0.38, metalness: 0.22 });
  const battTipMat = new THREE.MeshStandardMaterial({ color: 0xd7d1bd, roughness: 0.25, metalness: 0.65 });

  // main PCB board
  // Thicker board core so the green PCB substrate physically reaches the copper traces on both
  // faces (top traces at z≈+0.135, front/back traces at z≈-0.135). This removes the floating-wire look.
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(3.25, 4.55, 0.26), pcbMat);
  pcb.position.set(0.05, -0.45, 0);
  pcb.castShadow = true; pcb.receiveShadow = true;
  internals.add(pcb);

  // darker lower daughter-board / battery-controller strip
  const lowerBoard = new THREE.Mesh(new THREE.BoxGeometry(2.75, 0.82, 0.20), pcbEdgeMat);
  lowerBoard.position.set(0.05, -2.25, 0.018);
  internals.add(lowerBoard);

  // IC helper
  const addChip = (x: number, y: number, w: number, h: number, labelHint = false) => {
    const chip = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), chipMat);
    chip.position.set(x, y, 0.09); chip.castShadow = true;
    internals.add(chip);
    const top = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, h * 0.70, 0.025), chipTopMat);
    top.position.set(x, y, 0.165); internals.add(top);
    // tiny solder legs down both long sides
    const legCount = Math.max(4, Math.floor(h / 0.13));
    for (let i = 0; i < legCount; i++) {
      const yy = y - h * 0.42 + (i / (legCount - 1)) * h * 0.84;
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.018), solderMat);
        leg.position.set(x + sx * (w * 0.58), yy, 0.15);
        internals.add(leg);
      }
    }
    if (labelHint) {
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12), copperMat);
      dot.position.set(x - w * 0.32, y + h * 0.27, 0.18);
      internals.add(dot);
    }
  };
  addChip(-0.55, 0.15, 0.72, 0.92, true);   // CPU-ish
  addChip(0.62, 0.38, 0.58, 0.62);          // VRAM-ish
  addChip(0.38, -0.70, 0.70, 0.50);         // MBC/cart interface-ish
  addChip(-0.62, -1.08, 0.50, 0.44);        // audio amp-ish

  // Copper trace helper — thin raised rectangles on the PCB
  const addTrace = (x: number, y: number, w: number, h: number, z = 0.135) => {
    const t = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.014), copperMat);
    t.position.set(x, y, z);
    internals.add(t);
  };
  // horizontal/vertical routing paths, intentionally circuit-board-ish
  addTrace(-0.05, 0.92, 1.85, 0.025); addTrace(-0.98, 0.35, 0.025, 1.12);
  addTrace(0.10, -0.05, 1.55, 0.025); addTrace(1.02, -0.46, 0.025, 1.15);
  addTrace(-0.05, -1.55, 1.95, 0.025); addTrace(-1.02, -1.02, 0.025, 1.06);
  addTrace(0.72, 0.76, 0.025, 0.64); addTrace(0.42, -1.38, 0.025, 0.74);
  // Front-side circuit layer too: a second, subtler network of traces on the opposite face
  // of the PCB so the board reads as populated from both front and back.
  addTrace(-0.62, 1.35, 1.35, 0.022, -0.135); addTrace(-1.18, 0.75, 0.022, 1.10, -0.135);
  addTrace(0.72, 1.22, 0.022, 0.88, -0.135); addTrace(0.22, 0.22, 1.72, 0.022, -0.135);
  addTrace(-0.72, -0.42, 0.022, 1.08, -0.135); addTrace(0.52, -1.18, 1.30, 0.022, -0.135);
  addTrace(1.18, -1.55, 0.022, 0.78, -0.135); addTrace(-0.18, -1.92, 1.78, 0.022, -0.135);

  // little vias / solder pads on both PCB faces
  for (const [x, y] of [[-1.12, .92],[-.62,.92],[.48,.92],[1.02,.12],[1.02,-.9],[-1.02,-1.55],[-.38,-1.55],[.82,-1.55]]) {
    const via = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.016, 16), copperMat);
    via.rotation.x = Math.PI / 2; via.position.set(x, y, 0.155);
    internals.add(via);
  }
  for (const [x, y] of [[-1.18,1.35],[-0.28,1.35],[0.72,1.22],[1.18,-1.55],[-0.72,-0.42],[0.52,-1.18],[-0.18,-1.92]]) {
    const via = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.014, 16), copperMat);
    via.rotation.x = Math.PI / 2; via.position.set(x, y, -0.155);
    internals.add(via);
  }

  // Battery compartment: two AA-style cells visible low in the shell
  const addBattery = (x: number, y: number) => {
    const cell = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 2.15, 28), battBodyMat);
    cell.rotation.z = Math.PI / 2;
    cell.position.set(x, y, 0.20);
    cell.castShadow = true;
    internals.add(cell);
    for (const sx of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.055, 28), battTipMat);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(x + sx * 1.09, y, 0.20);
      internals.add(cap);
    }
    // subtle colored label band
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.40, 0.022), new THREE.MeshStandardMaterial({ color: 0x12e0ff, roughness: 0.45, metalness: 0.08, transparent: true, opacity: 0.75 }));
    band.position.set(x, y, 0.365);
    internals.add(band);
  };
  addBattery(0.10, -2.58);
  addBattery(0.10, -2.93);


  // subtle front recess (screen well)
  const well = new THREE.Mesh(rounded(3.4, 3.0, 0.2, 0.18), matte(SHELL_DARK, 0.6));
  well.position.set(0, 1.55, 0.5); gb.add(well);

  // bezel (dark)
  const bezel = new THREE.Mesh(rounded(2.9, 2.5, 0.16, 0.1), matte(BEZEL, 0.5, 0.1));
  bezel.position.set(0, 1.6, 0.6); bezel.castShadow = true; gb.add(bezel);

  // accent stripe under screen
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.07, 0.02), matte(ACCENT, 0.5));
  stripe.position.set(0, 0.28, 0.62); gb.add(stripe);

  // "DOT MATRIX WITH STEREO SOUND" line + brand
  // (kept as geometry-free; texture label below the screen)

  // ---- live screen (CanvasTexture) ----
  const tex = new THREE.CanvasTexture(gbCanvas);
  tex.magFilter = THREE.NearestFilter; // crisp pixels
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({ map: tex });
  // GB aspect 160:144 → keep ratio inside the bezel
  const sw = 2.4, sh = sw * (144 / 160);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), screenMat);
  screen.position.set(0, 1.66, 0.69); gb.add(screen);
  // faint glass glow
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(sw + 0.1, sh + 0.1),
    new THREE.MeshBasicMaterial({ color: SCREEN_GREEN, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending })
  );
  glass.position.set(0, 1.66, 0.71); gb.add(glass);

  // ===========================================================================
  // BUTTONS — each is a clickable mesh that calls setButton(name, down)
  // ===========================================================================
  const pressables: { mesh: any; btn: Button; rest: number }[] = [];
  function addPressable(mesh: any, btn: Button) {
    mesh.userData.btn = btn;
    pressables.push({ mesh, btn, rest: mesh.position.z });
    gb.add(mesh);
  }

  // D-Pad (cross of two rounded bars)
  const dpadMat = matte(BTN_DARK, 0.55);
  const dpadV = new THREE.Mesh(new THREE.BoxGeometry(0.40, 1.10, 0.24), dpadMat);
  const dpadH = new THREE.Mesh(new THREE.BoxGeometry(1.10, 0.40, 0.24), dpadMat);
  const dpadOrigin = new THREE.Vector3(-1.25, -1.15, 0.6);
  // up/down/left/right as 4 invisible hit pads over the cross arms
  const mkPad = (dx: number, dy: number, w: number, h: number, b: Button) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.3),
      new THREE.MeshStandardMaterial({ color: BTN_DARK, roughness: 0.55, transparent: true, opacity: 0 }));
    m.position.set(dpadOrigin.x + dx, dpadOrigin.y + dy, dpadOrigin.z + 0.02);
    addPressable(m, b);
  };
  dpadV.position.copy(dpadOrigin); dpadH.position.copy(dpadOrigin);
  dpadV.castShadow = dpadH.castShadow = true;
  gb.add(dpadV); gb.add(dpadH);
  mkPad(0, 0.45, 0.45, 0.45, "up");
  mkPad(0, -0.45, 0.45, 0.45, "down");
  mkPad(-0.45, 0, 0.45, 0.45, "left");
  mkPad(0.45, 0, 0.45, 0.45, "right");

  // A / B (red circular)
  const btnMat = matte(BTN_RED, 0.45, 0.05);
  const mkRound = (x: number, y: number, b: Button) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.24, 32), btnMat);
    m.rotation.x = Math.PI / 2; m.position.set(x, y, 0.62); m.castShadow = true;
    addPressable(m, b);
  };
  mkRound(0.7, -0.85, "b");
  mkRound(1.5, -0.55, "a");

  // Start / Select (small slanted pills)
  const pillMat = matte(SHELL_DARK, 0.5);
  const mkPill = (x: number, b: Button) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.39, 4, 12), pillMat);
    m.rotation.z = Math.PI / 2; m.rotation.x = Math.PI / 2;
    m.position.set(x, -2.1, 0.6); m.castShadow = true;
    addPressable(m, b);
  };
  mkPill(-0.45, "select");
  mkPill(0.55, "start");

  // tilt the whole console slightly toward viewer
  gb.rotation.x = -0.06;

  // ---- THEME APPLICATION ----
  // Recolor every theme-driven material + light. Exposed globally so the HTML dial can call it.
  const setCol = (mat: any, hex: number) => { if (mat?.color) mat.color.setHex(hex); };
  function applyTheme(name: string) {
    name = normalizeTheme(name);
    const t = THEMES[name]; if (!t) return;
    PAL = t;
    setCol(body.material, t.shell);
    setCol(well.material, t.shellDark);
    // Translucent shell variants. Atomic Purple gets the iconic see-through shell; Classic DMG
    // and Charizard Ember get subtler smoked-plastic treatments so their palettes still read.
    const shellOpacity: Record<string, { body: number; well: number }> = {
      atomic: { body: 0.42, well: 0.32 },
      grass: { body: 0.68, well: 0.52 },
      fire: { body: 0.58, well: 0.42 },
      water: { body: 0.46, well: 0.34 },
    };
    const glassy = shellOpacity[name];
    body.material.transparent = !!glassy;
    body.material.opacity = glassy ? glassy.body : 1;
    body.material.depthWrite = !glassy;
    well.material.transparent = !!glassy;
    well.material.opacity = glassy ? glassy.well : 1;
    well.material.depthWrite = !glassy;
    setCol(bezel.material, t.bezel);
    setCol(stripe.material, t.accent);
    setCol(dpadMat, t.btnDark);
    setCol(btnMat, t.btn);
    setCol(pillMat, t.shellDark);
    setCol(glass.material, t.screenTint);
    rimPink.color.setHex(t.rim1);
    rimCyan.color.setHex(t.rim2);
    if (scene.fog) (scene.fog as any).color.setHex(t.fog);
    localStorage.setItem("gb-theme", name);
  }
  (window as any).__gbApplyTheme = applyTheme;
  applyTheme(localStorage.getItem("gb-theme") || "midnight");

  // ===========================================================================
  // INPUT — keyboard + raycast pointer on 3D buttons
  // ===========================================================================
  const held = new Set<Button>();
  const press = (b: Button, down: boolean) => {
    machine.setButton(b, down);
    if (down) held.add(b); else held.delete(b);
  };
  window.addEventListener("keydown", (e) => {
    const stateAction = STATE_KEYS[e.code];
    if (stateAction) { stateAction(); e.preventDefault(); return; }
    const b = KEYMAP[e.code]; if (b) { press(b, true); e.preventDefault(); }
  });
  window.addEventListener("keyup", (e) => {
    const b = KEYMAP[e.code]; if (b) { press(b, false); e.preventDefault(); }
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let activePtrBtn: Button | null = null;
  const pickButton = (clientX: number, clientY: number): Button | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pressables.map((p) => p.mesh), false);
    return hits.length ? (hits[0].object.userData.btn as Button) : null;
  };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    const b = pickButton(e.clientX, e.clientY);
    if (b) { activePtrBtn = b; press(b, true); controls.enabled = false; }
  });
  const releasePtr = () => { if (activePtrBtn) { press(activePtrBtn, false); activePtrBtn = null; } controls.enabled = true; };
  window.addEventListener("pointerup", releasePtr);
  window.addEventListener("pointercancel", releasePtr);

  // ===========================================================================
  // RUN LOOP
  // ===========================================================================
  statusEl.textContent = "running ▶";
  let frameCount = 0, fpsAccum = 0, last = performance.now();

  function renderGbToCanvas() {
    img.data.set(machine.framebuffer);
    gbCtx.putImageData(img, 0, 0);
    tex.needsUpdate = true;
  }

  let emuAccum = 0;
  // WASM-block mode can feel slightly more sluggish than the pure interpreter because control
  // returns at block/banked-fallback boundaries. Keep CPU semantics intact and calibrate pacing
  // perceptually at the frontend layer.
  const EMU_SPEED = 1.12;
  const EMU_FRAME_MS = 1000 / (59.7275 * EMU_SPEED);
  const MAX_CATCHUP_FRAMES = 5;

  function loop(now: number) {
    const dt = Math.min(100, now - last); last = now;
    emuAccum += dt;
    let ran = 0;
    // Real-time pacing: Three.js can render below 60 FPS on some machines. Run catch-up
    // emulation frames, then render the latest framebuffer once so gameplay speed remains normal.
    while (emuAccum >= EMU_FRAME_MS && ran < MAX_CATCHUP_FRAMES) {
      machine.runFrame();
      emuAccum -= EMU_FRAME_MS;
      ran++;
    }
    if (ran === MAX_CATCHUP_FRAMES && emuAccum >= EMU_FRAME_MS) emuAccum = 0;
    if (ran > 0) renderGbToCanvas();
    const a = machine.drainAudio();
    if (a.left.length) audio.push(a.left, a.right);

    // animate held buttons: depress along -z (round A/B + start/select pills)
    for (const p of pressables) {
      const target = held.has(p.btn) ? p.rest - 0.075 : p.rest;
      p.mesh.position.z += (target - p.mesh.position.z) * 0.4;
    }

    // animate the visible D-pad cross as a proper ROCKER: the pressed edge dips toward the
    // shell (-z) while the opposite edge lifts. Implemented as a tilt about the cross CENTER
    // with correct axis signs — no flat spin.
    //   up    → +y edge dips in  → rotate about X by NEGATIVE angle
    //   down  → -y edge dips in  → rotate about X by POSITIVE angle
    //   right → +x edge dips in  → rotate about Y by NEGATIVE angle  (tilts an end in, not a spin)
    //   left  → -x edge dips in  → rotate about Y by POSITIVE angle
    const ANG = 0.12, SINK = 0.018, K = 0.35;
    let rx = 0, ry = 0, sink = 0;
    if (held.has("up"))    { rx = -ANG; sink = SINK; }
    if (held.has("down"))  { rx =  ANG; sink = SINK; }
    if (held.has("left"))  { ry = -ANG; sink = SINK; }
    if (held.has("right")) { ry =  ANG; sink = SINK; }
    for (const cross of [dpadV, dpadH]) {
      cross.rotation.x += (rx - cross.rotation.x) * K;
      cross.rotation.y += (ry - cross.rotation.y) * K;
      cross.rotation.z += (0 - cross.rotation.z) * K; // never roll (that looked like spinning)
      const tz = dpadOrigin.z - sink;
      cross.position.z += (tz - cross.position.z) * K;
    }

    frameCount++; fpsAccum += dt;
    if (frameCount % 20 === 0) {
      fpsEl.textContent = (1000 / (fpsAccum / 20)).toFixed(0) + " fps · " + Math.max(1, ran) + "x emu · " + EMU_SPEED.toFixed(2) + "x speed";
      fpsAccum = 0;
    }
    saver.tick();
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---- UI buttons (sound / autorotate / reset view) ----
  const soundBtn = document.getElementById("btn-sound") as HTMLButtonElement | null;
  soundBtn?.addEventListener("click", async () => {
    if (!audio.isStarted) { await audio.ensureStarted(); soundBtn.textContent = "🔊 Sound on"; return; }
    const muted = audio.toggleMute(); soundBtn.textContent = muted ? "🔇 Sound off" : "🔊 Sound on";
  });
  const rotBtn = document.getElementById("btn-rotate") as HTMLButtonElement | null;
  rotBtn?.addEventListener("click", () => {
    controls.autoRotate = !controls.autoRotate; controls.autoRotateSpeed = 1.2;
    rotBtn.textContent = controls.autoRotate ? "⏸ Stop spin" : "↻ Auto-spin";
  });
  document.getElementById("btn-reset")?.addEventListener("click", () => {
    camera.position.set(0, 1.2, 9); controls.target.set(0, 0.2, 0);
  });

  window.addEventListener("resize", () => {
    camera.aspect = mount.clientWidth / mount.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
  });
}

boot().catch((e) => {
  document.getElementById("status")!.textContent = "error: " + (e as Error).message;
  console.error(e);
});
