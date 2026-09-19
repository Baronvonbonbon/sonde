// Bank B, ordered.
//
// Mirrors the fifteen namespaces of @parity/truapi's generated client so that a
// coverage gap is visible against the type rather than hidden in prose:
//
//   account · chain · chat · coinPayment · entropy · localStorage ·
//   notifications · payment · permissions · preimage · resourceAllocation ·
//   signing · statementStore · system · theme
//
// Ordering rules: detection before invocation, reads before writes, and every
// T3 spend probe last within its group.

import type { Probe } from "../../core/types";
import { SYSTEM_PROBES } from "./system";
import { PERMISSION_PROBES } from "./permissions";
import { ACCOUNT_PROBES } from "./account";
import { SERVICE_PROBES } from "./services";
import { CLOUD_PROBES } from "./storage";
import { LIMIT_PROBES, RETENTION_PROBES } from "./limits";
import { GAS_PROBES } from "./gas";

export const HOST_PROBES: Probe[] = [
  // system first: container detection and the handshake gate everything else.
  ...SYSTEM_PROBES,
  // Read-only namespace coverage, cheapest first.
  ...SERVICE_PROBES,
  ...ACCOUNT_PROBES,
  // Retention reads earlier runs' uploads before this run adds any.
  ...RETENTION_PROBES,
  // Storage, ending in the two T3 writes.
  ...CLOUD_PROBES,
  // Gas and tap-free signing: what a Product can do on-chain without a relay.
  ...GAS_PROBES,
  // Limits: how far each host service goes. The quota-exhausting ones are opt-in.
  ...LIMIT_PROBES,
  // Permissions last of the host bank: every one of these raises a prompt, and
  // several leave grants behind that would change how the probes above behave.
  ...PERMISSION_PROBES,
];
