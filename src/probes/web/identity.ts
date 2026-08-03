// Credentials and payment.
//
// These matter to a wallet host more than most: WebAuthn is the browser's own
// answer to the problem the Polkadot App solves in its own way, and where the
// two overlap — biometric unlock, hardware-backed keys — a Product has to know
// which one is actually available.

import { TIER, type Probe } from "../../core/types";
import { at, detect, lines, ok, pad, probe, unsupported, wrong } from "../helpers";

const CAT = "identity";

const webauthnSupport = probe({
  id: "web.identity.webauthnSupport",
  title: "WebAuthn availability",
  why: "The host declares a Biometrics device permission. WebAuthn is the standard route to the same hardware, so whether both exist tells you if there are two paths or one.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 20_000,
  async run() {
    const PKC = (globalThis as { PublicKeyCredential?: {
      isUserVerifyingPlatformAuthenticatorAvailable?(): Promise<boolean>;
      isConditionalMediationAvailable?(): Promise<boolean>;
      getClientCapabilities?(): Promise<Record<string, boolean>>;
    } }).PublicKeyCredential;
    if (!PKC) return unsupported("PublicKeyCredential is absent — no WebAuthn.");

    const rows: string[] = [];
    const platform = await PKC.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false);
    rows.push(pad("platform authenticator", platform ?? "not reported"));
    const conditional = await PKC.isConditionalMediationAvailable?.().catch(() => false);
    rows.push(pad("conditional mediation", conditional ?? "not reported"));

    if (PKC.getClientCapabilities) {
      try {
        const caps = await PKC.getClientCapabilities();
        for (const [k, v] of Object.entries(caps)) rows.push(pad(`  ${k}`, v));
      } catch {
        /* newer API, absent on most builds */
      }
    }

    return platform
      ? ok("A user-verifying platform authenticator is available (device biometrics or PIN).", lines(...rows))
      : {
          status: "unsupported",
          detail: "WebAuthn exists but no platform authenticator is available — only external keys could be used, if any.",
          data: lines(...rows, "", "In a WebView this usually means the host has not forwarded the FIDO2 surface."),
          diagnosis: "not-implemented",
        };
  },
});

const webauthnCreate = probe({
  id: "web.identity.webauthnCreate",
  title: "WebAuthn — create a credential",
  why: "The real test. Availability checks routinely pass on runtimes where an actual create() call is refused, and only the call distinguishes the two.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["web.identity.webauthnSupport"],
  timeoutMs: 90_000,
  async run(ctx) {
    const creds = navigator.credentials;
    if (!creds?.create) return unsupported("navigator.credentials.create is absent.");

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const cred = (await creds.create({
      publicKey: {
        challenge,
        // rp.id is left unset so the browser derives it from the current
        // origin. Hardcoding it would fail on every surface but one, and this
        // suite runs on three.
        rp: { name: "sonde capability probe" },
        user: { id: userId, name: "sonde-probe", displayName: "sonde probe" },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },   // ES256
          { type: "public-key", alg: -257 }, // RS256
          { type: "public-key", alg: -8 },   // EdDSA
        ],
        authenticatorSelection: { userVerification: "preferred", residentKey: "discouraged" },
        timeout: 60_000,
        attestation: "none",
      },
      signal: ctx.signal,
    })) as PublicKeyCredential | null;

    if (!cred) return wrong("create() resolved with null — no credential was produced.");

    const response = cred.response as AuthenticatorAttestationResponse;
    return ok(
      "Created a credential.",
      lines(
        pad("id length", cred.rawId.byteLength),
        pad("type", cred.type),
        pad("transports", response.getTransports?.().join(", ") ?? "not reported"),
        pad("alg", response.getPublicKeyAlgorithm?.() ?? "not reported"),
        "",
        "The credential is discoverable-discouraged and unregistered anywhere, so it is inert.",
      ),
    );
  },
});

const credentialManagement = detect({
  id: "web.identity.credentialManagement",
  title: "Credential Management",
  why: "Password and federated credential storage. Distinct from WebAuthn and usually absent in a WebView, which forces manual entry.",
  category: CAT,
  paths: ["navigator.credentials.get", "navigator.credentials.store"],
});

const paymentRequest = probe({
  id: "web.identity.paymentRequest",
  title: "Payment Request — canMakePayment",
  why: "The host runs its own payment namespace. Whether the web payment surface is ALSO present decides if a Product has a choice of rails or exactly one.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 25_000,
  async run() {
    const PR = at("PaymentRequest") as (new (m: unknown[], d: unknown) => { canMakePayment(): Promise<boolean> }) | undefined;
    if (!PR) return unsupported("PaymentRequest is absent.");

    const request = new PR(
      [{ supportedMethods: "basic-card" }],
      { total: { label: "sonde probe", amount: { currency: "USD", value: "0.00" } } },
    );
    // canMakePayment() only, never show(). A probe must not put a payment sheet
    // in front of someone who asked for a compatibility report.
    const can = await request.canMakePayment().catch((e: Error) => `threw — ${e.message}`);
    return ok(
      `PaymentRequest constructs; canMakePayment reports ${can}.`,
      lines(
        pad("canMakePayment", can),
        "",
        "show() is deliberately NOT called — no payment sheet is raised by this suite.",
      ),
    );
  },
});

const paymentHandler = detect({
  id: "web.identity.paymentHandler",
  title: "Payment Handler",
  why: "Would let a Product register itself as a payment method. Its absence rules that architecture out entirely.",
  category: CAT,
  // PaymentManager is service-worker scoped; PaymentRequestEvent is a global.
  // A page sees one and not the other by design.
  paths: ["PaymentManager", "PaymentRequestEvent"],
  mode: "any",
});

const digitalCredentials = detect({
  id: "web.identity.digitalCredentials",
  title: "Digital Credentials API",
  why: "The emerging route to government-issued identity. Directly adjacent to what a personhood-oriented chain does, so its arrival is worth tracking in diffs.",
  category: CAT,
  // Two generations of the same proposal — either alone is meaningful.
  paths: ["navigator.identity", "DigitalCredential"],
  mode: "any",
});

const fedcm = detect({
  id: "web.identity.fedcm",
  title: "FedCM",
  why: "Federated sign-in without third-party cookies. Recorded because its presence implies the engine is recent and privacy-sandbox aware.",
  category: CAT,
  paths: "IdentityCredential",
});

export const IDENTITY_PROBES: Probe[] = [
  webauthnSupport,
  credentialManagement,
  paymentRequest,
  paymentHandler,
  fedcm,
  digitalCredentials,
  webauthnCreate,
];
