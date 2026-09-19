// Verification of the fail-safe contract.
//
// "Every probe has a safe exit" is the load-bearing claim of this suite, and a
// claim like that is worth exactly as much as its test. This drives the REAL
// runner against the pathological fixtures and asserts each guarantee, rather
// than asserting them in a comment.
//
// Run headless:
//   npm run verify

import { Runner } from "./core/runner";
import { Journal } from "./core/journal";
import { FIXTURES } from "./probes/fixtures";
import { manifest } from "./probes/manifest";
import { buildReport, toMarkdown, toGitHubIssue } from "./core/report";
import { recordKey, redact, toRecord, RECORD_SCHEMA } from "./core/record";
import { MAINNET_GENESIS, SPEND_ALLOWED_GENESIS } from "../product.mjs";
import { captureFingerprint } from "./core/fingerprint";
import { TIER, type Outcome, type Probe } from "./core/types";

const out: string[] = [];
let failures = 0;

function check(name: string, condition: boolean, note = ""): void {
  out.push(`${condition ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
  if (!condition) failures++;
}

function describe(title: string): void {
  out.push("", `── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

async function main() {
  const fingerprint = await captureFingerprint();

  // -- 1. per-probe fail-safes ---------------------------------------------

  describe("fail-safe contract");

  const journal = new Journal();
  await journal.open({
    runId: "verify",
    startedAt: new Date().toISOString(),
    suiteVersion: "verify",
    buildId: "verify",
  });
  await journal.clear();

  const runner = new Runner(FIXTURES, "plain-browser", journal);
  const t0 = performance.now();
  await runner.runAll({ maxTier: TIER.SPEND });
  const wallClock = performance.now() - t0;

  const r = (id: string): Outcome | undefined => runner.results.get(id);

  check("every fixture produced a result", runner.results.size === FIXTURES.length, `${runner.results.size}/${FIXTURES.length}`);

  const hang = r("fixture.hang");
  check("a never-settling probe times out", hang?.status === "timeout", `status=${hang?.status}`);
  check("timeout is diagnosed as never-settled", hang?.diagnosis === "never-settled", `diagnosis=${hang?.diagnosis}`);
  check(
    "timeout happens at the declared budget, not later",
    (hang?.ms ?? 0) >= 2_900 && (hang?.ms ?? 0) < 6_000,
    `${hang?.ms} ms for a 3000 ms budget`,
  );

  const thrown = r("fixture.throw");
  check("a synchronous throw is caught", thrown?.status === "fail", `status=${thrown?.status}`);
  check("a synchronous throw does not escape the run loop", out.length > 0);

  const rejected = r("fixture.reject");
  check("an async rejection is classified", rejected?.status === "fail", `status=${rejected?.status}`);

  const leak = r("fixture.leak");
  check("a probe that hangs while holding a resource still times out", leak?.status === "timeout", `status=${leak?.status}`);
  check(
    "teardown ran even though the probe never reached its own cleanup",
    document.querySelector('[data-sonde-fixture="leak"]') === null,
    "the DOM node it injected is gone",
  );

  const stubborn = r("fixture.stubborn-cleanup");
  check("a probe with hostile teardown still returns its own result", stubborn?.status === "pass", `status=${stubborn?.status}`);
  check(
    "a hung teardown is reported as leaked rather than blocking the suite",
    !!stubborn?.leaked?.some((l) => l.includes("fixture-hung-release")),
    JSON.stringify(stubborn?.leaked),
  );
  check(
    "a throwing teardown is reported too",
    !!stubborn?.leaked?.some((l) => l.includes("fixture-throwing-release")),
    JSON.stringify(stubborn?.leaked),
  );
  check(
    "a working teardown beside a hung one is NOT reported as leaked",
    !stubborn?.leaked?.some((l) => l.includes("fixture-good-release")),
  );

  const dependent = r("fixture.needs-hang");
  check("an unmet precondition yields skip, never fail", dependent?.status === "skip", `status=${dependent?.status}`);
  check("the skip names the blocking probe", !!dependent?.detail.includes("fixture.hang"), dependent?.detail);

  // Two 3s timeouts plus a 5s cleanup drain. If the drain were unbounded, the
  // stubborn-cleanup fixture would hang here forever.
  check("the whole suite finishes in bounded time", wallClock < 30_000, `${Math.round(wallClock)} ms`);

  // -- 2. crash recovery ----------------------------------------------------

  describe("crash recovery");

  const crashJournal = new Journal();
  // Clear BEFORE opening: clear() drops the run header, and opening afterwards
  // is what a fresh run does.
  await crashJournal.clear();
  await crashJournal.open({
    runId: "crash-sim",
    startedAt: new Date().toISOString(),
    suiteVersion: "verify",
    buildId: "verify",
  });
  // Simulate a renderer death: a `begin` with no matching `finish`.
  await crashJournal.begin("web.graphics.webgpu");
  await crashJournal.finish("web.compute.wasm", { status: "pass", detail: "fine" });

  const recovered = await new Journal().recover();
  check("a partial run is recoverable", !!recovered, `${recovered?.results.size ?? 0} entries`);
  check(
    "a probe that began and never finished is promoted to `crashed`",
    recovered?.results.get("web.graphics.webgpu")?.status === "crashed",
    `status=${recovered?.results.get("web.graphics.webgpu")?.status}`,
  );
  check(
    "a probe that finished keeps its real result",
    recovered?.results.get("web.compute.wasm")?.status === "pass",
  );
  await crashJournal.clear();

  // -- 3. tier gating -------------------------------------------------------

  describe("tier gating and the T3 allowlist");

  const spendProbe: Probe = {
    id: "verify.spend",
    title: "verify — a T3 spend",
    why: "Asserts the spend gate.",
    bank: "host",
    category: "verify",
    tier: TIER.SPEND,
    cost: "Would spend imaginary money.",
    async run() {
      return { status: "pass", detail: "SHOULD NOT RUN" };
    },
  };

  // (a) locked by tier ceiling
  const lockedJournal = new Journal();
  await lockedJournal.open({ runId: "t3-locked", startedAt: "", suiteVersion: "v", buildId: "v" });
  const locked = new Runner([spendProbe], "polkadot-app", lockedJournal);
  await locked.runAll({ maxTier: TIER.PROMPT });
  check("T3 is skipped when the ceiling is T2", locked.results.get("verify.spend")?.status === "skip");

  // (b) unlocked but no genesis resolved — the allowlist must still refuse
  const noGenesis = new Runner([spendProbe], "polkadot-app", lockedJournal, {
    confirmSpend: async () => true,
  });
  await noGenesis.runAll({ maxTier: TIER.SPEND });
  const ng = noGenesis.results.get("verify.spend");
  check(
    "T3 with the ceiling raised is STILL refused without an identified chain",
    ng?.status === "skip" && ng?.diagnosis === "spend-refused-by-allowlist",
    `${ng?.status}/${ng?.diagnosis}`,
  );

  // (c) unlocked, confirmed, and pointed at mainnet — the real fail-safe
  const mainnet = new Runner([spendProbe], "polkadot-app", lockedJournal, {
    confirmSpend: async () => true,
  });
  mainnet.shared.genesis = "0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3";
  await mainnet.runAll({ maxTier: TIER.SPEND });
  const mn = mainnet.results.get("verify.spend");
  check(
    "T3 confirmed by the operator is STILL refused on mainnet",
    mn?.status === "skip" && mn?.diagnosis === "spend-refused-by-allowlist",
    `${mn?.status}/${mn?.diagnosis}`,
  );
  check("the mainnet refusal names the chain", !!mn?.detail.includes("Polkadot"), mn?.detail);
  check(
    "the spend allowlist holds no mainnet chain",
    SPEND_ALLOWED_GENESIS.every((g: string) => !(g in MAINNET_GENESIS)),
  );
  await lockedJournal.clear();

  // -- 4. abort -------------------------------------------------------------

  describe("abort");

  const abortJournal = new Journal();
  await abortJournal.open({ runId: "abort", startedAt: "", suiteVersion: "v", buildId: "v" });
  const abortable = new Runner(FIXTURES, "plain-browser", abortJournal);
  const running = abortable.runAll({ maxTier: TIER.DETECT });
  setTimeout(() => abortable.abort(), 500);
  await running;
  const aborted = [...abortable.results.values()].filter((o) => o.status === "skip");
  check("abort mid-run resolves the run rather than hanging", true, `${abortable.results.size} results`);
  check("everything after the abort is skipped, not failed", aborted.length > 0, `${aborted.length} skipped`);
  check(
    "no probe is left with no result after an abort",
    abortable.results.size === FIXTURES.length,
    `${abortable.results.size}/${FIXTURES.length}`,
  );
  await abortJournal.clear();

  // -- 5. manifest integrity ------------------------------------------------

  describe("manifest integrity");

  const all = manifest();
  check("the real manifest builds", all.length > 0, `${all.length} probes`);

  const ids = new Set(all.map((p) => p.id));
  check("no duplicate ids", ids.size === all.length, `${all.length - ids.size} duplicates`);

  const danglingNeeds = all.flatMap((p) => (p.needs ?? []).filter((n) => !ids.has(n)).map((n) => `${p.id}→${n}`));
  check("every `needs` names a probe that exists", danglingNeeds.length === 0, danglingNeeds.join(", "));

  const position = new Map(all.map((p, i) => [p.id, i]));
  const outOfOrder = all.flatMap((p) =>
    (p.needs ?? []).filter((n) => (position.get(n) ?? -1) > position.get(p.id)!).map((n) => `${p.id} before ${n}`),
  );
  check("every `needs` appears earlier in the manifest", outOfOrder.length === 0, outOfOrder.join(", "));

  const t3WithoutCost = all.filter((p) => p.tier === TIER.SPEND && !p.cost).map((p) => p.id);
  check("every T3 probe declares its cost", t3WithoutCost.length === 0, t3WithoutCost.join(", "));

  const stickyIds = all.filter((p) => p.sticky).map((p) => p.id);
  check("sticky probes are marked", stickyIds.length > 0, `${stickyIds.length}: ${stickyIds.join(", ")}`);

  // Cycle detection is enforced in the Runner constructor.
  let cycleCaught = false;
  try {
    new Runner(
      [
        { ...FIXTURES[0], id: "a", needs: ["b"] },
        { ...FIXTURES[0], id: "b", needs: ["a"] },
      ],
      "plain-browser",
      journal,
    );
  } catch {
    cycleCaught = true;
  }
  check("a cyclic `needs` graph is rejected at construction", cycleCaught);

  // -- 6. report ------------------------------------------------------------

  describe("report");

  const report = buildReport({
    runId: "verify",
    startedAt: new Date().toISOString(),
    fingerprint,
    maxTier: TIER.SPEND,
    probes: FIXTURES,
    results: runner.results,
  });

  check("report totals sum to the probe count", Object.values(report.totals).reduce((a, b) => a + b, 0) === FIXTURES.length);
  check("markdown renders", toMarkdown(report).includes("# sonde report"));
  check("the app-version gap is stated in the report", toMarkdown(report).includes("not exposed by any host API"));

  const failing = report.results.find((x) => x.status === "timeout");
  check("a failing row exists to format", !!failing);
  if (failing) {
    const issue = toGitHubIssue(report, failing);
    check("the issue formatter produces an environment table", issue.includes("## Environment"));
    check("the issue formatter includes a reproduction section", issue.includes("## Reproduction"));
    check(
      "the issue formatter argues why the signature implicates the host",
      issue.includes("## Why this signature points where it does"),
    );
    check("the issue formatter states the app-version gap", issue.includes("system.version()"));
  }

  const json = JSON.stringify(report);
  check("the report round-trips through JSON", JSON.parse(json).schema === "sonde-report/1");

  const record = toRecord(report) as { schema: string; key: string; results: Record<string, unknown> };
  check("the run record carries the shared schema id", record.schema === RECORD_SCHEMA);
  check(
    "the run record key names date, codec, host SDK and OS",
    /^\d{4}-\d{2}-\d{2}_codec\d+_host-[^_]+_[a-z]+-\w+$/.test(recordKey(report)),
    recordKey(report),
  );
  check("the run record has every probe", Object.keys(record.results).length === report.results.length);
  check(
    "the run record redacts addresses but keeps chain hashes",
    redact("5DAXE4qVcgAnpqEdAxNNj68Kmj5aNrGGVaujRVD9YqqmNxAm 0xa6d98c2e9eaa9d5bde71cb8763d54011e3a356f6 0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3") ===
      "<ss58 address> <h160 address> 0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3",
  );

  // Stash a fixture report pair for the diff CLI to chew on.
  (window as unknown as { __sondeReport: unknown }).__sondeReport = report;

  // -- verdict ---------------------------------------------------------------

  out.unshift(
    `sonde fail-safe verification — ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
    `${fingerprint.browser.userAgent}`,
  );
  out.push("", `${failures === 0 ? "OK" : "FAILED"}: ${failures} failure(s)`);
  document.getElementById("verdict")!.textContent = out.join("\n");
  document.title = failures === 0 ? "VERIFY-OK" : "VERIFY-FAILED";
}

main().catch((e) => {
  document.getElementById("verdict")!.textContent =
    `verification harness itself threw:\n${(e as Error)?.stack ?? String(e)}`;
  document.title = "VERIFY-FAILED";
});
