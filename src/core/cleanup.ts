// Guaranteed teardown.
//
// Probes register cleanup AT ACQUISITION TIME, not in a `finally` — a `finally`
// inside a probe does not run when the runner times the probe out and walks
// away from its promise. This registry is drained by the runner regardless of
// how the probe ended, including when it never ended at all.

import { CLEANUP_BUDGET_MS } from "./types";

interface Task {
  label: string;
  fn: () => unknown | Promise<unknown>;
  registered: number;
}

export interface DrainResult {
  /** Handles that threw or ran past the budget. Reported, never fatal. */
  leaked: string[];
}

export class CleanupRegistry {
  private tasks: Task[] = [];

  /**
   * @param label Names the resource in the leak report. "camera-stream",
   *   "bt-device:forget". Be specific — this string is what a reader sees when
   *   the runtime is left in a bad state.
   */
  add(label: string, fn: () => unknown | Promise<unknown>): void {
    this.tasks.push({ label, fn, registered: performance.now() });
  }

  /**
   * Run every registered teardown, most recent first, within a total budget.
   *
   * LIFO because acquisition nests: a probe that opens a device and then starts
   * a stream on it must stop the stream before closing the device.
   *
   * The budget covers the whole set rather than each task, because the failure
   * mode that matters is one hung `release()` blocking the other nineteen.
   * Everything is started, then the set is raced as a whole; whatever has not
   * settled when the budget expires is reported as leaked and abandoned.
   */
  async drain(budgetMs = CLEANUP_BUDGET_MS): Promise<DrainResult> {
    const tasks = this.tasks.slice().reverse();
    this.tasks = [];
    if (tasks.length === 0) return { leaked: [] };

    const settled = new Set<string>();
    const leaked: string[] = [];

    const runs = tasks.map(async (t) => {
      try {
        await t.fn();
        settled.add(t.label);
      } catch (e) {
        // A teardown that throws has still released whatever it could. Note it
        // and move on — cleanup must never cascade into the suite.
        leaked.push(`${t.label} (threw: ${errText(e)})`);
        settled.add(t.label);
      }
    });

    await Promise.race([
      Promise.all(runs),
      new Promise((r) => setTimeout(r, budgetMs)),
    ]);

    for (const t of tasks) {
      if (!settled.has(t.label)) leaked.push(`${t.label} (still running after ${budgetMs}ms)`);
    }
    return { leaked };
  }

  /** Labels still awaiting teardown. Used by the UI's abort path. */
  pending(): string[] {
    return this.tasks.map((t) => t.label);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Teardown helpers for the resources that actually bite.
 *
 * Bluetooth, USB and Serial grants are the dangerous ones: `close()` releases
 * the connection but LEAVES the per-origin grant, which survives reload. The
 * second run of the suite then reports `pass` where a fresh device reports
 * `blocked` — a false negative in a compatibility matrix, and an invisible one.
 * `forget()` is the call that actually revokes. Prefer these wrappers over
 * hand-rolling, so no probe forgets which is which.
 */
export const teardown = {
  mediaStream(stream: MediaStream) {
    return () => stream.getTracks().forEach((t) => t.stop());
  },
  /** Bluetooth: disconnect the GATT server, then revoke the grant. */
  bluetooth(device: { gatt?: { connected: boolean; disconnect(): void }; forget?: () => Promise<void> }) {
    return async () => {
      if (device.gatt?.connected) device.gatt.disconnect();
      await device.forget?.();
    };
  },
  /** USB / Serial / HID: close the handle, then revoke the grant. */
  device(dev: { close?: () => Promise<void>; forget?: () => Promise<void> }) {
    return async () => {
      await dev.close?.().catch(() => {});
      await dev.forget?.();
    };
  },
  objectUrl(url: string) {
    return () => URL.revokeObjectURL(url);
  },
  element(el: Element) {
    return () => el.remove();
  },
  /** Anything exposing the host SDK's HostSubscription shape. */
  subscription(sub: { unsubscribe(): void }) {
    return () => sub.unsubscribe();
  },
  wakeLock(sentinel: { released: boolean; release(): Promise<void> }) {
    return async () => {
      if (!sentinel.released) await sentinel.release();
    };
  },
  fullscreen() {
    return async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    };
  },
  serviceWorker(reg: ServiceWorkerRegistration) {
    return () => reg.unregister();
  },
  indexedDb(name: string) {
    return () =>
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
  },
};
