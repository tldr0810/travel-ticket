// PWA assets for a rendered trip handbook: manifest, service worker, and icons.
//
// Design goals that shaped the choices here:
//   - Self-contained per output dir. Each trip dir (dist/ root AND every
//     dist/trips/<slug>/) gets its own manifest + sw.js + icons with RELATIVE
//     urls, so the same files work when served at `/` (deployed), `/trip/`
//     (studio latest) or `/trips/<dir>/` (studio wallet), and when the dir is
//     zipped and opened locally. Nothing assumes an absolute origin.
//   - No dependencies. Icons are rasterised to PNG with the built-in zlib —
//     no canvas/sharp. Colours mirror DESIGN.md tokens (no new hex):
//     --night #292a25, --paper #fff8ea, --rail #e3372d, --ink #171713,
//     --rail-deep #9c322b.
//   - Service worker is NETWORK-FIRST for documents (a re-render is always
//     seen when online — no stale-page footgun during `--render-only` dev),
//     CACHE-FIRST for the CDN shell (GSAP + fonts) so an installed handbook
//     opens fully offline after one online visit.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

// --- tokens (mirror DESIGN.md; not new colours) ---------------------------
const NIGHT = [0x29, 0x2a, 0x25]
const PAPER = [0xff, 0xf8, 0xea]
const RAIL = [0xe3, 0x37, 0x2d]
const INK = [0x17, 0x17, 0x13]
const RAILDEEP = [0x9c, 0x32, 0x2b]
const THEME = '#292a25' // --night: standalone chrome + splash background

// --- icon geometry, normalised to [0,1] -----------------------------------
// A ticket: cream rounded card on a night field, red rail stripe down the
// left, a barcode in the main panel, a perforation of punched holes, and a
// round postmark on the stub. Content sits inside the maskable safe zone
// (~inner 80%) so one 512 icon serves both `any` and `maskable`.
const TICKET = { x0: 0.23, y0: 0.19, x1: 0.77, y1: 0.81, r: 0.06 }
const PERF_X = 0.615
const BAND_X = 0.335
const BARS = [[0.375, 0.028], [0.418, 0.018], [0.452, 0.034], [0.500, 0.018], [0.536, 0.030]]

const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by)

const inRoundRect = (x, y, { x0, y0, x1, y1, r }) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const ix0 = x0 + r, ix1 = x1 - r, iy0 = y0 + r, iy1 = y1 - r
  if (x >= ix0 && x <= ix1) return true
  if (y >= iy0 && y <= iy1) return true
  const cx = x < ix0 ? ix0 : ix1
  const cy = y < iy0 ? iy0 : iy1
  return dist2(x, y, cx, cy) <= r * r
}

// Topmost layer colour at a normalised point.
function sampleColor(nx, ny) {
  if (!inRoundRect(nx, ny, TICKET)) return NIGHT
  // perforation: punched holes down the stub divider (cut through to night)
  for (let cy = 0.265; cy <= 0.75; cy += 0.0685) {
    if (dist2(nx, ny, PERF_X, cy) < 0.0165 * 0.0165) return NIGHT
  }
  // postmark ring on the stub
  const d = Math.sqrt(dist2(nx, ny, 0.692, 0.345))
  if (d <= 0.062 && d >= 0.045) return RAILDEEP
  // rail stripe down the left edge
  if (nx < BAND_X) return RAIL
  // barcode in the main panel
  if (nx >= 0.37 && nx <= 0.585 && ny >= 0.62 && ny <= 0.745) {
    for (const [bx, bw] of BARS) if (nx >= bx && nx < bx + bw) return INK
  }
  return PAPER
}

// Rasterise the icon to an RGBA buffer with SSx supersampling for smooth edges.
function iconRgba(size) {
  const ss = 3
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / size
          const ny = (y + (sy + 0.5) / ss) / size
          const c = sampleColor(nx, ny)
          r += c[0]; g += c[1]; b += c[2]
        }
      }
      const n = ss * ss
      const o = (y * size + x) * 4
      rgba[o] = Math.round(r / n)
      rgba[o + 1] = Math.round(g / n)
      rgba[o + 2] = Math.round(b / n)
      rgba[o + 3] = 255 // fully opaque: night fills the whole canvas
    }
  }
  return rgba
}

// --- minimal PNG encoder (RGBA, 8-bit) -------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}
function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // depth 8, RGBA, no interlace
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}
const iconPng = (size) => encodePng(size, iconRgba(size))

// --- vector favicon (same motif, hand-authored) ----------------------------
function iconSvg() {
  const holes = []
  for (let cy = 0.265; cy <= 0.75; cy += 0.0685) holes.push(`<circle cx="${(PERF_X * 100).toFixed(1)}" cy="${(cy * 100).toFixed(1)}" r="1.6" fill="#292a25"/>`)
  const bars = BARS.map(([bx, bw]) => `<rect x="${(bx * 100).toFixed(1)}" y="62" width="${(bw * 100).toFixed(1)}" height="12.5" fill="#171713"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="#292a25"/>` +
    `<rect x="23" y="19" width="54" height="62" rx="6" fill="#fff8ea"/>` +
    `<path d="M23 25a6 6 0 0 1 6-6h4.5v62H29a6 6 0 0 1-6-6z" fill="#e3372d"/>` +
    bars + holes +
    `<circle cx="69.2" cy="34.5" r="5.3" fill="none" stroke="#9c322b" stroke-width="1.7"/>` +
    `</svg>`
}

// --- manifest --------------------------------------------------------------
function manifestJson({ name, short, description }) {
  return JSON.stringify({
    id: './',
    name,
    short_name: short,
    description,
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait-primary',
    lang: 'zh-Hant',
    dir: 'ltr',
    theme_color: THEME,
    background_color: THEME,
    icons: [
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }, null, 2)
}

// --- service worker --------------------------------------------------------
// cacheId changes whenever the precache list changes, so activate() drops the
// stale cache. Network-first for documents keeps re-renders visible online.
function serviceWorkerJs(pages, cacheId) {
  const core = JSON.stringify(['./', ...pages])
  return `// Auto-generated by pipeline/pwa.mjs — trip handbook offline shell.
const CACHE = 'tt::${cacheId}';
const CORE = ${core};
const CDN = ['https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('tt::')).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCdn = CDN.some((h) => url.href.startsWith(h));

  // Documents: network-first (fresh when online), fall back to cache offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, net.clone()).catch(() => {});
        return net;
      } catch {
        return (await caches.match(req)) || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Same-origin assets + CDN shell (GSAP, fonts): cache-first, revalidate.
  if (isCdn || url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const fetching = fetch(req).then((net) => {
        // Clone SYNCHRONOUSLY here — deferring the clone into the caches.open
        // callback races with respondWith consuming the body ('body already
        // used' → put silently rejects and nothing caches).
        if (net) {
          const copy = net.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return net;
      }).catch(() => null);
      return cached || (await fetching) || Response.error();
    })());
  }
});
`
}

// --- public API ------------------------------------------------------------
// Names for the manifest, derived from the itinerary in render.mjs and passed
// in so we don't re-derive cover fields here.
export function pwaNames(itinerary, { destinationTop, destinationAccent }) {
  const top = (destinationTop || itinerary.destination || 'Trip').trim()
  const accent = (destinationAccent || '').trim()
  const name = (accent && accent !== 'Itinerary' ? `${top} ${accent}` : top) || 'Trip Ticket'
  const short = (top.split(/[\s·,，:：]/)[0] || 'Trip').slice(0, 12)
  return { name, short }
}

// Pure: no fs. Returns a Map of path (relative to the trip's outDir) → content.
export function buildPwaAssetFiles({ name, short, description }, pages, extraAssets = []) {
  // extraAssets 空時 hash 輸入與舊版完全相同 → 舊手冊 sw.js 逐 byte 不變（回歸鐵律）。
  const hashInput = extraAssets.length ? [name, pages, extraAssets] : [name, pages]
  const cacheId = crypto.createHash('sha1').update(JSON.stringify(hashInput)).digest('hex').slice(0, 12)
  return new Map([
    ['manifest.webmanifest', manifestJson({ name, short, description })],
    ['sw.js', serviceWorkerJs([...pages, ...extraAssets], cacheId)],
    ['icon.svg', iconSvg()],
    ['icon-192.png', iconPng(192)],
    ['icon-512.png', iconPng(512)],
  ])
}

export function writePwaAssets(outDir, names, pages, extraAssets = []) {
  const files = buildPwaAssetFiles(names, pages, extraAssets)
  for (const [name, body] of files) fs.writeFileSync(path.join(outDir, name), body)
}
