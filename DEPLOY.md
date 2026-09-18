# Deploying sonde

## Identity

| | |
|---|---|
| DotNS label | `caniusethis.dot` |
| Environment | `devnet` |
| Gateway | `https://caniusethis.dev-dot.li` |
| Owner | `0xff54a5a1fdac91bb4f2b4fbf4bfff37cdbea333f` |

`kite` used a random 32-character label so that testing a platform's limits did not announce who was
testing them. `sonde` deliberately does the opposite: this suite is only useful if strangers run it
on their own devices and compare reports, and an unmemorable name is one nobody passes on. The
anonymity was traded for citability, knowingly.

## 2026-09-18 — moving off `caniusethis.dot`

`caniusethis.dot` belongs to `0xFF54…333f` (the owner above), which is not the account `pad` now signs
with, so the SDK-bumped build (product-sdk 0.29, truapi 0.17) cannot be linked there. Publish under a
new label with the guarded script:

```bash
npx @polkadot-community-foundation/polkadot-app-deploy@0.16.6 login --env devnet   # phone QR, once
npm run whois -- <label>                        # read-only: owner, pad's rule, price
npm run deploy -- <label> --register            # first publish of an unowned label
npm run deploy -- <label>                       # every republish after that
```

`tools/deploy.mjs` shows the signed-in account, refuses an unowned label without `--register`, asks
before publishing to a label owned by an address `whoami` did not print, rewrites `PRODUCT_ID` to the
label, then runs verify → build → check-identity → leak grep → `pad`. `tools/whois.mjs` is almanac's
eth_call-only lookup — prefer it to `whoowns.sh`, which races a kill against a real registration.

## 2026-09-18 (evening) — back to `caniusethis.dot`: it was yours all along

**Correction to the two sections below.** `caniusethis.dot` was never owned by another account. Its
owner, `0xFF54…333f`, is **pad's product account #0** (productId `polkadot-app-deploy`, index 0)
derived from the signed-in root `5DoMJ…TLT43` — the account the phone actually signs as (82
transactions, 5000 PAS). pad's `whoami` printed the *root* (`0xF4f4…fCbB`) because the wallet never
returned the product key within 25 s ("Product address: unresolved"), and that display is what made
the name look foreign.

The same fallback stranded `sondeprobe.dot`: its first publish handed the name to the root, which the
phone never signs as, so both republishes reverted at *Link content* with `Revive.ContractReverted`.
Measured, not inferred: from `0xFF54…`, `setContenthash` simulates **successfully on
`caniusethis.dot`** and **reverts on `sondeprobe.dot`**; from the root it succeeds on `sondeprobe.dot`,
and the root's nonce is 0. Both pinned-SDK uploads finalised on Bulletin
(`bafybeifaisnvfmhclueddj2bfevsup6exvrm6icdz5mrymruffe5pj4tnm`, then
`bafybeiepri3fufexoygywerz3qvttsau6yl44vf5qrlnbjpkmogej55yvm`); neither is linked.

**So sonde publishes to `caniusethis.dot` again**: `npm run deploy -- caniusethis`. `sondeprobe.dot`
stays registered to the root and pointed at the codec-2 build of 15:45 UTC until something can sign as
the root.

`tools/deploy.mjs` now derives the signing account from the root rather than trusting pad's display: it
accepts a label owned by that product account, refuses one owned by the root (it would revert), and
refuses `--register` while whoami says the product address is unresolved (pad would hand the new name
to the root).

## 2026-09-18 — `sondeprobe.dot`, and why the SDK is pinned back

`sondeprobe.dot` was registered and published on 2026-09-18 by `npm run deploy -- sondeprobe
--register` (CID and transactions not recorded here — add them from the deploy output). Its first
run on a Pixel 10 Pro XL (run `9610281f…`, 16:17 UTC) failed **every host probe** at the handshake:

```
TrUAPI handshake timed out after 10000ms; the host did not answer on wire codec 2
```

`@parity/truapi` changed its wire codec from **1 to 2 in 0.16.0** (2026-09-14). `product-sdk-host`
0.20.0 and 0.21.0 depend on it; **0.19.1 is the last release on codec 1** (truapi 0.13.1), and it is
what almanac's probe used on the same phone that week, with every host call answered. The Polkadot
app on that phone speaks codec 1 only — Parity published the SDK ahead of an app that can answer it.

So the dependencies are pinned **exactly** (`--save-exact`) to the codec-1 set: `product-sdk`
0.27.0, `-host` 0.19.1, `truapi` 0.13.1, `-statement-store` 0.6.9, `-terminal` 0.8.2. **Do not bump
them until an app release answers codec 2** — re-run `host.system.handshake` after any bump; a
timeout there means every host probe will skip. This build needs republishing:
`npm run deploy -- sondeprobe`.

The web half of that run still stands: `web.sensors.geolocation` came back `host-callback-missing`
(denied, permission still `prompt`) — issue #7 is unchanged on the September app.

## Deployment record

### 2026-08-03 — initial publish

| | |
|---|---|
| CID | `bafybeibdraaccqo5wpgwlgk4mtjqcyfw5fghybz65mhfcoxdwhshzxxemi` |
| Payload | 6.71 MB, 10 chunks (0.9 MB uploaded — 6.1 MB already on chain) |
| Cost | 11 PAS (oracle price 10) |
| P2P retrieval | ✓ 163 ms |

| Step | Tx | Block |
|---|---|---|
| Storage upload | `0xd035e4a01a488d5a18b3f613cafecf04e536d0ab1f55137fd9023f4b9e6e7c1a` | 354309 |
| Commitment | `0xb0fe307c8604f4448370514a69b30e1bfc068ace12c984f9af696aee603d4cab` | — |
| Register | `0x6854fc6d4aebf423fe1f81e95ea2fcdc06d710e6801b719a3e0c041192741b34` | 11782792 |
| Set contenthash | `0x6ca20c2e4464f0c9b845a621df42c8efe7cfcc0c4cec481da02a61a5307e19a7` | 11782806 |
| Hand to signed-in account | `0xf0121c80e6fad054159cdb2b2a4813cc864969b27cda4ec372e03ec536698da1` | — |

**This publish carries `PRODUCT_ID = "caniuse"` while the label is `caniusethis`.** The bundle is
therefore wrong and Bank B will report a confident "no" for every allowance lookup until it is
republished. See "Outstanding" below.

## Names registered by accident

Three labels were registered unintentionally while probing which names DotNS would accept, at
11 PAS each (33 PAS total):

- `neversettled.dot`
- `caniuseprobe.dot`
- `caniusexx00.dot`

All are owned by `0xff54a5a1fdac91bb4f2b4fbf4bfff37cdbea333f`.

**The cause, so it is not repeated:** `pad` has no read-only "is this name available" query. Its
preflight *does* print the tier requirement — but preflight is not a stopping point. For a name the
signer is *not* eligible for it aborts, which is what made the check look safe when tested against
`caniuse.dot` (which requires `ProofOfPersonhoodFull`). For an *eligible* name preflight passes and
the deploy proceeds straight through to registration. Running `pad` in a loop over candidate names
therefore registers every one it is allowed to.

`tools/whoowns.sh` exists to make this checkable safely: it starts a deploy against an empty
directory, reads preflight, and kills the process the moment ownership is resolved — before the
"Registering" step. Use it instead of running `pad` speculatively.

DotNS documents `NoStatus` registrations as carrying a **refundable deposit**, so the 33 PAS may be
recoverable by releasing the names. `pad` exposes no release subcommand (`deploy`, `login`,
`logout`, `whoami`, `transfer` only), so that would need the DotNS contract directly.

## Outstanding

- **Republish with the corrected `PRODUCT_ID`.** `product.mjs` and `dist/` are already fixed and
  `npm run check-identity caniusethis.dot` passes; only the on-chain contenthash is stale.
  Republishing needs a phone signature (see below), so it must be run interactively:

  ```bash
  npm run deploy --domain=caniusethis.dot
  ```

- **Consider releasing the three accidental names** to recover their deposits.

## The PRODUCT_ID invariant

`PRODUCT_ID` in `product.mjs` **must** equal the DotNS label. The host derives product accounts and
the local-storage namespace from it, and allowances are looked up per product. If the two drift
apart, every Bank B probe exercises an identity that never published anything and reports a
confident "no" — not an error, which is what makes it dangerous. `npm run check-identity` enforces
this, and also refuses a `dist/` that was not rebuilt after `product.mjs` changed.

If you fork this to probe something you would rather not be seen probing, use an anonymous label
instead:

```bash
python3 -c "import secrets,string;print(''.join(secrets.choice(string.ascii_lowercase) for _ in range(32)))"
```

## Before every publish

```bash
npm run verify                                  # the fail-safe contract — 39 checks
npm run build                                   # typecheck + bundle
npm run check-identity caniusethis.dot --env devnet   # PRODUCT_ID == label, and the bundle is fresh
grep -oiE "\bfare\b|docs/|§" dist/assets/index-*.js  # no upstream paths in a public bundle
# Word-boundaried on purpose: an unanchored "fare" matches "warfare" in a dependency's
# BIP-39 wordlist and reports a leak on every clean build.
```

`check-identity` is not optional either. It exists because the invariant it enforces was violated on
the first publish: a bundle built as `caniuse` was deployed to `caniusethis.dot`. Nothing in the
deploy output or the UI reveals that drift — every Bank B probe simply reports a confident "no".

`verify` is not optional. The suite's central claim is that every probe has a safe exit; publishing
a build where that is untrue produces reports that are quietly wrong.

## Publishing

```bash
npm run deploy --domain=caniusethis.dot     # runs check-identity first, then pad
```

or directly, once you have run the identity check yourself:

```bash
npx @polkadot-community-foundation/polkadot-app-deploy@latest \
    ./dist caniusethis.dot --env devnet --js-merkle
```

## Checking a name without registering it

```bash
tools/whoowns.sh <label> --env devnet
```

**Never point `pad` at a name to "see what happens".** For a name your signer is eligible for,
preflight passes and it registers — 11 PAS, on-chain, per name.

Registration cost `kite` 11 PAS (oracle price 10), classified `NoStatus` by PopOracle — available
to all, no personhood required at that tier, refundable deposit. Registration is not instant: `pad`
waits out a commit-reveal maturity window (~6 s of chain progress plus a ~3 s propagation buffer)
before it can finalize.

## Republishing needs your phone — the first publish does not

The first publish registers the name with a local worker and then **hands it to the signed-in
account**. From then on you own it, so updating the contenthash is a transaction only you can sign:

```
You already own <name>.dot — updating its content needs your signature.
Check your phone → Link content
Press Y when ready (Ctrl-C to abort):
```

There is no non-interactive path. `--mnemonic` signs as a worker that no longer owns the name,
`--no-transfer-to-signedin-user` only changes who registers a *new* one, and there is no
`-y`/`--yes`. **Run republishes in an interactive terminal.**

Two ways this fails in automation, both leaving the upload done and only the link missing:

- **stdin closed** → the prompt reads EOF → `Deployment failed: aborted by user`.
- **`yes | pad …`** → `No signature received from the phone`. Pressing Y does not raise the phone
  prompt; it asserts *"I have already approved"* and makes `pad` go collect a signature. Answering
  it early guarantees there is nothing to collect.

Uploads are incremental and content-addressed, so an aborted link is cheap to retry.

## The gateway serves a loader, not the bundle

`curl` on the `dev-dot.li` gateway returns Parity's client-side loader, not this app's HTML — the
bundle is fetched from Bulletin into a sandboxed iframe. That is not a failure. `P2P retrieval: ✓`
in the deploy output is the real confirmation.

This also **is** the gateway surface: sandboxed, no host API, subject to the embedder's
Permissions-Policy. `web.net.permissionsPolicy` reads that policy directly, which is the fastest
way to see what the embedder has withheld.

## Bulletin retention is ~2 weeks

A published `sonde` decays. Either renew, or treat each publish as a dated snapshot — the report
footer carries the build id, so an old report stays interpretable even after the bundle stops
resolving.

## Collecting the three surfaces

```bash
# 1. plain browser — automated
npm run headless -- sonde-plain.report.json --tier 1

# 2. gateway iframe — open the dev-dot.li URL in mobile Chrome, Run all, Download JSON
# 3. Polkadot App    — open the .dot label in the app, Run all, Download JSON

npm run diff -- sonde-plain.report.json sonde-inapp.report.json --md
```

Vary one thing at a time. The diff tool flags when both the environment and the results moved,
because a comparison where two variables changed cannot attribute the difference to either.

### What to expect

`web.sensors.geolocation` is the row to watch. In a plain browser it passes (or is `os-denied` if
you refuse the prompt). In the Polkadot App, `kite` observed it denied with the permission left at
`prompt` — the signature of a host that never answered the callback, which the runner now diagnoses
as `host-callback-missing` automatically.

**Run `host.permissions.location` first.** `BUG-geolocation.md` states the SDK exposes no location
capability, but `requestDevicePermission("Location")` is declared in truapi's types. If it grants
and geolocation then works, that issue is misfiled and should be reclassified before a maintainer
starts on the WebView.

## Tier 3

`SPEND_ALLOWED_GENESIS` in `product.mjs` ships **empty**, so every spend probe refuses on a fresh
checkout. Add a genesis hash only after confirming it is a chain you are willing to spend on.
Mainnet hashes are refused unconditionally and by name, whatever the allowlist says.
