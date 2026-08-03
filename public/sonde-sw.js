// A service worker that does nothing, on purpose.
//
// web.compute.serviceWorker tests whether registration is possible at all —
// whether the runtime allows it, whether the bundle can serve a same-origin
// script, whether the scope resolves. Intercepting fetches would change the
// behaviour of every later probe in the run, so this one deliberately does not.
//
// It is unregistered by the probe's cleanup as soon as the check completes.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
