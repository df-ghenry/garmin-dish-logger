const CACHE_NAME = 'garmin-dish-logger-v9';
const BEACON_GIST_URL = 'https://api.github.com/gists/1d47f9c40ee2ac4743ff81b62351ddad';
const BEACON_RAW_URL =
  'https://gist.githubusercontent.com/df-ghenry/1d47f9c40ee2ac4743ff81b62351ddad/raw/garmin-dish-logger-beacon.json';
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

let cachedLiveTunnelUrl = null;
let lastBeaconFetchMs = 0;

async function resolveLiveTunnelUrl(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedLiveTunnelUrl && now - lastBeaconFetchMs < 30000) {
    return cachedLiveTunnelUrl;
  }
  try {
    const res = await fetch(`${BEACON_GIST_URL}?t=${now}`, { cache: 'no-store' });
    if (res.ok) {
      const gist = await res.json();
      const content = gist?.files?.['garmin-dish-logger-beacon.json']?.content;
      if (content) {
        const parsed = JSON.parse(content);
        if (parsed?.tunnelUrl && !String(parsed.tunnelUrl).includes('api.trycloudflare.com')) {
          cachedLiveTunnelUrl = String(parsed.tunnelUrl).replace(/\/+$/, '');
          lastBeaconFetchMs = now;
          return cachedLiveTunnelUrl;
        }
      }
    }
  } catch {
    // Fall through
  }
  try {
    const rawRes = await fetch(`${BEACON_RAW_URL}?t=${now}`, { cache: 'no-store' });
    if (rawRes.ok) {
      const parsed = await rawRes.json();
      if (parsed?.tunnelUrl && !String(parsed.tunnelUrl).includes('api.trycloudflare.com')) {
        cachedLiveTunnelUrl = String(parsed.tunnelUrl).replace(/\/+$/, '');
        lastBeaconFetchMs = now;
      }
    }
  } catch {
    // Ignore
  }
  return cachedLiveTunnelUrl;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((oldKey) => caches.delete(oldKey)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ignore external requests (e.g. GitHub Gist beacon or Gemini API)
  if (url.origin !== self.location.origin) {
    return;
  }

  // 1. Handle shared photo from Android Share Sheet
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const photoFile = formData.get('photo');
          const sharedText = formData.get('text') || formData.get('title') || '';
          if (photoFile) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(
              '/__shared_photo__',
              new Response(photoFile, {
                headers: {
                  'Content-Type': photoFile.type || 'image/jpeg',
                  'X-Shared-Notes': encodeURIComponent(String(sharedText)),
                },
              }),
            );
          }
          return Response.redirect('/?shared=1', 303);
        } catch {
          return Response.redirect('/', 303);
        }
      })(),
    );
    return;
  }

  // 2. API calls: try current origin first; if tunnel changed (530/502/network error), reroute via Gist beacon
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        const clonedReq = event.request.clone();
        try {
          const res = await fetch(event.request);
          if (res.status < 500) {
            return res;
          }
        } catch {
          // Primary origin failed; fall through to beacon reroute
        }

        const liveTunnel = await resolveLiveTunnelUrl(true);
        if (liveTunnel && liveTunnel !== self.location.origin) {
          const targetUrl = `${liveTunnel}${url.pathname}${url.search}`;
          const init = {
            method: clonedReq.method,
            headers: { 'Content-Type': clonedReq.headers.get('Content-Type') || 'application/json' },
            mode: 'cors',
          };
          if (clonedReq.method !== 'GET' && clonedReq.method !== 'HEAD') {
            init.body = await clonedReq.arrayBuffer();
          }
          try {
            const crossRes = await fetch(targetUrl, init);
            const body = await crossRes.arrayBuffer();
            const responseHeaders = new Headers();
            crossRes.headers.forEach((val, key) => {
              responseHeaders.set(key, val);
            });
            responseHeaders.set('Access-Control-Allow-Origin', '*');
            return new Response(body, {
              status: crossRes.status,
              statusText: crossRes.statusText,
              headers: responseHeaders,
            });
          } catch {
            // Live tunnel fetch failed
          }
        }

        return new Response(JSON.stringify({ error: 'Backend unreachable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      })(),
    );
    return;
  }

  // 3. Static assets & SPA navigation: network-first, then live tunnel fallback, then cache fallback
  if (event.request.method === 'GET') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(event.request);
          if (response && response.status === 200) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
            return response;
          }
        } catch {
          // Fall through
        }

        // If origin tunnel expired (530), try fetching fresh asset from live tunnel via beacon
        const liveTunnel = await resolveLiveTunnelUrl(false);
        if (liveTunnel && liveTunnel !== self.location.origin) {
          try {
            const tunnelRes = await fetch(`${liveTunnel}${url.pathname}${url.search}`, {
              mode: 'cors',
            });
            if (tunnelRes && tunnelRes.status === 200) {
              const cloned = tunnelRes.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
              return tunnelRes;
            }
          } catch {
            // Fall through to local cache
          }
        }

        const cached = await caches.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const indexCached =
            (await caches.match('./index.html')) || (await caches.match('/index.html'));
          if (indexCached) return indexCached;
        }
        return new Response('Offline', { status: 503 });
      })(),
    );
  }
});
