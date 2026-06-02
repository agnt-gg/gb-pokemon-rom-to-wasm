/**
 * The fidelity board: runs every phase oracle and prints a single green/red summary.
 *   node --experimental-strip-types tests/board.ts
 */
import { spawnSync } from "node:child_process";

const phases = [
  ["Phase 1 — Decoder (512 opcodes)", "tests/decoder.test.ts"],
  ["Phase 2 — ALU / flags", "tests/alu.test.ts"],
  ["Phase 3 — CPU + MMU / MBC3", "tests/cpu.test.ts"],
  ["Phase 4 — Recompiler differential", "tests/recomp.test.ts"],
  ["Phase 8 — Real ROM boot", "tests/boot.test.ts"],
];

let allGreen = true;
const rows: string[] = [];
for (const [name, file] of phases) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", file!], {
    encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const passMatch = out.match(/PASS:\s*(\d+)/);
  const failMatch = out.match(/FAIL:\s*(\d+)/);
  const skipped = out.includes("(skip)");
  const pass = passMatch ? parseInt(passMatch[1]!, 10) : 0;
  const fail = failMatch ? parseInt(failMatch[1]!, 10) : 0;
  const green = (r.status === 0) && fail === 0;
  if (!green && !skipped) allGreen = false;
  const status = skipped ? "SKIP" : green ? "PASS" : "FAIL";
  rows.push(`  [${status}]  ${name!.padEnd(38)}  ${pass} assertions${fail ? `, ${fail} FAIL` : ""}`);
}

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║                 GB-RECOMP  ·  FIDELITY BOARD                   ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
for (const row of rows) console.log(row);
console.log("  ────────────────────────────────────────────────────────────");
console.log(allGreen ? "  ✓ ALL GREEN — SM83 assembly → WebAssembly, verified end-to-end" : "  ✗ board has failures");
console.log("");
process.exit(allGreen ? 0 : 1);
