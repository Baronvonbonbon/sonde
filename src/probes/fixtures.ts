// Pathological probes, for testing the runner rather than the runtime.
//
// The fail-safe contract is the load-bearing claim of this whole suite: "every
// probe has a safe exit". A claim like that is worth exactly as much as its
// test. These six exist to break the runner in each of the ways a real probe
// eventually will, so that the guarantees are demonstrated rather than asserted.
//
// They are excluded from the default manifest and enabled with ?fixtures=1.

import { TIER, type Probe } from "../core/types";

const hang = new Promise<never>(() => {});

export const FIXTURES: Probe[] = [
  {
    id: "fixture.hang",
    title: "FIXTURE — never settles",
    why: "Proves the runner bounds a probe that neither resolves nor rejects. Expect `timeout` at 3s, and the suite to carry on.",
    bank: "web",
    category: "fixtures",
    tier: TIER.DETECT,
    timeoutMs: 3_000,
    async run() {
      return hang;
    },
  },
  {
    id: "fixture.throw",
    title: "FIXTURE — throws synchronously",
    why: "Proves a probe that throws before its first await is caught rather than escaping the run loop. Expect `fail`.",
    bank: "web",
    category: "fixtures",
    tier: TIER.DETECT,
    run() {
      throw new Error("deliberate synchronous throw");
    },
  },
  {
    id: "fixture.reject",
    title: "FIXTURE — rejects asynchronously",
    why: "Proves rejection after an await is classified, not swallowed. Expect `fail`.",
    bank: "web",
    category: "fixtures",
    tier: TIER.DETECT,
    async run() {
      await new Promise((r) => setTimeout(r, 10));
      throw new TypeError("deliberate async rejection");
    },
  },
  {
    id: "fixture.leak",
    title: "FIXTURE — acquires a resource and hangs",
    why: "Proves teardown runs even when the probe never reaches its own cleanup code. Expect `timeout` AND a released handle — the interval must stop.",
    bank: "web",
    category: "fixtures",
    tier: TIER.DETECT,
    timeoutMs: 3_000,
    async run(ctx) {
      const handle = setInterval(() => {
        /* would run forever if teardown did not fire */
      }, 100);
      ctx.cleanup.add("fixture-interval", () => clearInterval(handle));

      const el = document.createElement("div");
      el.dataset.sondeFixture = "leak";
      document.body.appendChild(el);
      ctx.cleanup.add("fixture-dom-node", () => el.remove());

      return hang;
    },
  },
  {
    id: "fixture.stubborn-cleanup",
    title: "FIXTURE — teardown that itself hangs",
    why: "Proves cleanup is bounded too. One hung release() must not block the other nineteen, or the suite. Expect a `leaked` entry and the run continuing.",
    bank: "web",
    category: "fixtures",
    tier: TIER.DETECT,
    async run(ctx) {
      ctx.cleanup.add("fixture-hung-release", () => hang);
      ctx.cleanup.add("fixture-throwing-release", () => {
        throw new Error("release() threw");
      });
      ctx.cleanup.add("fixture-good-release", () => undefined);
      return { status: "pass", detail: "Registered three teardowns: one hangs, one throws, one works." };
    },
  },
  {
    id: "fixture.needs-hang",
    title: "FIXTURE — depends on the hanging probe",
    why: "Proves an unmet precondition yields `skip` naming the blocker, never a `fail`. Confusing 'we did not run this' with 'this is broken' is how a compatibility matrix becomes a liar.",
    bank: "web",
    category: "fixtures",
    tier: TIER.DETECT,
    needs: ["fixture.hang"],
    async run() {
      return { status: "fail", detail: "UNREACHABLE — the gate should have skipped this." };
    },
  },
];
