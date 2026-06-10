const CACHE_NAME = "adaptivio-cms-shell-v43";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/styles.css?v=20260610-145200",
  "./assets/favicon.svg?v=20260610-145200",
  "./src/app.js?v=20260610-145200",
  "./src/editorWorkflow.js?v=20260610-145200",
  "./src/github.js?v=20260610-145200",
  "./src/i18n.js?v=20260610-145200",
  "./src/repoCache.js?v=20260610-145200",
  "./src/storage.js?v=20260610-145200",
  "./src/utils.js?v=20260610-145200",
  "./cms.config.json",
];

function isAppShellRequest(requestUrl) {
  const pathname = requestUrl.pathname;
  return (
    pathname.endsWith("/index.html") ||
    pathname.endsWith("/manifest.webmanifest") ||
    pathname.endsWith("/assets/styles.css") ||
    pathname.endsWith("/assets/favicon.svg") ||
    pathname.endsWith("/src/app.js") ||
    pathname.endsWith("/src/editorWorkflow.js") ||
    pathname.endsWith("/src/github.js") ||
    pathname.endsWith("/src/i18n.js") ||
    pathname.endsWith("/src/repoCache.js") ||
    pathname.endsWith("/src/storage.js") ||
    pathname.endsWith("/src/utils.js")
  );
}

async function networkFirst(request, fallbackKey = request) {
  try {
    const networkResponse = await fetch(request, { cache: "no-store" });
    if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
      const responseClone = networkResponse.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(fallbackKey, responseClone));
    }
    return networkResponse;
  } catch {
    const cachedResponse = await caches.match(fallbackKey);
    if (cachedResponse) {
      return cachedResponse;
    }
    throw new Error("Network unavailable and no cached shell response.");
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.endsWith("/cms.config.json")) {
    event.respondWith(fetch(request).catch(() => caches.match("./cms.config.json")));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "./index.html"));
    return;
  }

  if (isAppShellRequest(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== "basic") {
          return networkResponse;
        }

        const responseClone = networkResponse.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
        return networkResponse;
      });
    }),
  );
});
