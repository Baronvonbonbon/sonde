# Deploying sonde

## Identity

| | |
|---|---|
| DotNS label | `beganmwyxujwkjlxqqixodhpczpoeuqv.dot` |
| Environment | `devnet` |
| Gateway | `https://beganmwyxujwkjlxqqixodhpczpoeuqv.dev-dot.li` |

The label is deliberately random, for the same reason `kite`'s was: a `.dot` address is public, and a
readable one announces what is being tested and for whom before any answer is in. A compatibility
report is meant to be shared; who commissioned it is not.

`PRODUCT_ID` in `product.mjs` **must** equal the DotNS label. The host derives product accounts and
the local-storage namespace from it, and allowances are looked up per product. If the two drift
apart, every Bank B probe exercises an identity that never published anything and reports a
confident "no".

Regenerate with:

```bash
python3 -c "import secrets,string;print(''.join(secrets.choice(string.ascii_lowercase) for _ in range(32)))"
```

## Before every publish

```bash
npm run verify                       # the fail-safe contract — 39 checks
npm run build                        # typecheck + bundle
grep -oiE "\bfare\b|docs/|§" dist/assets/index-*.js   # no upstream paths in a public bundle
# Word-boundaried on purpose: an unanchored "fare" matches "warfare" in a dependency's
# BIP-39 wordlist and reports a leak on every clean build.
```

`verify` is not optional. The suite's central claim is that every probe has a safe exit; publishing
a build where that is untrue produces reports that are quietly wrong.

## Publishing

```bash
npx @polkadot-community-foundation/polkadot-app-deploy@latest \
    ./dist beganmwyxujwkjlxqqixodhpczpoeuqv.dot --env devnet --js-merkle
```

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
