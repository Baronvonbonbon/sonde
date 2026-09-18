// Module hooks for local-product-key.mjs: when pad imports @parity/product-sdk-terminal, hand it a
// module that re-exports everything from the real one and overrides deriveProductPublicKey.
const SHIM = "sonde-pad-shim:terminal";

export async function resolve(specifier, context, next) {
  if (specifier === "@parity/product-sdk-terminal" && context.parentURL?.includes("/polkadot-app-deploy/")) {
    const real = await next(specifier, context);
    // sonde's own product-sdk-keys, resolved from this file (import.meta.resolve is not available here).
    const keys = await next("@parity/product-sdk-keys", { ...context, parentURL: import.meta.url });
    const q = new URLSearchParams({ real: real.url, keys: keys.url });
    return { url: `${SHIM}?${q}`, format: "module", shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.startsWith(SHIM)) return next(url, context);
  const q = new URL(url).searchParams;
  const real = q.get("real");
  // deriveProductAccountPublicKey(parentPublicKey, productId, index) — product-sdk-keys 0.3.x.
  const keys = q.get("keys");
  const source = `
export * from ${JSON.stringify(real)};
import { sessionRootPublicKey } from ${JSON.stringify(real)};
import { deriveProductAccountPublicKey } from ${JSON.stringify(keys)};
export async function deriveProductPublicKey(session, ref) {
  return deriveProductAccountPublicKey(sessionRootPublicKey(session), ref.productId, ref.derivationIndex);
}
`;
  return { format: "module", source, shortCircuit: true };
}
