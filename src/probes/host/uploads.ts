// What sonde has stored on Bulletin, remembered across runs.
//
// Retention can only be measured by coming back later. Each upload probe appends
// the key it got back; host.limits.retention reads the list at the start of the
// next run and looks every key up again. The list lives in host local storage,
// namespaced by product id, so it survives restarts and new builds (almanac P1)
// and belongs to this .dot name only.

import { getHostLocalStorage } from "@parity/product-sdk-host";

export interface Upload {
  /** 0x-prefixed BLAKE2b-256 key returned by preimage submit. */
  key: string;
  bytes: number;
  /** ISO time of the upload. */
  at: string;
  /** The probe that stored it. */
  via: string;
}

const KEY = "sonde.uploads";
/** Enough history to see expiry at two weeks without growing without bound. */
const KEEP = 40;

export async function listUploads(): Promise<Upload[]> {
  const store = await getHostLocalStorage();
  if (!store) return [];
  try {
    const v = (await store.readJSON(KEY)) as Upload[] | undefined;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function rememberUpload(u: Upload): Promise<void> {
  const store = await getHostLocalStorage();
  if (!store) return;
  const all = [...(await listUploads()), u].slice(-KEEP);
  await store.writeJSON(KEY, all);
}
