# sonde

**[caniusethis.dot](https://caniusethis.dev-dot.li)** — a capability suite for the Polkadot App
runtime. Sent into a runtime to report what is there.

Open it on your own phone, tap **Run all**, and download the JSON. Then diff your report against
someone else's and the disagreement is the finding.

Successor to `kite`, which asked nine questions about one delivery flow and found a real bug doing
it. `sonde` asks **132** questions across two banks, is self-contained enough to hand to a stranger,
and produces a report a machine can diff.

```bash
npm install
npm run dev        # open on a phone, or via the gateway, or in a plain tab
npm run verify     # prove the fail-safe contract before trusting any result
```

## What it covers

| Bank | Surface | Probes |
|---|---|---|
| **A — Chromium** | Everything the WebView exposes to a page: sensors, media, storage, filesystem, Bluetooth/USB/Serial/HID/NFC, WebAuthn, WebGL/WebGPU/WASM, workers, clipboard, share, notifications, network, and the policies wrapped around them | ~85 |
| **B — Polkadot host** | All fifteen `@parity/truapi` namespaces: `account, chain, chat, coinPayment, entropy, localStorage, notifications, payment, permissions, preimage, resourceAllocation, signing, statementStore, system, theme` | ~47 |

The interesting failures live at the seam between the two. Geolocation is exactly that seam.

## The point: one probe, three surfaces

A single run is an anecdote. The same bundle run on three surfaces and diffed is evidence:

| Surface | Host API | What it isolates |
|---|---|---|
| Plain browser tab | absent | The control — what the web platform gives anyone |
| `dev-dot.li` gateway iframe | absent | What the embedder's Permissions-Policy takes away |
| Polkadot App WebView | present | What the host adds, and what it withholds |

```bash
npm run headless -- report-plain.json --tier 1     # surface 1, automated
# surfaces 2 and 3 by hand, then:
npm run diff -- report-plain.json report-inapp.json --md
```

`diff` exits non-zero on any regression, so it can gate CI.

## Risk tiers

Every probe declares one. The runner gates on it.

| Tier | Meaning | Default |
|---|---|---|
| **T0** detect | Presence and shape only. No invocation, no side effects | on |
| **T1** invoke | A real call that costs nothing and cannot prompt | on |
| **T2** prompt | May raise an OS or host permission/signing prompt | on |
| **T3** spend | Moves testnet funds or writes to chain | **locked** |

T3 needs three independent keys: the ceiling raised in the UI, a per-probe confirmation showing
that probe's declared cost verbatim, and the resolved genesis hash present in
`SPEND_ALLOWED_GENESIS` in `product.mjs`. That list ships **empty**, so a fresh checkout refuses
every spend. The allowlist is the real fail-safe — a UI toggle guards against inattention, but only
the allowlist guards against a misconfigured `CLOUD_ENV`, and mainnet is refused outright regardless.

## The fail-safe contract

The load-bearing claim is that **every probe has a safe exit**. It is implemented once, in
`src/core/runner.ts`, and probes cannot opt out:

- a probe cannot run longer than its budget — timeout plus `AbortSignal`
- a probe cannot leak a resource past its own end — `cleanup.drain()`, itself bounded
- a probe cannot wedge the suite — every throw is classified, never propagated
- a probe cannot lose a result to a crash — the journal writes `begin` before invoking
- a probe cannot spend without three separate keys
- a probe cannot silently test a stale precondition — unmet `needs` yields `skip`, never `fail`

`npm run verify` drives the real runner against six deliberately pathological fixtures — one that
hangs forever, one that throws synchronously, one that rejects asynchronously, one that grabs a
resource and hangs, one whose *teardown* hangs and throws, and one that depends on the hanging
one — and asserts all of the above, plus crash recovery, tier gating, abort, manifest integrity and
report rendering. 39 checks.

**The honest limit:** `Promise.race` does not cancel the losing promise. A hung probe leaves a
dangling promise for the life of the page — there is no way to kill an in-flight platform call from
script. What *is* guaranteed is that its resources are released and the suite moves on. This is
stated in every report's caveats rather than hidden.

## Status vocabulary

`pass | fail | skip` is too coarse for a compatibility matrix — it cannot say *why*, which is the
whole value.

| Status | Meaning | Whose problem |
|---|---|---|
| `pass` | Invoked, returned something correct | — |
| `unsupported` | Genuinely absent. A true negative, not a bug | nobody's |
| `blocked` | Present, denied by permission or policy | embedder, host, or user |
| `fail` | Present and allowed, but errored or returned something wrong | the implementer |
| `timeout` | Never settled | the implementer, urgently |
| `crashed` | Started and never finished — the tab died here | the implementer, urgently |
| `skip` | Precondition unmet, or tier locked | — |

Each result also carries a stable `diagnosis` slug (`host-callback-missing`,
`policy-blocked-by-embedder`, `never-settled`, …). Prose does not survive being compared across
forty devices; a slug does.

## Two things worth knowing before you read a report

**No host API exposes an app version.** Checked across all fifteen truapi namespaces — nothing
returns a version, build number, or release channel. The Chromium version is the working proxy
(the app ships a bundled engine, so it moves with releases), but two app builds on the same
Chromium are indistinguishable. `host.system.version` records this as `unsupported` in every
report rather than burying it in a footnote, and enumerates the namespaces at runtime so it will
start passing on its own if a version call is ever added.

**Bluetooth, USB, Serial and HID grants persist per origin.** `close()` releases the connection;
only `forget()` revokes the grant. A second run of the suite otherwise reports `pass` where a fresh
device reports `blocked` — a false negative, and an invisible one. Those probes are marked `sticky`
and register the revocation. Clear site data before re-running anyway.

## Layout

```
src/core/      the fail-safe contract: types, runner, cleanup, journal, fingerprint, report, surface
src/probes/    manifest.ts (the single ordered registry) · web/ (Bank A) · host/ (Bank B) · fixtures.ts
src/ui/        shell: cards, gesture queue, tier gate, report views
tools/         verify.mjs · run-headless.mjs · diff-report.mjs · pair-probe.mjs
```

`manifest.ts` order is load-bearing: cheap and unattended first, `needs` before dependents,
`crashRisk: "high"` last. The runner validates the `needs` graph at construction and refuses a
manifest with a cycle or a dangling reference.

## The gesture queue

Chromium's transient user activation lasts ~5 s and is consumed by **one** call. Around twenty
probes need their own tap and cannot be driven from a loop. So the runner runs every unattended
probe first — an operator who walks away still gets the complete automatic bank journalled — then
presents a single button that relabels itself, one tap per probe, counting down.

## Independence

`kite` resolved an `@src` alias to a sibling checkout, which made it un-runnable by anyone who did
not also have that checkout. There is no alias here. The seal/round-trip probe is self-contained
WebCrypto rather than an upstream import.
