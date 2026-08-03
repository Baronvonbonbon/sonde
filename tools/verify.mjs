#!/usr/bin/env node
// Drive verify.html through headless Chrome and report the verdict.
//
// The fail-safe contract cannot be tested in Node: it depends on real
// AbortController timing, real localStorage/IndexedDB, and a real event loop
// under a browser's task scheduling. So it runs where it will actually run.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME =
  process.env.CHROME ??
  ["google-chrome", "chromium", "chromium-browser"].find(Boolean) ??
  "google-chrome";
const PORT = process.env.PORT ?? "5178";
const URL = `http://localhost:${PORT}/verify.html`;

const vite = spawn("npx", ["vite", "--port", PORT, "--strictPort", "--host", "127.0.0.1"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let viteOut = "";
vite.stdout.on("data", (d) => (viteOut += d));
vite.stderr.on("data", (d) => (viteOut += d));

const stop = () => {
  try {
    vite.kill("SIGTERM");
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

// Wait for the dev server rather than guessing at a fixed delay.
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

const dom = await new Promise((resolve, reject) => {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // The fixtures deliberately wait out real timeouts (3 s each) plus a 5 s
    // cleanup drain. Give the page room to finish before the DOM is dumped.
    "--virtual-time-budget=90000",
    "--dump-dom",
    URL,
  ];
  const chrome = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
  let html = "";
  let err = "";
  chrome.stdout.on("data", (d) => (html += d));
  chrome.stderr.on("data", (d) => (err += d));
  chrome.on("error", reject);
  chrome.on("close", (code) => (code === 0 || html ? resolve(html) : reject(new Error(err || `chrome exited ${code}`))));
});

stop();

const verdict = /<pre id="verdict">([\s\S]*?)<\/pre>/.exec(dom)?.[1] ?? "";
const text = verdict
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

if (!text || text.trim() === "running…") {
  console.error("verification did not complete. DOM was:\n" + dom.slice(0, 4000));
  process.exit(2);
}

console.log(text);
process.exit(/^OK:/m.test(text) ? 0 : 1);
