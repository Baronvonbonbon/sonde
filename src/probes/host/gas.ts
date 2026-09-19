// truapi `resourceAllocation` — gas for contract calls, and signing without a tap.
//
// Two questions decide whether a Product can run on-chain actions without a
// relay paying its gas:
//
//  - SmartContractAllowance(index): truapi calls it "pre-warmed PGAS balance
//    for the product account at this derivation index". PGAS is the testnet
//    pay-gas asset (Assets id 2000000000 on Paseo Asset Hub and Asset Hub
//    Next), minted by an unsigned `Pgas.claim_pgas(slot, target)` that a
//    ring-VRF personhood proof authorizes. Does the host grant it, and does a
//    balance appear?
//  - AutoSigning: the SDK's docs say NotAvailable on both mobile wallets. If
//    that holds, every host-signed transaction is a tap. Measured, not assumed.

import {
  getAccountsProvider,
  requestResourceAllocation,
  formatHostError,
  toHex,
} from "@parity/product-sdk-host";
import type { App } from "@parity/product-sdk";
import { blake2b } from "@noble/hashes/blake2b";
import { TIER, type Probe } from "../../core/types";
import { errText, lines, nt, ok, pad, probe, unsupported, wrong } from "../helpers";
import { PRODUCT_ID } from "../../../product.mjs";

const CAT = "gas";
const host = (p: Omit<Probe, "bank" | "category">): Probe => probe({ ...p, bank: "host", category: CAT });

/** A derivation index kept for this probe, so account #0 stays untouched. */
const GAS_INDEX = 5;

/** twox128("Assets") ++ twox128("Account") ++ blake2_128concat(u32 2000000000). */
const PGAS_ACCOUNT_PREFIX =
  "0x682a59d51ab9e48a8c8cc418ff9708d2b99d880ec681799c0cf30e8886371da946de6e688c2258c9eb90a9b5c834b13d00943577";

const CHAINS: [string, string][] = [
  ["Paseo Asset Hub", "https://asset-hub-paseo-rpc.n.dwellir.com"],
  ["Paseo Asset Hub Next", "https://paseo-asset-hub-next-rpc.polkadot.io"],
];

function pgasKey(accountId: Uint8Array): string {
  const h = blake2b(accountId, { dkLen: 16 });
  return PGAS_ACCOUNT_PREFIX + toHex(h).slice(2) + toHex(accountId).slice(2);
}

/** Raw PGAS units held, 0n when the account has none, null when the chain didn't answer. */
async function pgasBalance(url: string, accountId: Uint8Array, signal: AbortSignal): Promise<bigint | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state_getStorage", params: [pgasKey(accountId)] }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    const { result } = (await res.json()) as { result: string | null };
    if (!result) return 0n;
    // AssetAccount starts with the balance, a little-endian u128.
    const le = result.slice(2, 34).match(/../g)!.reverse().join("");
    return BigInt("0x" + le);
  } catch {
    return null;
  }
}

async function balances(accountId: Uint8Array, signal: AbortSignal): Promise<(bigint | null)[]> {
  return Promise.all(CHAINS.map(([, url]) => pgasBalance(url, accountId, signal)));
}

const show = (b: bigint | null) => (b === null ? "no answer" : `${b} raw`);

const smartContractAllowance = host({
  id: "host.gas.smartContractAllowance",
  title: "Smart-contract gas allowance (PGAS)",
  why: "If the host funds a product account with PGAS, contract calls need no relay and no PAS. Whether it asks, what it returns, and whether a balance appears decide how a Product pays gas on testnet.",
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["host.system.handshake"],
  timeoutMs: 150_000,
  async run(ctx) {
    const provider = await getAccountsProvider();
    if (!provider) return unsupported("getAccountsProvider() returned null.");
    const acct = await nt(provider.getProductAccount(PRODUCT_ID, GAS_INDEX));
    if (!acct.ok) return wrong(`No product account at index ${GAS_INDEX}: ${errText(acct.error)}`);
    const id = (acct.value as { publicKey: Uint8Array }).publicKey;

    const rows: string[] = [pad("account", `product #${GAS_INDEX} ${toHex(id)}`)];
    const before = await balances(id, ctx.signal);
    CHAINS.forEach(([name], i) => rows.push(pad(`before · ${name}`, show(before[i]))));

    const t0 = performance.now();
    const r = await requestResourceAllocation([{ tag: "SmartContractAllowance", value: GAS_INDEX } as never]).catch(
      (e) => ({ ok: false as const, error: e }),
    );
    const askMs = Math.round(performance.now() - t0);
    const said = r.ok ? JSON.stringify(r.value) : `error — ${formatHostError(r.error as never)}`;
    rows.push(pad("allocation", `${said} (${askMs} ms)`));

    // "Pre-allocation is opportunistic": a balance may take a block or two, or
    // only appear on first use. Look a few times before calling it absent.
    let after = before;
    for (let i = 0; i < 4; i++) {
      await new Promise((res) => setTimeout(res, 6_000));
      after = await balances(id, ctx.signal);
      if (after.some((b, j) => b !== null && b !== before[j])) break;
    }
    CHAINS.forEach(([name], i) => rows.push(pad(`after · ${name}`, show(after[i]))));

    const allocated = r.ok && Array.isArray(r.value) && (r.value as unknown[]).every((o) => o === "Allocated");
    const grew = after.findIndex((b, j) => b !== null && before[j] !== null && b > before[j]!);
    const measures = {
      allocated,
      askMs,
      pgasBefore_paseo: String(before[0] ?? "none"),
      pgasAfter_paseo: String(after[0] ?? "none"),
      pgasBefore_next: String(before[1] ?? "none"),
      pgasAfter_next: String(after[1] ?? "none"),
    };
    if (!r.ok) return { status: "fail", detail: `The request errored: ${said}`, data: lines(...rows), measures };
    if (grew >= 0)
      return { ...ok(`Allocated, and PGAS arrived on ${CHAINS[grew][0]}.`, lines(...rows)), measures };
    if (allocated)
      return {
        ...ok("Allocated, but no PGAS balance appeared within 24 s. It may only be minted on first use.", lines(...rows)),
        measures,
      };
    return { ...wrong(`The host answered ${said}, not "Allocated".`, lines(...rows)), measures };
  },
});

const autoSigning = host({
  id: "host.gas.autoSigning",
  title: "AutoSigning — signing without a tap",
  why: "The SDK's docs say AutoSigning is NotAvailable on mobile. If so, every host-signed transaction is a tap, and nothing host-signed can run in the background. This asks for it, then times a signature.",
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["host.account.connect"],
  timeoutMs: 150_000,
  async run(ctx) {
    const app = ctx.shared.app as App | undefined;
    if (!app) return unsupported("No App available.");

    const t0 = performance.now();
    const r = await requestResourceAllocation([{ tag: "AutoSigning", value: undefined } as never]).catch(
      (e) => ({ ok: false as const, error: e }),
    );
    const askMs = Math.round(performance.now() - t0);
    const said = r.ok ? JSON.stringify(r.value) : `error — ${formatHostError(r.error as never)}`;
    const granted = r.ok && Array.isArray(r.value) && (r.value as unknown[]).every((o) => o === "Allocated");
    const rows = [pad("allocation", `${said} (${askMs} ms)`)];

    // A signature that comes back in well under a second had no prompt a human answered.
    const t1 = performance.now();
    const sig = await app.wallet.signMessage(`sonde autosign ${new Date().toISOString()}`).catch(() => null);
    const signMs = Math.round(performance.now() - t1);
    rows.push(pad("signMessage", sig?.length ? `${sig.length} bytes in ${signMs} ms` : `no signature (${signMs} ms)`));
    const silent = !!sig?.length && signMs < 800;
    rows.push(pad("prompt shown?", silent ? "no — too fast for a tap" : "probably — note whether one appeared"));

    const measures = { granted, askMs, signMs, silent };
    if (granted && silent) return { ...ok("AutoSigning granted: a signature came back with no tap.", lines(...rows)), measures };
    if (granted) return { ...ok("AutoSigning reported as allocated, but signing still took a tap's time.", lines(...rows)), measures };
    return {
      status: "unsupported",
      detail: `AutoSigning not granted (${said}). Every host-signed transaction needs a tap.`,
      diagnosis: "not-implemented",
      data: lines(...rows),
      measures,
    };
  },
});

export const GAS_PROBES: Probe[] = [smartContractAllowance, autoSigning];
