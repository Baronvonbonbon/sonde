// The one place the published identity is written down.
//
// kite used a random 32-character label so that testing a platform's limits did
// not announce who was testing them or why. sonde deliberately does the
// opposite. The trade was made knowingly:
//
//   lost — anonymity. A readable name announces what is being tested before any
//          answer is in, and a .dot address is public forever.
//   won  — citability. This suite is only useful if strangers run it on their
//          own devices and compare reports. An unmemorable name is one nobody
//          passes on, and a compatibility matrix nobody re-runs is just an
//          anecdote with a schema.
//
// If you fork this to probe something you would rather not be seen probing,
// regenerate an anonymous label instead:
//   python3 -c "import secrets,string;print(''.join(secrets.choice(string.ascii_lowercase) for _ in range(32)))"
//
// PRODUCT_ID must equal the DotNS label: the host derives product accounts and
// the local-storage namespace from it, and `hasBulletinAllowance` /
// `hasStatementStoreAllowance` are looked up per product. If these two drift
// apart, the host probes silently exercise an identity that never published
// anything and report a confident "no".

export const PRODUCT_ID = "sondeprobes";
export const DOT_NAME = `${PRODUCT_ID}.dot`;

// Must equal the --env passed to `pad`. The SDK defaults cloud storage to
// "paseo"; publishing under devnet and leaving that defaulted asks the host for
// the paseo-bulletin chain, which a devnet host build does not carry — createApp
// then throws "Chain 0x8cfe6717… is not supported by the current host" and every
// storage probe downstream is skipped.
export const CLOUD_ENV = "devnet";

// Bumped whenever the probe set changes shape. The diff CLI uses this to tell
// "this probe regressed" from "this probe did not exist in the older report".
export const SUITE_VERSION = "1.0.0";

// Where the code that produced a report lives.
//
// Carried in the UI, in the JSON, and in the markdown, because a compatibility
// report is an assertion about someone else's software and the only honest way
// to make one is to let the reader check how it was measured. A probe that says
// "blocked" without showing what it called is a rumour.
export const SOURCE_URL = "https://github.com/Baronvonbonbon/sonde";

// ---------------------------------------------------------------------------
// The T3 fail-safe that is not a UI toggle.
//
// Tier 3 probes spend testnet funds and write to chain. A UI switch guards
// against inattention; this list guards against a misconfigured CLOUD_ENV,
// which product.mjs above documents as an easy mistake to make. Any T3 probe
// resolving a chain outside this set refuses to run, whatever the UI says.
export const SPEND_ALLOWED_GENESIS = [
  // The Products devnet chains, each read off its own RPC (chain_getBlockHash(0))
  // on 2026-09-19. Spending here costs testnet quota, nothing more. Any other
  // chain — mainnet, or one this list has never seen — is refused.
  "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22", // Paseo Bulletin Next
  "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48", // Paseo People Next
  "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a", // Paseo Asset Hub Next
  // Paseo Asset Hub, the public testnet. Added 2026-09-19: it is the only chain
  // the devnet host returned a spec for, so it is what host.chain.genesis
  // resolves, and without it every T3 probe was refused. Testnet; no real value.
  "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2", // Paseo Asset Hub
];

// Mainnet genesis hashes, listed explicitly so the refusal message can name the
// chain instead of saying "not in the allowlist".
export const MAINNET_GENESIS = {
  "0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3": "Polkadot",
  "0xb0a8d493285c2df73290dfb7e61f870f17b41801197a149ca93654499ea3dafe": "Kusama",
  "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f": "Polkadot Asset Hub",
  "0x9eb76c5184c4ab8679d2d5d819fdf90b9c001403e9e17da2e14b6d8aec4029c6": "Kusama Asset Hub",
};
