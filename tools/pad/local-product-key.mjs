// Loaded with `node --import` (via NODE_OPTIONS, so pad's own relaunches inherit it).
//
// pad asks the wallet for the product *subtree* key and derives the product account from it. The
// Polkadot app on the user's phone never answers that request (2026-09-18: 25 s timeout every time,
// no prompt), so pad falls back to the ROOT — and then refuses names the real signer owns and
// accepts ones whose update reverts (DEPLOY.md). The same account derives from the root's public key
// alone, and that derivation was checked against the chain: for root 5DoMJ…TLT43 it gives
// 0xFF54…333f, the owner of caniusethis.dot and the account the phone's signatures come from.
//
// This swaps only pad's `deriveProductPublicKey` for that local derivation. Signing is untouched:
// every transaction still goes to the phone.
import { register } from "node:module";

register("./local-product-key.hooks.mjs", import.meta.url);
