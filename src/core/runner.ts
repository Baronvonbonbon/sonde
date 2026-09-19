// The fail-safe contract, in one place.
//
// Every guarantee the suite makes is implemented here and nowhere else:
//
//   - a probe cannot run longer than its budget          (timeout + AbortSignal)
//   - a probe cannot leak a resource past its own end    (cleanup.drain)
//   - a probe cannot wedge the suite                     (catch-all classify)
//   - a probe cannot lose a result to a crash            (journal begin/finish)
//   - a probe cannot spend without three separate keys   (tier gate + allowlist)
//   - a probe cannot silently test a stale precondition  (needs → skip)
//
// Probes are plain async functions that may throw. That is deliberate: the
// easier it is to write a probe, the more of the surface gets covered.

import {
  BAD_STATUSES,
  DEFAULT_TIMEOUT_MS,
  TIER,
  AbortedError,
  BlockedError,
  TimeoutError,
  UnsupportedError,
  type Ctx,
  type OptIn,
  type Outcome,
  type PermissionSample,
  type Probe,
  type SharedState,
  type Status,
  type Surface,
} from "./types";
import { CleanupRegistry } from "./cleanup";
import { Journal } from "./journal";
import { MAINNET_GENESIS, SPEND_ALLOWED_GENESIS } from "../../product.mjs";

export interface RunnerEvents {
  onStart?(probe: Probe): void;
  onResult?(probe: Probe, outcome: Outcome): void;
  /** A gesture probe is waiting for its tap. Resolve by calling runGesture(). */
  onGestureQueue?(queued: Probe[]): void;
  onDone?(results: ReadonlyMap<string, Outcome>): void;
  /** T3 confirmation. Return false to skip. Shown the probe's `cost` verbatim. */
  confirmSpend?(probe: Probe): Promise<boolean>;
}

export interface RunOptions {
  /** Highest tier permitted this run. T3 also needs the genesis allowlist. */
  maxTier?: number;
  /** Restrict to these ids. Empty means everything. */
  only?: string[];
  /** Include probes marked optIn: all of them (true), or only these kinds. */
  includeOptIn?: boolean | OptIn[];
}

export class Runner {
  readonly results = new Map<string, Outcome>();
  readonly shared: SharedState = { scratch: new Map() };

  private abortAll: AbortController | null = null;
  private running = false;
  private gestureQueue: Probe[] = [];
  private maxTier: number = TIER.PROMPT;

  constructor(
    private readonly probes: Probe[],
    private readonly surface: Surface,
    private readonly journal: Journal,
    private readonly events: RunnerEvents = {},
  ) {
    assertNoCycles(probes);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get pendingGestures(): readonly Probe[] {
    return this.gestureQueue;
  }

  /**
   * Run everything that does not need a tap, then hand the rest to the gesture
   * queue.
   *
   * The split matters. Chromium's transient user activation lasts about five
   * seconds and is consumed by a single call, so ~20 gesture probes need ~20
   * taps and cannot be driven from a loop. Running the unattended bank FIRST
   * means an operator who walks away still has a complete automatic report
   * journalled, rather than a page stuck on probe 3 waiting for a finger.
   */
  async runAll(opts: RunOptions = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.maxTier = opts.maxTier ?? TIER.PROMPT;
    this.abortAll = new AbortController();

    const chosen = opts.only?.length
      ? this.probes.filter((p) => opts.only!.includes(p.id))
      : this.probes;
    // Opt-in probes are recorded as skipped with the reason, never silently dropped:
    // a missing row reads as "fine" in a matrix.
    const selected = chosen.filter((p) => {
      const included = opts.includeOptIn === true || (Array.isArray(opts.includeOptIn) && !!p.optIn && opts.includeOptIn.includes(p.optIn));
      if (!p.optIn || included || opts.only?.includes(p.id)) return true;
      this.record(p, { status: "skip", detail: `Opt-in (${p.optIn}) — not selected for this run. Run it from its card, or tick the opt-in box.` });
      return false;
    });

    const unattended = selected.filter((p) => !p.gesture);
    this.gestureQueue = selected.filter((p) => p.gesture);

    try {
      for (const probe of unattended) {
        if (this.abortAll.signal.aborted) {
          this.record(probe, {
            status: "skip",
            detail: "Aborted before this probe ran.",
          });
          continue;
        }
        await this.execute(probe);
      }
    } finally {
      this.running = false;
    }

    if (this.gestureQueue.length) {
      this.events.onGestureQueue?.(this.gestureQueue);
    } else {
      this.events.onDone?.(this.results);
    }
  }

  /** Run the next queued gesture probe. Must be called from a real click handler. */
  async runNextGesture(): Promise<void> {
    const probe = this.gestureQueue.shift();
    if (!probe) return;
    await this.execute(probe);
    this.events.onGestureQueue?.(this.gestureQueue);
    if (!this.gestureQueue.length) this.events.onDone?.(this.results);
  }

  skipNextGesture(): void {
    const probe = this.gestureQueue.shift();
    if (probe) {
      this.record(probe, { status: "skip", detail: "Skipped by the operator." });
    }
    this.events.onGestureQueue?.(this.gestureQueue);
    if (!this.gestureQueue.length) this.events.onDone?.(this.results);
  }

  skipAllGestures(): void {
    for (const probe of this.gestureQueue) {
      this.record(probe, { status: "skip", detail: "Skipped by the operator." });
    }
    this.gestureQueue = [];
    this.events.onGestureQueue?.([]);
    this.events.onDone?.(this.results);
  }

  /** Single-probe run, for the per-card button. Same contract, same guarantees. */
  async runOne(id: string, maxTier = this.maxTier): Promise<Outcome | null> {
    const probe = this.probes.find((p) => p.id === id);
    if (!probe) return null;
    const prev = this.maxTier;
    this.maxTier = maxTier;
    try {
      return await this.execute(probe);
    } finally {
      this.maxTier = prev;
    }
  }

  /** Stop after the current probe. Everything remaining is recorded `skip`. */
  abort(): void {
    this.abortAll?.abort(new AbortedError());
    for (const probe of this.gestureQueue) {
      this.record(probe, { status: "skip", detail: "Aborted by the operator." });
    }
    this.gestureQueue = [];
  }

  /** Seed from a recovered journal so a resumed run does not repeat itself. */
  restore(results: Map<string, Outcome>): void {
    for (const [id, outcome] of results) this.results.set(id, outcome);
  }

  // -- the contract ----------------------------------------------------------

  private async execute(probe: Probe): Promise<Outcome> {
    const gate = await this.gate(probe);
    if (gate) return this.record(probe, gate);

    this.events.onStart?.(probe);

    const cleanup = new CleanupRegistry();
    const ac = new AbortController();
    const budget = probe.timeoutMs ?? DEFAULT_TIMEOUT_MS[probe.tier];
    const before = await samplePermissions(probe.permissions);

    // Journalled BEFORE the call. If the runtime dies inside probe.run(), this
    // record with no matching finish is what names the probe that killed it.
    await this.journal.begin(probe.id);

    // A global abort has to reach a probe already in flight.
    const onGlobalAbort = () => ac.abort(new AbortedError());
    this.abortAll?.signal.addEventListener("abort", onGlobalAbort, { once: true });

    const timer = setTimeout(() => ac.abort(new TimeoutError(budget)), budget);
    const t0 = performance.now();

    let outcome: Outcome;
    try {
      const ctx: Ctx = {
        signal: ac.signal,
        cleanup,
        surface: this.surface,
        shared: this.shared,
        results: this.results,
        timed,
      };
      // NOTE: Promise.race does not cancel the losing promise. A hung probe
      // leaves a dangling promise for the life of the page — unavoidable in a
      // browser, since there is no way to kill an in-flight platform call. What
      // IS guaranteed is that its resources are released (drain, below) and
      // that the suite moves on. That is the honest limit of the fail-safe and
      // it is documented in the report footer rather than hidden.
      outcome = await Promise.race([probe.run(ctx), rejectOnAbort(ac.signal)]);
    } catch (e) {
      outcome = classify(e, budget);
    } finally {
      clearTimeout(timer);
      this.abortAll?.signal.removeEventListener("abort", onGlobalAbort);
    }

    outcome.ms ??= Math.round(performance.now() - t0);

    // Teardown runs whatever happened — including after a timeout, where the
    // probe itself never reached its own cleanup code.
    const { leaked } = await cleanup.drain();
    if (leaked.length) outcome.leaked = leaked;

    const after = await samplePermissions(probe.permissions);
    if (probe.permissions?.length) outcome.permissions = { before, after };

    // The reasoning kite wrote by hand for geolocation, applied to every gated
    // probe: a denial that leaves the permission undecided was never actually
    // put to the user.
    if (outcome.status === "blocked" && !outcome.diagnosis) {
      outcome.diagnosis = diagnosePermissionDenial(before, after);
    }

    await this.journal.finish(probe.id, outcome);
    return this.record(probe, outcome);
  }

  /**
   * Everything that can stop a probe before it starts. Each returns a `skip`
   * naming its own reason — never a `fail`, because "we did not run this" and
   * "this is broken" must not blur together in a compatibility matrix.
   */
  private async gate(probe: Probe): Promise<Outcome | null> {
    if (probe.tier > this.maxTier) {
      return {
        status: "skip",
        detail:
          probe.tier === TIER.SPEND
            ? `Tier 3 (spend/write) is locked. ${probe.cost ?? ""}`.trim()
            : `Tier ${probe.tier} is above the current ceiling of ${this.maxTier}.`,
      };
    }

    for (const need of probe.needs ?? []) {
      const dep = this.results.get(need);
      if (!dep) {
        return { status: "skip", detail: `Needs "${need}", which has not run yet.` };
      }
      if (dep.status !== "pass") {
        return {
          status: "skip",
          detail: `Needs "${need}", which came back ${dep.status}. Running anyway would test a placeholder.`,
        };
      }
    }

    if (probe.tier === TIER.SPEND) {
      const refusal = this.checkSpendAllowlist();
      if (refusal) return refusal;
      const ok = await this.events.confirmSpend?.(probe);
      if (ok === false) {
        return { status: "skip", detail: "Spend declined by the operator." };
      }
    }

    return null;
  }

  /**
   * The T3 fail-safe that is not a UI toggle.
   *
   * A switch in the interface guards against inattention. This guards against a
   * misconfigured CLOUD_ENV — which product.mjs documents as an easy mistake,
   * and which a switch cannot see. An empty allowlist denies everything, which
   * is the correct default for a fresh checkout.
   */
  private checkSpendAllowlist(): Outcome | null {
    const genesis = this.shared.genesis;
    if (!genesis) {
      return {
        status: "skip",
        detail:
          "No genesis hash resolved yet — run host.chain.genesis first. Spending on an " +
          "unidentified chain is refused.",
        diagnosis: "spend-refused-by-allowlist",
      };
    }
    const mainnet = (MAINNET_GENESIS as Record<string, string>)[genesis];
    if (mainnet) {
      return {
        status: "skip",
        detail: `REFUSED: this is ${mainnet} mainnet (${genesis.slice(0, 10)}…). sonde does not spend on mainnet.`,
        diagnosis: "spend-refused-by-allowlist",
      };
    }
    if (!(SPEND_ALLOWED_GENESIS as string[]).includes(genesis)) {
      return {
        status: "skip",
        detail:
          `REFUSED: genesis ${genesis.slice(0, 10)}… is not in SPEND_ALLOWED_GENESIS. ` +
          "Add it to product.mjs only after confirming it is a chain you are willing to spend on.",
        diagnosis: "spend-refused-by-allowlist",
      };
    }
    return null;
  }

  private record(probe: Probe, outcome: Outcome): Outcome {
    this.results.set(probe.id, outcome);
    this.events.onResult?.(probe, outcome);
    return outcome;
  }
}

// -- classification ----------------------------------------------------------

/**
 * Turn anything a probe can throw into an Outcome. Never throws itself — this
 * is the last line between one bad probe and a dead suite.
 */
export function classify(e: unknown, budgetMs: number): Outcome {
  if (e instanceof TimeoutError) {
    return {
      status: "timeout",
      detail: `Never settled after ${(budgetMs / 1000).toFixed(0)}s. A call that neither resolves nor rejects is worse than one that fails.`,
      diagnosis: "never-settled",
    };
  }
  if (e instanceof AbortedError) {
    return { status: "skip", detail: "Aborted by the operator." };
  }
  if (e instanceof UnsupportedError) {
    return { status: "unsupported", detail: e.message, diagnosis: "not-implemented" };
  }
  if (e instanceof BlockedError) {
    return { status: "blocked", detail: e.message, diagnosis: e.diagnosis };
  }

  const err = e as { name?: string; message?: string; code?: number };
  const msg = err?.message ?? String(e);

  // DOMException names are the platform's own vocabulary for these cases and
  // are far more reliable than message-text matching.
  if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
    return {
      status: "blocked",
      detail: msg,
      diagnosis: /permissions? policy|feature policy/i.test(msg)
        ? "policy-blocked-by-embedder"
        : /gesture|activation/i.test(msg)
          ? "needs-user-gesture"
          : "os-denied",
    };
  }
  if (err?.name === "NotSupportedError" || err?.name === "TypeError" && /is not a function|undefined/.test(msg)) {
    return { status: "unsupported", detail: msg, diagnosis: "not-implemented" };
  }
  if (err?.name === "NotFoundError") {
    // No camera, no Bluetooth device chosen, no file picked. The API works; the
    // hardware or the user did not supply an input. Not a runtime defect.
    return { status: "unsupported", detail: msg, diagnosis: "not-implemented" };
  }
  if (err?.name === "AbortError") {
    return { status: "skip", detail: `Dismissed or aborted: ${msg}`, diagnosis: "user-dismissed" };
  }

  return { status: "fail", detail: msg, diagnosis: "threw" };
}

/**
 * A permission that reads "prompt" both before AND after a denial was never put
 * to the user: Chromium fails a request closed when the embedder never answers
 * the callback, leaving the state undecided. A genuine refusal leaves "denied".
 *
 * This is precisely the inference behind kite's geolocation bug report. Doing
 * it automatically for every gated probe is most of why this suite exists.
 */
function diagnosePermissionDenial(before: PermissionSample, after: PermissionSample) {
  for (const name of Object.keys(after)) {
    if (before[name] === "prompt" && after[name] === "prompt") return "host-callback-missing";
    if (after[name] === "denied") return "os-denied";
  }
  return "os-denied";
}

async function samplePermissions(names?: string[]): Promise<PermissionSample> {
  const out: PermissionSample = {};
  if (!names?.length) return out;
  for (const name of names) {
    if (!navigator.permissions?.query) {
      out[name] = "unavailable";
      continue;
    }
    try {
      out[name] = (await navigator.permissions.query({ name: name as PermissionName })).state;
    } catch {
      // Chromium rejects unknown permission names outright, which tells us the
      // build does not know that permission at all — worth recording.
      out[name] = "unavailable";
    }
  }
  return out;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - t0)];
}

/**
 * `needs` is a DAG or it is a deadlock. Validated at construction so a bad
 * manifest fails loudly at startup rather than silently skipping half the suite.
 */
function assertNoCycles(probes: Probe[]): void {
  const byId = new Map(probes.map((p) => [p.id, p]));
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string, path: string[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      throw new Error(`sonde: cycle in probe "needs": ${[...path, id].join(" → ")}`);
    }
    state.set(id, "visiting");
    for (const need of byId.get(id)?.needs ?? []) {
      if (!byId.has(need)) {
        throw new Error(`sonde: probe "${id}" needs "${need}", which does not exist`);
      }
      visit(need, [...path, id]);
    }
    state.set(id, "done");
  };

  for (const p of probes) visit(p.id, []);
}

export function summarise(results: ReadonlyMap<string, Outcome>): Record<Status, number> {
  const totals: Record<Status, number> = {
    pass: 0,
    unsupported: 0,
    blocked: 0,
    fail: 0,
    timeout: 0,
    crashed: 0,
    skip: 0,
  };
  for (const r of results.values()) totals[r.status]++;
  return totals;
}

export function countBad(results: ReadonlyMap<string, Outcome>): number {
  let n = 0;
  for (const r of results.values()) if (BAD_STATUSES.includes(r.status)) n++;
  return n;
}
