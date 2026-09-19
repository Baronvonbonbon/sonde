import "./style.css";
import { captureFingerprint } from "./core/fingerprint";
import { Journal } from "./core/journal";
import { Shell } from "./ui/shell";
import { manifest } from "./probes/manifest";
import type { OptIn } from "./core/types";
import { SUITE_VERSION } from "../product.mjs";

declare const __BUILD_ID__: string;

async function boot() {
  // ?fixtures=1 swaps in the pathological probes that test the runner rather
  // than the runtime. Kept out of the default manifest so a shared report is
  // never polluted by deliberately-broken entries.
  const params = new URLSearchParams(location.search);
  const probes = manifest({ fixtures: params.get("fixtures") === "1" });

  const journal = new Journal();
  const runId = crypto.randomUUID?.() ?? String(Date.now());
  await journal.open({
    runId,
    startedAt: new Date().toISOString(),
    suiteVersion: SUITE_VERSION,
    buildId: typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev",
  });

  const fingerprint = await captureFingerprint();
  const shell = new Shell(probes, fingerprint, journal);
  await shell.mount();

  // ?autorun=1[&tier=N] — used by tools/run-headless.mjs to produce a baseline
  // report without a human. Defaults to tier 1 so an accidental autorun cannot
  // raise a prompt, let alone spend anything.
  if (params.get("autorun") === "1") {
    document.title = "SONDE-RUNNING";
    // &optin=slow,crash-risk — opt-in kinds to include; none by default.
    const optIn = (params.get("optin") ?? "").split(",").filter(Boolean) as OptIn[];
    const report = await shell.autorun(Number(params.get("tier") ?? "1"), optIn);
    // ?post=<path> hands the report to the dev server's sink. Dev only — in a
    // published bundle this endpoint does not exist and the fetch simply fails,
    // leaving the on-page report as the only output, which is correct.
    const post = params.get("post");
    if (post) {
      await fetch(`/__sonde/report?to=${encodeURIComponent(post)}`, {
        method: "POST",
        body: JSON.stringify(report, null, 2),
      }).catch((e) => console.error("report sink unreachable:", e));
    }
    document.title = "SONDE-DONE";
  }
}

// Nothing above should be able to leave a blank page. If boot itself fails,
// that is the most important result the suite can report, so it gets rendered
// rather than logged into a console nobody on a phone can open.
boot().catch((e) => {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = `<div class="head">
    <h1>sonde failed to start</h1>
    <div class="sub">This is itself a finding: the suite could not initialise in this runtime.</div>
    <pre class="fp"></pre>
  </div>`;
  app.querySelector("pre")!.textContent =
    `${(e as Error)?.stack ?? String(e)}\n\n${navigator.userAgent}`;
});
