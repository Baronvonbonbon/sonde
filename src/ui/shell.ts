// The interface.
//
// Dependency-free and thumb-sized on purpose: this is read on a phone, in a
// hurry, possibly outdoors, and possibly by someone who did not write it and
// only wants to know what broke.

import { TIER, type Outcome, type Probe, type Status } from "../core/types";
import { Runner, summarise } from "../core/runner";
import type { Journal } from "../core/journal";
import type { Fingerprint } from "../core/fingerprint";
import { fingerprintSummary } from "../core/fingerprint";
import { SURFACE_LABEL } from "../core/surface";
import { buildReport, toGitHubIssue, toMarkdown, type Report, type ResultRow } from "../core/report";
import { toRecordJson } from "../core/record";

const STATUSES: Status[] = ["pass", "fail", "timeout", "crashed", "blocked", "unsupported", "skip"];

export class Shell {
  private readonly root = document.getElementById("app")!;
  private readonly cards = new Map<string, ReturnType<typeof this.card>>();
  private readonly startedAt = new Date().toISOString();
  private readonly runId = crypto.randomUUID?.() ?? String(Date.now());

  private runner!: Runner;
  private maxTier: number = TIER.PROMPT;

  private tallies!: HTMLElement;
  private controls!: HTMLElement;
  private gestureBox!: HTMLElement;
  private reportBox!: HTMLElement;

  constructor(
    private readonly probes: Probe[],
    private readonly fingerprint: Fingerprint,
    private readonly journal: Journal,
  ) {}

  async mount(): Promise<void> {
    this.runner = new Runner(this.probes, this.fingerprint.surface.surface, this.journal, {
      // Logged as well as rendered: when the suite is driven headless the
      // console is the only progress indicator, and "which probe was it on
      // when it stopped" is the first question worth answering.
      onStart: (p) => {
        console.log(`[sonde] → ${p.id}`);
        this.cards.get(p.id)?.markRunning();
      },
      onResult: (p, o) => {
        console.log(`[sonde] ${o.status.padEnd(11)} ${p.id}${o.ms != null ? ` (${o.ms}ms)` : ""}`);
        this.cards.get(p.id)?.render(o);
        this.renderTallies();
      },
      onGestureQueue: (q) => this.renderGesture(q),
      onDone: () => this.renderReport(),
      confirmSpend: (p) => this.confirmSpend(p),
    });

    this.renderHead();
    this.renderTierGate();
    this.renderControls();

    this.gestureBox = el("div");
    this.root.appendChild(this.gestureBox);

    await this.offerResume();
    this.renderCards();

    this.reportBox = el("div");
    this.root.appendChild(this.reportBox);

    this.renderFooter();
    this.renderTallies();
  }

  private renderFooter(): void {
    const f = this.fingerprint;
    const foot = el("div", "foot");
    foot.innerHTML = `
      <a href="${esc(f.suite.source)}" target="_blank" rel="noopener noreferrer">${esc(f.suite.source)}</a>
      <div class="muted">
        sonde ${esc(f.suite.version)} · build ${esc(f.suite.buildId)} · published as
        <span class="mono">${esc(f.suite.productId)}.dot</span>
      </div>
      <div class="muted">
        Every probe's source, and the reasoning behind what each result means, is in
        <span class="mono">src/probes/</span>. If a result here looks wrong, the code that produced
        it is the thing to check.
      </div>`;
    this.root.appendChild(foot);
  }

  // -- header --------------------------------------------------------------

  private renderHead(): void {
    const f = this.fingerprint;
    const head = el("div", "head");
    // The source link is prominent by design. This page makes assertions about
    // someone else's software; a reader who cannot check what was actually
    // called has been given a rumour, not a report.
    head.innerHTML = `
      <h1>sonde <a class="src" href="${esc(f.suite.source)}" target="_blank" rel="noopener noreferrer">source ↗</a></h1>
      <div class="sub">${this.probes.length} probes · ${SURFACE_LABEL[f.surface.surface]}</div>
      <div class="tallies" data-tallies></div>
      <div class="fp">${esc(fingerprintSummary(f))}
${esc(f.browser.userAgent)}
app version : NOT EXPOSED by any host API — Chromium ${esc(f.browser.chromium ?? "?")} is the proxy
truapi      : ${f.host.truapi} (codec ${f.host.truapiCodec})
secure ctx  : ${f.context.isSecureContext} · cross-origin isolated ${f.context.crossOriginIsolated}</div>`;
    this.root.appendChild(head);
    this.tallies = head.querySelector("[data-tallies]")!;
  }

  private renderTallies(): void {
    const totals = summarise(this.runner.results);
    const notRun = this.probes.length - this.runner.results.size;
    this.tallies.innerHTML =
      STATUSES.filter((s) => totals[s] > 0)
        .map((s) => `<span class="tally" data-k="${s}"><b>${totals[s]}</b> ${s}</span>`)
        .join("") + (notRun > 0 ? `<span class="tally"><b>${notRun}</b> not run</span>` : "");
  }

  // -- tier gate -----------------------------------------------------------

  private renderTierGate(): void {
    const box = el("div", "tiergate");
    box.innerHTML = `
      <b>Risk ceiling</b>
      <label><input type="radio" name="tier" value="1">
        <span>T0–T1 — detect and zero-cost calls only.
          <div class="note">Fully unattended. No prompts. Cannot tell "present" from "actually works" for anything permission-gated.</div>
        </span></label>
      <label><input type="radio" name="tier" value="2" checked>
        <span>T0–T2 — also raise permission and signing prompts.
          <div class="note">Expect taps on your phone. Nothing spends, nothing writes to chain.</div>
        </span></label>
      <label><input type="radio" name="tier" value="3">
        <span class="t3">T0–T3 — also spend testnet funds and write to chain.
          <div class="note">Each spend is confirmed separately, and refused outright unless the resolved genesis hash is in SPEND_ALLOWED_GENESIS. An empty allowlist denies everything.</div>
        </span></label>`;
    box.addEventListener("change", (e) => {
      this.maxTier = Number((e.target as HTMLInputElement).value);
    });
    this.root.appendChild(box);
  }

  // -- controls ------------------------------------------------------------

  private renderControls(): void {
    this.controls = el("div", "controls");

    const runAll = button("Run all", "primary", async () => {
      runAll.disabled = true;
      abort.disabled = false;
      this.reportBox.innerHTML = "";
      try {
        await this.runner.runAll({ maxTier: this.maxTier });
      } finally {
        runAll.disabled = false;
        abort.disabled = true;
        runAll.textContent = "Run all again";
      }
    });

    const abort = button("Abort all", "danger", () => {
      this.runner.abort();
      abort.disabled = true;
    });
    abort.disabled = true;

    const report = button("Report", "", () => this.renderReport());

    this.controls.append(runAll, abort, report);
    this.root.appendChild(this.controls);
  }

  // -- crash recovery ------------------------------------------------------

  /**
   * A recovered run is worth offering because the probe that died is named by
   * its absence. Discarding it silently would throw away the most informative
   * result the suite can produce.
   */
  private async offerResume(): Promise<void> {
    const prior = await this.journal.recover();
    if (!prior) return;

    const crashed = [...prior.results.entries()].filter(([, o]) => o.status === "crashed");
    const banner = el("div", "banner");
    banner.innerHTML = `
      <b>A previous run did not finish.</b>
      <div class="muted" style="margin-top:4px">
        ${prior.results.size} probe(s) recorded, started ${esc(prior.meta.startedAt)}.
        ${crashed.length ? `The runtime died during <code>${esc(crashed[0][0])}</code>.` : ""}
      </div>
      <div class="row">
        <button class="small primary" data-keep>Keep those results</button>
        <button class="small" data-discard>Start fresh</button>
      </div>`;

    await new Promise<void>((resolve) => {
      banner.querySelector("[data-keep]")!.addEventListener("click", () => {
        this.runner.restore(prior.results);
        for (const [id, outcome] of prior.results) this.cards.get(id)?.render(outcome);
        this.renderTallies();
        banner.remove();
        resolve();
      });
      banner.querySelector("[data-discard]")!.addEventListener("click", async () => {
        await this.journal.clear();
        banner.remove();
        resolve();
      });
      this.root.appendChild(banner);
    });
  }

  // -- gesture queue -------------------------------------------------------

  /**
   * One tap per probe, always the same button.
   *
   * Chromium's transient user activation lasts ~5s and is consumed by a single
   * call, so twenty gesture probes need twenty taps and cannot be driven from a
   * loop. kite's answer was to defer them and make the operator hunt for
   * individual cards; this keeps the button in one place and counts down.
   */
  private renderGesture(queue: readonly Probe[]): void {
    if (!queue.length) {
      this.gestureBox.innerHTML = "";
      return;
    }
    const next = queue[0];
    const box = el("div", "gesture");
    box.innerHTML = `
      <div class="count">Gesture probes — ${queue.length} remaining</div>
      <div class="what">${esc(next.title)}</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px">${esc(next.why)}</div>
      <div class="row">
        <button class="primary" data-run>Tap to run</button>
        <button data-skip>Skip</button>
        <button data-skipall>Skip all</button>
      </div>`;

    // These must be real click handlers. A programmatic .click() does not
    // confer transient activation, which is the entire reason for this queue.
    box.querySelector("[data-run]")!.addEventListener("click", () => void this.runner.runNextGesture());
    box.querySelector("[data-skip]")!.addEventListener("click", () => this.runner.skipNextGesture());
    box.querySelector("[data-skipall]")!.addEventListener("click", () => this.runner.skipAllGestures());

    this.gestureBox.innerHTML = "";
    this.gestureBox.appendChild(box);
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // -- T3 confirmation -----------------------------------------------------

  private confirmSpend(probe: Probe): Promise<boolean> {
    return new Promise((resolve) => {
      const dlg = document.createElement("dialog");
      dlg.innerHTML = `
        <h2>Spend confirmation</h2>
        <div class="muted" style="font-size:13px">${esc(probe.title)}</div>
        <div class="cost">${esc(probe.cost ?? "This probe declares no cost, which is itself a bug in the probe.")}</div>
        <div class="muted" style="font-size:12px">
          Genesis: <span class="mono">${esc(this.runner.shared.genesis ?? "unresolved")}</span>
        </div>
        <div class="row">
          <button data-no>Skip</button>
          <button class="danger" data-yes>Spend</button>
        </div>`;
      const done = (v: boolean) => {
        dlg.close();
        dlg.remove();
        resolve(v);
      };
      dlg.querySelector("[data-yes]")!.addEventListener("click", () => done(true));
      dlg.querySelector("[data-no]")!.addEventListener("click", () => done(false));
      dlg.addEventListener("cancel", () => done(false));
      document.body.appendChild(dlg);
      dlg.showModal();
    });
  }

  // -- probe cards ---------------------------------------------------------

  private renderCards(): void {
    const list = el("div");
    let group = "";
    for (const probe of this.probes) {
      const key = `${probe.bank} / ${probe.category}`;
      if (key !== group) {
        group = key;
        list.appendChild(el("h3", "", key));
      }
      const c = this.card(probe);
      this.cards.set(probe.id, c);
      list.appendChild(c.el);
    }
    this.root.appendChild(list);
  }

  private card(probe: Probe) {
    const node = el("section", "probe");
    node.innerHTML = `
      <header>
        <span class="dot skip" data-dot></span>
        <h2>${esc(probe.title)}</h2>
        ${probe.gesture ? '<span class="badge gesture">tap</span>' : ""}
        ${probe.tier === TIER.SPEND ? '<span class="badge t3">T3</span>' : `<span class="badge">T${probe.tier}</span>`}
        <button class="small" data-run>Run</button>
      </header>
      <div class="id">${esc(probe.id)}</div>
      <p class="why">${esc(probe.why)}</p>
      <p class="detail muted" data-detail>not run</p>
      <pre data-data hidden></pre>
      <div data-extra></div>`;

    const dot = node.querySelector<HTMLElement>("[data-dot]")!;
    const btn = node.querySelector<HTMLButtonElement>("[data-run]")!;
    const detail = node.querySelector<HTMLElement>("[data-detail]")!;
    const data = node.querySelector<HTMLPreElement>("[data-data]")!;
    const extra = node.querySelector<HTMLElement>("[data-extra]")!;

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      // Single-run honours the operator's explicit choice: tapping a T3 card is
      // itself an unlock, but the spend confirmation and the genesis allowlist
      // both still apply inside the runner.
      await this.runner.runOne(probe.id, Math.max(this.maxTier, probe.tier));
      btn.disabled = false;
    });

    const markRunning = () => {
      dot.className = "dot running";
      detail.textContent = "running…";
      detail.className = "detail muted";
      data.hidden = true;
      extra.innerHTML = "";
    };

    const render = (o: Outcome) => {
      dot.className = `dot ${o.status}`;
      detail.className = "detail";
      detail.textContent = `${o.status.toUpperCase()} — ${o.detail}${o.ms != null ? `  (${o.ms} ms)` : ""}`;
      if (o.data) {
        data.textContent = o.data;
        data.hidden = false;
      }
      const bits: string[] = [];
      if (o.diagnosis) bits.push(`<span class="diag">${esc(o.diagnosis)}</span>`);
      if (o.permissions) {
        bits.push(
          `<pre>permission before : ${esc(JSON.stringify(o.permissions.before))}\n` +
            `permission after  : ${esc(JSON.stringify(o.permissions.after))}</pre>`,
        );
      }
      if (o.txHash) bits.push(`<div class="mono">tx ${esc(o.txHash)}</div>`);
      if (o.leaked?.length) bits.push(`<div class="leak">leaked: ${esc(o.leaked.join(", "))}</div>`);
      extra.innerHTML = bits.join("");
    };

    return { el: node, render, markRunning };
  }

  // -- report --------------------------------------------------------------

  /**
   * Headless entry point: run at a fixed ceiling and expose the report as JSON.
   *
   * Driven by tools/run-headless.mjs. Gesture probes are skipped by definition —
   * transient activation cannot be synthesised — so this only ever produces the
   * unattended half, which is exactly what a CI baseline should be.
   */
  async autorun(maxTier: number): Promise<Report> {
    this.maxTier = maxTier;
    await this.runner.runAll({ maxTier });
    this.runner.skipAllGestures();
    const report = this.currentReport();
    const pre = document.createElement("pre");
    pre.id = "report-json";
    pre.hidden = true;
    pre.textContent = JSON.stringify(report);
    document.body.appendChild(pre);
    return report;
  }

  private currentReport(): Report {
    return buildReport({
      runId: this.runId,
      startedAt: this.startedAt,
      fingerprint: this.fingerprint,
      maxTier: this.maxTier,
      probes: this.probes,
      results: this.runner.results,
    });
  }

  private renderReport(): void {
    const report = this.currentReport();
    const md = toMarkdown(report);
    const box = el("div", "report");
    box.innerHTML = `<h3 style="margin-top:0">Report</h3>
      <div class="controls">
        <button class="small" data-copy>Copy markdown</button>
        <button class="small" data-record title="A run record for github.com/Baronvonbonbon/polkadot-host-capabilities — addresses and file names removed">Copy record</button>
        <button class="small" data-json>Download JSON</button>
        <button class="small" data-issue>GitHub issue…</button>
      </div>
      <pre data-md></pre>`;
    box.querySelector("[data-md]")!.textContent = md;

    box.querySelector("[data-copy]")!.addEventListener("click", async (e) => {
      const b = e.target as HTMLButtonElement;
      try {
        await navigator.clipboard.writeText(md);
        b.textContent = "Copied ✓";
      } catch {
        // Clipboard is routinely blocked in embedded runtimes. The text is
        // already on screen and selectable, so this is a labelling problem
        // rather than a failure.
        b.textContent = "Blocked — select the text below";
      }
      setTimeout(() => (b.textContent = "Copy markdown"), 2500);
    });

    // The shared capability matrix's format (src/core/record.ts). On a phone the clipboard is the
    // only way out — a download does nothing inside the app — so the record is copied, and shown
    // in place of the markdown if the clipboard refuses.
    box.querySelector("[data-record]")!.addEventListener("click", async (e) => {
      const b = e.target as HTMLButtonElement;
      const record = toRecordJson(report);
      try {
        await navigator.clipboard.writeText(record);
        b.textContent = "Copied ✓";
      } catch {
        box.querySelector("[data-md]")!.textContent = record;
        b.textContent = "Blocked — select the text below";
      }
      setTimeout(() => (b.textContent = "Copy record"), 2500);
    });

    box.querySelector("[data-json]")!.addEventListener("click", () => {
      download(`sonde-${report.fingerprint.surface.surface}-${report.runId.slice(0, 8)}.json`, JSON.stringify(report, null, 2));
    });

    box.querySelector("[data-issue]")!.addEventListener("click", () => this.issuePicker(report));

    this.reportBox.innerHTML = "";
    this.reportBox.appendChild(box);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private issuePicker(report: Report): void {
    const bad = report.results.filter((r) =>
      ["fail", "timeout", "crashed", "blocked"].includes(r.status),
    );
    const dlg = document.createElement("dialog");
    dlg.innerHTML = bad.length
      ? `<h2>Which failure?</h2>
         <div class="muted" style="font-size:12px;margin-bottom:8px">
           Produces a ready-to-paste issue with the environment table, repro, and the argument for
           why this signature implicates the host.
         </div>
         ${bad.map((r, i) => `<button class="small" data-i="${i}" style="display:block;width:100%;text-align:left;margin-bottom:5px">${esc(r.status)} — ${esc(r.title)}</button>`).join("")}
         <div class="row"><button data-close>Close</button></div>`
      : `<h2>Nothing to report</h2>
         <div class="muted" style="font-size:13px">No probe came back fail, timeout, crashed, or blocked.</div>
         <div class="row"><button data-close>Close</button></div>`;

    dlg.addEventListener("click", async (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.close !== undefined) {
        dlg.close();
        dlg.remove();
      }
      if (t.dataset.i !== undefined) {
        const row: ResultRow = bad[Number(t.dataset.i)];
        const body = toGitHubIssue(report, row);
        dlg.close();
        dlg.remove();
        const out = el("div", "report");
        out.innerHTML = `<h3 style="margin-top:0">Issue body</h3>
          <div class="controls"><button class="small" data-copy>Copy</button></div><pre></pre>`;
        out.querySelector("pre")!.textContent = body;
        out.querySelector("[data-copy]")!.addEventListener("click", async (ev) => {
          const b = ev.target as HTMLButtonElement;
          try {
            await navigator.clipboard.writeText(body);
            b.textContent = "Copied ✓";
          } catch {
            b.textContent = "Blocked — select below";
          }
        });
        this.reportBox.appendChild(out);
        out.scrollIntoView({ behavior: "smooth" });
      }
    });
    document.body.appendChild(dlg);
    dlg.showModal();
  }
}

// -- helpers -----------------------------------------------------------------

function el(tag: string, cls = "", text = ""): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoked late: some WebViews hand the URL to a download manager that reads
  // it after the click returns, and revoking immediately produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
