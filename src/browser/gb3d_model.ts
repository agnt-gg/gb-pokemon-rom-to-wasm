/**
 * 3D front-end (GLB-model variant). Boots the SAME recompiled machine as main.ts, loads a
 * downloaded Game Boy GLB (Marcel Neumann, CC-BY 3.0) as the physical prop, auto-fits it, then
 * overlays a live-screen plane (CanvasTexture of the framebuffer) + interactive button meshes
 * positioned on the model's face. Keyboard + clicks drive the joypad; buttons press in.
 *
 * The GLB is a single merged mesh (no separable screen/buttons), so we composite our own
 * interactive layer on top — best of both: a real detailed model + a live, playable screen.
 *
 * THREE + OrbitControls + GLTFLoader are provided as globals via the importmap in the HTML.
 */
import { BrowserMachine } from "./host_browser.ts";
import type { Button } from "../runtime/joypad.ts";
import { BatteryAutoSaver } from "./save.ts";
import { AudioSink } from "./audio.ts";

declare const THREE: any;
declare const OrbitControls: any;
declare const GLTFLoader: any;

const KEYMAP: Record<string, Button> = {
  ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down",
  KeyD: "right", KeyA: "left", KeyW: "up", KeyS: "down",
  KeyZ: "a", KeyX: "b", KeyK: "a", KeyJ: "b",
  Enter: "start", ShiftRight: "select", ShiftLeft: "select", Backspace: "select",
};

const MODEL_URL = "/web/models/gameboy-neumann.glb";

async function boot() {
  const statusEl = document.getElementById("status")!;
  const fpsEl = document.getElementById("fps")!;
  const infoEl = document.getElementById("rominfo")!;

  statusEl.textContent = "fetching recompiled wasm…";
  const [info, wasm, rom] = await Promise.all([
    fetch("/api/rom-info").then((r) => r.json()),
    fetch("/api/wasm").then((r) => r.arrayBuffer()),
    fetch("/api/rom").then((r) => r.arrayBuffer()),
  ]);
  infoEl.innerHTML = `<b>${info.title}</b> · ${info.mbc} · ${info.romSizeKB}KB`;
  const machine = await BrowserMachine.create(new Uint8Array(wasm), new Uint8Array(rom));

  // offscreen framebuffer canvas → live texture
  const gbCanvas = document.createElement("canvas");
  gbCanvas.width = machine.width; gbCanvas.height = machine.height;
  const gbCtx = gbCanvas.getContext("2d")!;
  const img = gbCtx.createImageData(machine.width, machine.height);

  // audio
  const audio = new AudioSink();
  window.addEventListener("pointerdown", () => void audio.ensureStarted(), { once: true });
  window.addEventListener("keydown", () => void audio.ensureStarted(), { once: true });

  // battery saves
  const saver = new BatteryAutoSaver(machine);
  await saver.loadAtBoot();
  document.addEventListener("visibilitychange", () => { if (document.hidden) void saver.flush(); });
  window.addEventListener("beforeunload", () => { void saver.flush(); });

  // ---------------------------------------------------------------- THREE
  const mount = document.getElementById("gl")!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05060a, 0.03);

  const camera = new THREE.PerspectiveCamera(40, mount.clientWidth / mount.clientHeight, 0.1, 100);
  camera.position.set(0, 1.0, 9);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.07;
  controls.minDistance = 5; controls.maxDistance = 18;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.target.set(0, 0.1, 0);

  scene.add(new THREE.AmbientLight(0x4a4e63, 1.2));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
  key.position.set(5, 9, 7); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 40;
  key.shadow.camera.left = -10; key.shadow.camera.right = 10;
  key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const rimPink = new THREE.PointLight(0xe53d8f, 70, 35); rimPink.position.set(-7, 2, -4); scene.add(rimPink);
  const rimCyan = new THREE.PointLight(0x12e0ff, 55, 35); rimCyan.position.set(7, -1, -5); scene.add(rimCyan);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(50, 64),
    new THREE.MeshStandardMaterial({ color: 0x0a0b12, roughness: 0.85, metalness: 0.2 })
  );
  ground.rotation.x = -Math.PI / 2; ground.position.y = -3.4; ground.receiveShadow = true;
  scene.add(ground);

  // ---------------------------------------------------------------- LOAD GLB
  statusEl.textContent = "loading 3D model…";
  const gltf = await new Promise<any>((res, rej) =>
    new GLTFLoader().load(MODEL_URL, res, undefined, rej));
  const model = gltf.scene;
  model.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // auto-fit: center the model and scale so its height ≈ 6 units
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  box.getSize(size); box.getCenter(center);
  const TARGET_H = 6;
  const scale = TARGET_H / size.y;
  // wrapper group so we can scale/center cleanly, then add our interactive layer in MODEL space
  const gb = new THREE.Group();
  model.position.sub(center);          // center at origin
  gb.add(model);
  gb.scale.setScalar(scale);
  scene.add(gb);

  // The model's PRINTED face (screen + buttons) is on the -z side (the bbox is biased to +z,
  // so the decorated front is the -z plane). Place our interactive layer just proud of -z, and
  // rotate the whole console 180° about Y so that decorated face turns toward the camera.
  gb.rotation.y = Math.PI;
  const halfW = size.x / 2, halfH = size.y / 2, faceZ = -(size.z / 2 + 0.004);

  // ---- live screen plane (positioned on the upper-front of the model) ----
  const tex = new THREE.CanvasTexture(gbCanvas);
  tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({ map: tex });
  // screen ~ 62% of width, GB 160:144 aspect, in the upper portion of the face
  const sw = size.x * 0.60, sh = sw * (144 / 160);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), screenMat);
  screen.position.set(0, size.y * 0.20, faceZ);
  gb.add(screen);

  // ---- interactive buttons (overlaid; model's own buttons aren't separable) ----
  const pressables: { mesh: any; btn: Button; rest: number }[] = [];
  const addPressable = (mesh: any, btn: Button) => {
    mesh.userData.btn = btn; pressables.push({ mesh, btn, rest: mesh.position.z }); gb.add(mesh);
  };
  const u = size.x; // unit relative to model width for placement
  const btnDepth = faceZ;

  // D-pad cross (lower-left)
  const dpadMat = new THREE.MeshStandardMaterial({ color: 0x222028, roughness: 0.5 });
  const armV = new THREE.Mesh(new THREE.BoxGeometry(u * 0.06, u * 0.17, u * 0.04), dpadMat);
  const armH = new THREE.Mesh(new THREE.BoxGeometry(u * 0.17, u * 0.06, u * 0.04), dpadMat);
  const dpadOrigin = new THREE.Vector3(-u * 0.26, -size.y * 0.18, btnDepth);
  armV.position.copy(dpadOrigin); armH.position.copy(dpadOrigin);
  armV.castShadow = armH.castShadow = true;
  gb.add(armV); gb.add(armH);
  const mkPad = (dx: number, dy: number, b: Button) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(u * 0.065, u * 0.065, u * 0.05),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }));
    m.position.set(dpadOrigin.x + dx, dpadOrigin.y + dy, dpadOrigin.z); addPressable(m, b);
  };
  mkPad(0, u * 0.065, "up"); mkPad(0, -u * 0.065, "down");
  mkPad(-u * 0.065, 0, "left"); mkPad(u * 0.065, 0, "right");

  // A / B (lower-right, red)
  const btnMat = new THREE.MeshStandardMaterial({ color: 0xd11f48, roughness: 0.4 });
  const mkRound = (x: number, y: number, b: Button) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(u * 0.052, u * 0.052, u * 0.035, 28), btnMat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, btnDepth); m.castShadow = true; addPressable(m, b);
  };
  mkRound(u * 0.16, -size.y * 0.16, "b");
  mkRound(u * 0.30, -size.y * 0.11, "a");

  // Start / Select pills (bottom center)
  const pillMat = new THREE.MeshStandardMaterial({ color: 0x6a6a78, roughness: 0.5 });
  const mkPill = (x: number, b: Button) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(u * 0.017, u * 0.068, 4, 10), pillMat);
    m.rotation.z = Math.PI / 2; m.rotation.x = Math.PI / 2;
    m.position.set(x, -size.y * 0.32, btnDepth); m.castShadow = true; addPressable(m, b);
  };
  mkPill(-u * 0.08, "select"); mkPill(u * 0.08, "start");

  // ---------------------------------------------------------------- INPUT
  const held = new Set<Button>();
  const press = (b: Button, down: boolean) => { machine.setButton(b, down); down ? held.add(b) : held.delete(b); };
  window.addEventListener("keydown", (e) => { const b = KEYMAP[e.code]; if (b) { press(b, true); e.preventDefault(); } });
  window.addEventListener("keyup", (e) => { const b = KEYMAP[e.code]; if (b) { press(b, false); e.preventDefault(); } });

  const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2();
  let activePtr: Button | null = null;
  const pick = (cx: number, cy: number): Button | null => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.x = ((cx - r.left) / r.width) * 2 - 1; pointer.y = -((cy - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pressables.map((p) => p.mesh), false);
    return hits.length ? (hits[0].object.userData.btn as Button) : null;
  };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    const b = pick(e.clientX, e.clientY); if (b) { activePtr = b; press(b, true); controls.enabled = false; }
  });
  const releasePtr = () => { if (activePtr) { press(activePtr, false); activePtr = null; } controls.enabled = true; };
  window.addEventListener("pointerup", releasePtr); window.addEventListener("pointercancel", releasePtr);

  // ---------------------------------------------------------------- LOOP
  statusEl.textContent = "running ▶";
  let fc = 0, acc = 0, last = performance.now();
  function loop(now: number) {
    const dt = now - last; last = now;
    machine.runFrame();
    img.data.set(machine.framebuffer); gbCtx.putImageData(img, 0, 0); tex.needsUpdate = true;
    const a = machine.drainAudio(); if (a.left.length) audio.push(a.left, a.right);

    // round/pill buttons depress along -z
    for (const p of pressables) {
      const t = held.has(p.btn) ? p.rest - u * 0.018 : p.rest;
      p.mesh.position.z += (t - p.mesh.position.z) * 0.4;
    }
    // D-pad ROCKER: pressed edge dips toward the shell, opposite edge lifts. Tilt about the
    // cross center with correct axis signs — no flat spin.
    //   up → rotate X negative · down → X positive · right → Y negative · left → Y positive
    const K = 0.35, sinkAmt = u * 0.008, ANG = 0.12;
    let rx = 0, ry = 0, sink = 0;
    if (held.has("up"))    { rx = -ANG; sink = sinkAmt; }
    if (held.has("down"))  { rx =  ANG; sink = sinkAmt; }
    if (held.has("left"))  { ry = -ANG; sink = sinkAmt; }
    if (held.has("right")) { ry =  ANG; sink = sinkAmt; }
    for (const cross of [armV, armH]) {
      cross.rotation.x += (rx - cross.rotation.x) * K;
      cross.rotation.y += (ry - cross.rotation.y) * K;
      cross.rotation.z += (0 - cross.rotation.z) * K; // never roll
      const tz = dpadOrigin.z - sink; cross.position.z += (tz - cross.position.z) * K;
    }

    fc++; acc += dt; if (fc % 20 === 0) { fpsEl.textContent = (1000 / (acc / 20)).toFixed(0) + " fps"; acc = 0; }
    saver.tick(); controls.update(); renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---- HUD buttons ----
  const soundBtn = document.getElementById("btn-sound") as HTMLButtonElement | null;
  soundBtn?.addEventListener("click", async () => {
    if (!audio.isStarted) { await audio.ensureStarted(); soundBtn.textContent = "🔊 Sound on"; return; }
    const m = audio.toggleMute(); soundBtn.textContent = m ? "🔇 Sound off" : "🔊 Sound on";
  });
  const rotBtn = document.getElementById("btn-rotate") as HTMLButtonElement | null;
  rotBtn?.addEventListener("click", () => {
    controls.autoRotate = !controls.autoRotate; controls.autoRotateSpeed = 1.2;
    rotBtn.textContent = controls.autoRotate ? "⏸ Stop spin" : "↻ Auto-spin";
  });
  document.getElementById("btn-reset")?.addEventListener("click", () => {
    camera.position.set(0, 1.0, 9); controls.target.set(0, 0.1, 0);
  });

  window.addEventListener("resize", () => {
    camera.aspect = mount.clientWidth / mount.clientHeight; camera.updateProjectionMatrix();
    renderer.setSize(mount.clientWidth, mount.clientHeight);
  });
}

boot().catch((e) => {
  document.getElementById("status")!.textContent = "error: " + (e as Error).message;
  console.error(e);
});
