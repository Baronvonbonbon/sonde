// The single ordered registry.
//
// Order is load-bearing in three ways:
//
//   1. Cheap and unattended first. An operator who loses patience halfway
//      through still has the whole detection layer journalled.
//   2. A probe's `needs` must appear before it. The runner validates the graph
//      at construction and refuses a manifest that cannot be satisfied.
//   3. crashRisk: "high" probes go last within their bank, so a renderer death
//      costs the fewest results.

import type { Probe } from "../core/types";
import { FIXTURES } from "./fixtures";

import { PLATFORM_PROBES } from "./web/platform";
import { COMPUTE_PROBES } from "./web/compute";
import { STORAGE_PROBES } from "./web/storage";
import { NET_PROBES } from "./web/net";
import { FILESYSTEM_PROBES } from "./web/filesystem";
import { SENSOR_PROBES } from "./web/sensors";
import { MEDIA_PROBES } from "./web/media";
import { UX_PROBES } from "./web/ux";
import { IDENTITY_PROBES } from "./web/identity";
import { CONNECTIVITY_PROBES } from "./web/connectivity";
import { GRAPHICS_PROBES } from "./web/graphics";

import { HOST_PROBES } from "./host";

export interface ManifestOptions {
  /** Include the pathological probes that test the runner rather than the runtime. */
  fixtures?: boolean;
}

export function manifest(opts: ManifestOptions = {}): Probe[] {
  const probes: Probe[] = [
    // Bank B first: host detection establishes the surface, and several Bank A
    // probes read better once it is known whether a host API is present at all.
    ...HOST_PROBES,

    // Bank A, cheapest and least invasive first.
    ...PLATFORM_PROBES,
    ...COMPUTE_PROBES,
    ...STORAGE_PROBES,
    ...NET_PROBES,
    ...FILESYSTEM_PROBES,
    ...SENSOR_PROBES,
    ...MEDIA_PROBES,
    ...UX_PROBES,
    ...IDENTITY_PROBES,
    ...CONNECTIVITY_PROBES,
    // Last: WebGPU lives here and is the likeliest thing to take the page down.
    ...GRAPHICS_PROBES,
  ];

  if (opts.fixtures) probes.unshift(...FIXTURES);

  assertUniqueIds(probes);
  return probes;
}

/**
 * Duplicate ids would silently overwrite each other in the results map and in
 * the journal, so a report would quietly lose a probe. Cheap to check, and the
 * failure it prevents is invisible.
 */
function assertUniqueIds(probes: Probe[]): void {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const p of probes) {
    if (seen.has(p.id)) dupes.push(p.id);
    seen.add(p.id);
  }
  if (dupes.length) throw new Error(`sonde: duplicate probe id(s): ${dupes.join(", ")}`);
}
