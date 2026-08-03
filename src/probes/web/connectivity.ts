// Radios and wires: Bluetooth, USB, Serial, HID, NFC.
//
// Every probe in this file is `sticky`. A granted device leaves a PERSISTENT
// per-origin grant that survives reload, so the second run of the suite reports
// `pass` where a fresh device reports `blocked` — a false negative, and an
// invisible one. `close()` does not revoke it; only `forget()` does. Each probe
// registers the revocation, and the report footer says to clear site data
// before re-running.

import { TIER, type Probe } from "../../core/types";
import { at, lines, ok, pad, probe, unsupported } from "../helpers";

const CAT = "connectivity";

const bluetooth = probe({
  id: "web.connectivity.bluetooth",
  title: "Web Bluetooth — device picker",
  why: "Hardware wallets and proximity attestation both need this. It is also a good test of whether the WebView forwards a chooser UI at all.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  sticky: true,
  permissions: ["bluetooth"],
  timeoutMs: 60_000,
  async run(ctx) {
    const bt = at("navigator.bluetooth") as
      | { requestDevice(o: object): Promise<{ id: string; name?: string; gatt?: { connected: boolean; disconnect(): void }; forget?(): Promise<void> }>; getAvailability?(): Promise<boolean> }
      | undefined;
    if (!bt) return unsupported("navigator.bluetooth is absent.");

    const available = (await bt.getAvailability?.()) ?? "not reported";
    const device = await bt.requestDevice({ acceptAllDevices: true, optionalServices: [] });

    // forget(), not just disconnect(). See the file header.
    ctx.cleanup.add("bluetooth-device", async () => {
      if (device.gatt?.connected) device.gatt.disconnect();
      await device.forget?.().catch(() => {});
    });

    return ok(
      `Picker returned a device.`,
      lines(
        pad("adapter available", available),
        pad("device name", device.name ?? "(unnamed)"),
        pad("forget() available", typeof device.forget === "function"),
        "",
        typeof device.forget === "function"
          ? "Grant revoked by cleanup."
          : "WARNING: forget() is unavailable, so the grant PERSISTS. Clear site data before re-running\nor the next run will report a pass it did not earn.",
      ),
    );
  },
});

const usb = probe({
  id: "web.connectivity.usb",
  title: "WebUSB — device picker",
  why: "The transport most hardware wallets use on desktop. On Android it needs both the API and an OTG-capable host, so a failure has two possible causes.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  sticky: true,
  timeoutMs: 60_000,
  async run(ctx) {
    const usb = at("navigator.usb") as
      | { requestDevice(o: object): Promise<{ productName?: string; manufacturerName?: string; vendorId: number; productId: number; close?(): Promise<void>; forget?(): Promise<void> }>; getDevices(): Promise<unknown[]> }
      | undefined;
    if (!usb) return unsupported("navigator.usb is absent.");

    const already = (await usb.getDevices()).length;
    const device = await usb.requestDevice({ filters: [] });
    ctx.cleanup.add("usb-device", async () => {
      await device.close?.().catch(() => {});
      await device.forget?.().catch(() => {});
    });

    return ok(
      `Picker returned ${device.productName ?? "a device"}.`,
      lines(
        pad("previously granted", already),
        pad("vendorId", `0x${device.vendorId.toString(16)}`),
        pad("productId", `0x${device.productId.toString(16)}`),
        pad("manufacturer", device.manufacturerName ?? "?"),
        pad("forget() available", typeof device.forget === "function"),
      ),
    );
  },
});

const serial = probe({
  id: "web.connectivity.serial",
  title: "Web Serial — port picker",
  why: "Desktop-Chromium-only in practice. Its presence in a mobile WebView would be notable enough to be worth catching.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  sticky: true,
  timeoutMs: 60_000,
  async run(ctx) {
    const serial = at("navigator.serial") as
      | { requestPort(o?: object): Promise<{ getInfo(): Record<string, unknown>; close?(): Promise<void>; forget?(): Promise<void> }> }
      | undefined;
    if (!serial) return unsupported("navigator.serial is absent — expected on mobile.");
    const port = await serial.requestPort();
    ctx.cleanup.add("serial-port", async () => {
      await port.close?.().catch(() => {});
      await port.forget?.().catch(() => {});
    });
    return ok("Port granted.", lines(...Object.entries(port.getInfo()).map(([k, v]) => pad(k, v))));
  },
});

const hid = probe({
  id: "web.connectivity.hid",
  title: "WebHID — device picker",
  why: "Distinct from WebUSB: a device can be reachable through one and not the other, which decides which library a Product must use.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  sticky: true,
  timeoutMs: 60_000,
  async run(ctx) {
    const hid = at("navigator.hid") as
      | { requestDevice(o: object): Promise<Array<{ productName?: string; vendorId: number; productId: number; close?(): Promise<void>; forget?(): Promise<void> }>> }
      | undefined;
    if (!hid) return unsupported("navigator.hid is absent.");
    const devices = await hid.requestDevice({ filters: [] });
    for (const d of devices) {
      ctx.cleanup.add(`hid-${d.productId}`, async () => {
        await d.close?.().catch(() => {});
        await d.forget?.().catch(() => {});
      });
    }
    return devices.length
      ? ok(
          `${devices.length} device(s) granted.`,
          lines(...devices.map((d) => pad(d.productName ?? "device", `0x${d.vendorId.toString(16)}:0x${d.productId.toString(16)}`))),
        )
      : { status: "skip", detail: "Picker opened but nothing was selected.", diagnosis: "user-dismissed" };
  },
});

const nfcRead = probe({
  id: "web.connectivity.nfcRead",
  title: "Web NFC — scan",
  why: "Android-Chromium-only, and one of the nine device permissions the host declares. A gap between the host declaring NFC and the WebView exposing it would be exactly the sort of seam this suite exists to find.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 45_000,
  async run(ctx) {
    const Ctor = at("NDEFReader") as (new () => { scan(o?: object): Promise<void>; onreading: unknown; onreadingerror: unknown }) | undefined;
    if (!Ctor) return unsupported("NDEFReader is absent — expected outside Android Chromium.");

    const reader = new Ctor();
    let tag: string | null = null;
    reader.onreading = () => {
      tag = "a tag was read";
    };

    await reader.scan({ signal: ctx.signal });
    // Scanning starts immediately; a tag may never appear, and that is not a
    // failure of the API. Permission being granted at all is the real result.
    await new Promise((r) => setTimeout(r, 8_000));

    return ok(
      tag ? "Scan permitted and a tag was read." : "Scan permitted. No tag presented within 8 s, which is expected without one to hand.",
      lines(pad("scan()", "resolved — permission granted"), pad("tag seen", tag ?? "none"), "", "Tag CONTENTS are not recorded."),
    );
  },
});

const nfcWrite = probe({
  id: "web.connectivity.nfcWrite",
  title: "Web NFC — write",
  why: "Write is a separate grant from read on some builds. Kept behind the read probe so a failure here is unambiguously about writing.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["web.connectivity.nfcRead"],
  timeoutMs: 45_000,
  async run(ctx) {
    const Ctor = at("NDEFReader") as (new () => { write(m: unknown, o?: object): Promise<void> }) | undefined;
    if (!Ctor) return unsupported("NDEFReader is absent.");
    const writer = new Ctor();
    await writer.write({ records: [{ recordType: "text", data: "sonde" }] }, { signal: ctx.signal });
    return ok("Wrote an NDEF text record to a presented tag.");
  },
});

export const CONNECTIVITY_PROBES: Probe[] = [bluetooth, usb, hid, serial, nfcRead, nfcWrite];
