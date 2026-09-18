#!/usr/bin/env node
// Read-only DotNS lookup: who owns <label>.dot, and who may register it.
//
// Only eth_call — nothing is signed or sent. `pad` has no read-only ownership query and registers any
// eligible name it is pointed at, and sonde's whoowns.sh races a kill against that registration.
// This never starts a deploy at all.
//
// Two answers are printed for eligibility, because they disagree:
//   pad    — pad's own label rule (classifyLabelStatus in pad 0.16.1). pad refuses before touching the
//            chain, so this is the rule that binds when publishing with pad.
//   chain  — PopRules.priceWithCheckAtVersion, the DotNS v2 on-chain check.
// On 2026-09-11 the chain said almanac01 was "Available to all" for a NoStatus signer and pad refused
// it as Personhood Lite. The first version of this tool read only the chain, and was wrong.
//
// Addresses are the devnet entry in pad 0.16.1's environments.json. They moved in the 2026-09-08
// devnet update and can move again: if every label reads as unowned, check them first.
//
// Usage:  node tools/whois.mjs [--signer 0xH160] <label> [label…]

import { ethers } from "ethers";

const RPC = "https://eth-rpc-testnet.polkadot.io/"; // Paseo Asset Hub, chain id 420420417
const REGISTRAR = "0x0E05e0E2576DDD1C339d360Aa634fE52CBa7Ee45"; // DOTNS_REGISTRAR — ERC-721, tokenId = namehash(label.dot)
const POP_RULES = "0xB991Bc0C5Ff4B4c7f3634bfC74e0E20F74D59554";

const registrar = new ethers.Interface(["function ownerOf(uint256 tokenId) view returns (address)"]);
const popRules = new ethers.Interface([
  "function pricingVersion() view returns (uint256)",
  "function priceWithCheckAtVersion(string name, address userAddress, uint256 version) view returns ((uint256 price, uint8 status, uint8 userStatus, string message) metadata)",
  "function isBaseNameReserved(string name) view returns (bool isReserved, address reservationOwner, uint64 expiryTimestamp)",
]);

/** pad 0.16.1 classifyLabelStatus: what pad demands of the signer before it will register a label. */
function padRule(label) {
  const digits = label.match(/\d*$/)[0].length;
  const base = label.length - digits;
  if (digits === 1 || digits > 2 || base <= 5) return "reserved — pad will not register it";
  if (base <= 8) return digits === 2 ? "Personhood Lite" : "Personhood Full";
  return "any account";
}

const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });

// Encode through an Interface explicitly: Contract.getAddress() and friends are ethers built-ins that
// shadow ABI functions of the same name (broadside/docs/DEPLOY.md).
async function view(to, iface, fn, args) {
  try {
    const data = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
    return { ok: true, value: iface.decodeFunctionResult(fn, data) };
  } catch (e) {
    return { ok: false, error: e.shortMessage ?? e.message };
  }
}

const args = process.argv.slice(2);
let signer = ethers.ZeroAddress;
const labels = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--signer") signer = ethers.getAddress(args[++i]);
  else labels.push(args[i]);
}
if (!labels.length) {
  console.error("usage: node tools/whois.mjs [--signer 0xH160] <label> [label…]");
  process.exit(2);
}

const { chainId } = await provider.getNetwork();
if (chainId !== 420420417n) {
  console.error(`refusing: ${RPC} reports chain ${chainId}, expected 420420417`);
  process.exit(1);
}
const version = await view(POP_RULES, popRules, "pricingVersion", []);

for (const label of labels) {
  const [owner, check, reservation] = await Promise.all([
    view(REGISTRAR, registrar, "ownerOf", [BigInt(ethers.namehash(`${label}.dot`))]),
    version.ok
      ? view(POP_RULES, popRules, "priceWithCheckAtVersion", [label, signer, version.value[0]])
      : Promise.resolve({ ok: false, error: `pricingVersion: ${version.error}` }),
    view(POP_RULES, popRules, "isBaseNameReserved", [label]),
  ]);
  const m = check.ok ? check.value[0] : null;
  console.log(`${label}.dot`);
  // ownerOf reverts for a token that was never minted — that is "unowned", not an error.
  console.log(`  owner     ${owner.ok ? owner.value[0] : "none"}`);
  console.log(`  pad       ${padRule(label)}`);
  console.log(
    `  chain     ${m ? `${m.message} (required ${m.status}, signer ${m.userStatus}), price ${ethers.formatUnits(m.price, 18)} PAS` : `? (${check.error})`}`,
  );
  console.log(
    `  reserved  ${
      !reservation.ok
        ? `? (${reservation.error})`
        : reservation.value[0]
          ? `yes, by ${reservation.value[1]} until ${new Date(Number(reservation.value[2]) * 1000).toISOString()}`
          : "no"
    }`,
  );
}
