#!/usr/bin/env node
// Run the real suite unattended in headless Chrome and write a report.
//
// This is the plain-browser leg of the three-surface comparison, and the
// baseline a CI job would diff against. Gesture probes cannot run here —
// transient user activation cannot be synthesised — so this is the unattended
// half by construction, which is the half worth automating.
//
// The page POSTs its own report to a dev-server sink rather than being scraped.
// Chrome's --virtual-time-budget stalls indefinitely while a fetch is pending,
// and this suite makes network calls on purpose, so scraping the DOM after a
// virtual-time budget cannot work here.
//
// Usage:
//   node tools/run-headless.mjs [out.json] [--tier 1] [--timeout 300] [--optin slow,crash-risk]

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

const outPath = resolve(args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? "sonde-plain-browser.report.json");
const tier = flag("--tier", "1");
const timeoutS = Number(flag("--timeout", "300"));

const CHROME = process.env.CHROME ?? "google-chrome";
const PORT = process.env.PORT ?? "5179";
const optin = flag("--optin", "");
const URL = `http://localhost:${PORT}/?autorun=1&tier=${tier}&optin=${encodeURIComponent(optin)}&post=${encodeURIComponent(outPath)}`;

// A stale file would be mistaken for this run's output.
if (existsSync(outPath)) rmSync(outPath);

const vite = spawn("npx", ["vite", "--port", PORT, "--strictPort", "--host", "127.0.0.1"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOut = "";
vite.stdout.on("data", (d) => (viteOut += d));
vite.stderr.on("data", (d) => (viteOut += d));

let chrome = null;
const stop = () => {
  for (const p of [chrome, vite]) {
    try {
      p?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
};
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (/Local:\s+http/.test(viteOut)) {
    ready = true;
    break;
  }
  if (vite.exitCode !== null) break;
}
if (!ready) {
  console.error("vite did not start:\n" + viteOut);
  stop();
  process.exit(2);
}

console.error(`running the suite at tier ${tier}; up to ${timeoutS}s…`);

chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    URL,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d));

// The file appearing is the completion signal.
let landed = false;
for (let i = 0; i < timeoutS; i++) {
  await sleep(1000);
  if (existsSync(outPath)) {
    landed = true;
    break;
  }
  if (chrome.exitCode !== null) {
    console.error(`chrome exited early (${chrome.exitCode}):\n${chromeErr.slice(-2000)}`);
    break;
  }
  if (i % 30 === 29) console.error(`  …${i + 1}s`);
}

stop();

if (!landed) {
  console.error(`\nno report after ${timeoutS}s. Chrome stderr:\n${chromeErr.slice(-2000)}`);
  process.exit(2);
}

const report = JSON.parse(readFileSync(outPath, "utf8"));
const t = report.totals;

console.log(`\nwrote ${outPath}`);
console.log(`  surface : ${report.fingerprint.surface.surface}`);
console.log(`  chromium: ${report.fingerprint.browser.chromium}`);
console.log(`  probes  : ${report.results.length}`);
console.log(
  `  totals  : ${t.pass} pass · ${t.fail} fail · ${t.timeout} timeout · ${t.crashed} crashed · ` +
    `${t.blocked} blocked · ${t.unsupported} unsupported · ${t.skip} skip`,
);

// Surface the interesting rows so a run is legible without opening the JSON.
const notable = report.results.filter((r) => ["fail", "timeout", "crashed"].includes(r.status));
if (notable.length) {
  console.log(`\n  needs attention:`);
  for (const r of notable) console.log(`    ${r.status.padEnd(8)} ${r.id} — ${r.detail.slice(0, 90)}`);
}
