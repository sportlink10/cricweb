/* ═══════════════════════════════════════════════════════════════════════════
 * CricketLive Stream Proxy — Cloudflare Worker
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A stream proxy for the CricketLive playlist. It fetches one stream and
 * returns it with CORS added, rewriting HLS playlists line by line so every
 * variant and every segment comes back through this Worker too.
 *
 *   GET /?url=<encoded>[&ref=][&ua=]
 *
 * ── Why a proxy is needed ────────────────────────────────────────────────
 *
 * playerr03.com signs each stream in the query string:
 *
 *     ?md5=<hash>&expires=<ts>&ch=<channel>&s=<sig>
 *
 * and its edge checks two more things on top of that signature:
 *
 *   1. A Referer header. The playlist supplies `https://playerr03.com/`.
 *   2. An Origin that matches. A browser always sends its own page's origin,
 *      which is not what the CDN wants.
 *
 * A raw <video src> from a page therefore fails with 403. Routing through
 * this Worker fixes both: the Worker is the one making the request, so the
 * browser's origin never enters the picture, and the Worker sends whatever
 * Referer the playlist named.
 *
 * ── Domain lock ──────────────────────────────────────────────────────────
 *
 * Only playerr03.com and its subdomains are fetched. Subdomains are matched
 * by the dot-boundary rule in allowed(), so mz01.playerr03.com and
 * mz02.playerr03.com both pass with the single parent entry, and a new
 * mirror the feed adds later still works without touching this file.
 *
 * ── Origin lock ──────────────────────────────────────────────────────────
 *
 * Only the two front-ends in ALLOWED_ORIGINS can call this Worker. The
 * browser sets the Origin header itself and JavaScript cannot forge it, so
 * any other site that tries to embed the player or hotlink the Worker URL
 * is rejected before the upstream fetch happens. Safari's native media
 * element does not send Origin for cross-origin <video> fetches — only
 * Referer — so Referer is checked as a fallback. Front-ends must not use a
 * no-referrer policy, or Safari's requests will carry neither header.
 *
 * ── HLS rewriting ────────────────────────────────────────────────────────
 *
 * A master playlist lists variant playlists; each variant lists segments.
 * Every URL in those files is relative, so the player would resolve them
 * against this Worker's own origin — and then ask the Worker for a path it
 * knows nothing about. Rewriting each line to an absolute, re-wrapped URL
 * keeps the real target in ?url= where the Worker expects it:
 *
 *     #EXT-X-STREAM-INF:...,RESOLUTION=1280x720
 *     https://mz01.playerr03.com:7060/hls/hdwillos5.m3u8?md5=...
 *         ↓
 *     #EXT-X-STREAM-INF:...,RESOLUTION=1280x720
 *     /?url=https%3A%2F%2Fmz01.playerr03.com%3A7060%2Fhls%2F...
 *
 * ── Signed query inheritance ─────────────────────────────────────────────
 *
 * playerr03.com signs the master with md5 / expires / s, and the whole
 * folder inherits that signature. Resolving a relative reference drops the
 * query, so without inheriting it the master plays and every variant comes
 * back 403. A child with no query of its own therefore picks up the parent's.
 *
 * ── Deploy ───────────────────────────────────────────────────────────────
 *
 *   wrangler deploy proxy.js --name sportlink-proxy \
 *     --compatibility-date 2024-09-23
 *
 * Then point the player at it, once, in the browser:
 *
 *   localStorage.in_proxy = 'https://sportlink-proxy.<you>.workers.dev'
 *
 * The player reads localStorage.in_proxy first and falls back to the Vercel
 * function, so this overrides it cleanly.
 * ═══════════════════════════════════════════════════════════════════════════ */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ── the only domain this Worker will fetch ──────────────────────────────
 *
 * Subdomains are matched by the dot-boundary rule below, so one entry covers
 * playerr03.com, mz01.playerr03.com, mz02.playerr03.com, and anything else
 * the feed might point at. The dot boundary is what stops a suffix trick
 * like playerr03.com.evil.example from passing. */
const ALLOWED = ['playerr03.com'];

/* ── the only front-ends that may call this Worker ───────────────────────
 *
 * Exact-match list, not a suffix rule. The Origin header contains the
 * scheme, host, and (for non-default ports) the port, but never a path, so
 * a URL like https://sportlink-cric.pages.dev/anything is covered by the
 * bare origin entry below. Add more entries here if you point another
 * domain at this Worker; do not broaden to a suffix match, or every
 * *.pages.dev project would qualify. */
const ALLOWED_ORIGINS = [
  'https://sportlink-cric.pages.dev',
  'https://sportlink10-ajp.pages.dev',
];

function allowed(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED.some(s => h === s || h.endsWith('.' + s));
}

/* ── origin guard ────────────────────────────────────────────────────────
 *
 * Returns the matched origin string if the request is permitted, else null.
 * Preference order: Origin first (browsers always set it on XHR/fetch and
 * never let JS forge it), Referer second (Safari's native media element
 * skips Origin but sends Referer).
 *
 * A request with neither header — a direct URL visit, a bare curl, or a
 * fetch from a page that strips its referrer — falls through to null and
 * is rejected. That is the correct behaviour: this Worker is not meant to
 * be invoked by anyone who is not one of the two front-ends. */
function requestOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin) {
    return ALLOWED_ORIGINS.includes(origin) ? origin : null;
  }
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      return ALLOWED_ORIGINS.includes(refOrigin) ? refOrigin : null;
    } catch { return null; }
  }
  return null;
}

/* ── CORS ────────────────────────────────────────────────────────────────
 *
 * The value must be the specific origin, not `*`, because the browser
 * compares it byte-for-byte against the request's Origin and only accepts
 * a match. Vary: Origin keeps a shared cache from serving one origin's
 * response to a different origin. */
function corsHeaders(matchedOrigin) {
  return {
    'Access-Control-Allow-Origin': matchedOrigin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Vary': 'Origin',
  };
}

/* ── entry point ────────────────────────────────────────────────────────── */

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    const matchedOrigin = requestOrigin(request);

    /* Preflight: only answer if the origin is allowed. Answering a
       preflight from a disallowed origin would tell the browser the request
       is permitted, which defeats the check. */
    if (request.method === 'OPTIONS') {
      if (!matchedOrigin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(matchedOrigin) });
    }

    /* Everything else: reject a disallowed origin up front, before any
       upstream work happens. */
    if (!matchedOrigin) {
      return new Response('Forbidden: origin not allowed', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const CORS = corsHeaders(matchedOrigin);

    const target = reqUrl.searchParams.get('url');
    const ref = reqUrl.searchParams.get('ref') || '';
    const ua = reqUrl.searchParams.get('ua') || '';

    if (!target) return text('Missing ?url=', 400, CORS);

    let targetUrl;
    try { targetUrl = new URL(target); } catch { return text('Invalid url', 400, CORS); }

    if (!allowed(targetUrl.hostname)) {
      return text('Host not allowed: ' + targetUrl.hostname, 403, CORS);
    }

    /* ── request headers ─────────────────────────────────────────────────
     *
     * The referrer the playlist names is what playerr03.com checks. Keep it
     * whole, because the reference player sends the path too. Falling back
     * to the target's origin only when the playlist left it empty — a plain
     * Referer of the CDN's own host is what these edges want when nothing
     * else was given. */
    const referrer = ref || targetUrl.origin + '/';
    let origin = targetUrl.origin;
    try { origin = new URL(referrer).origin; } catch { /* keep the target's */ }

    const headers = new Headers({
      'User-Agent': ua || DEFAULT_UA,
      'Referer': referrer,
      'Origin': origin,
      'Accept': '*/*',
    });

    /* ── fetch upstream ──────────────────────────────────────────────────
     *
     * redirect: 'follow' because a master playlist is sometimes answered
     * with a 302 to a signed URL. The default already follows, but being
     * explicit here means a future change to the defaults does not break it. */
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), { headers, redirect: 'follow' });
    } catch (e) {
      return text('Upstream failed: ' + e.message, 502, CORS);
    }

    /* ── a refusal is not a playlist ─────────────────────────────────────
     *
     * Whatever the path says. Rewriting an HTML error page as an M3U8 turns
     * each of its lines into a proxy URL, and the player then gets a
     * 200-looking manifest of nonsense instead of the reason. Passing the
     * status and a slice of the body back gives the player something to show
     * in its error panel. */
    if (!upstream.ok) {
      const body = await upstream.text();
      return new Response(body.slice(0, 2000), {
        status: upstream.status,
        headers: { ...CORS, 'X-Upstream': String(upstream.status) },
      });
    }

    /* ── what did we get? ────────────────────────────────────────────────
     *
     * The content-type is the more reliable signal. A CDN may serve a
     * playlist from a path that does not end in .m3u8 — some obfuscate the
     * extension as .txt — and some serve segments from a path that does.
     * Either signal, checked together, catches both shapes. */
    const ct = upstream.headers.get('content-type') || '';
    const lower = targetUrl.pathname.toLowerCase();
    const isPlaylist = lower.endsWith('.m3u8') || ct.includes('mpegurl');

    /* ── HLS playlist ────────────────────────────────────────────────────
     *
     * Rewrite every URL in the file to an absolute, re-wrapped URL, so the
     * player's next request comes back here with the real target in ?url=. */
    if (isPlaylist) {
      const body = await upstream.text();
      const base = `${reqUrl.origin}/`;
      const extras =
        (ref ? '&ref=' + encodeURIComponent(ref) : '') +
        (ua ? '&ua=' + encodeURIComponent(ua) : '');

      /* A child with no query of its own inherits the parent's. This is
         what makes the signature survive the walk from master to variant to
         segment. */
      const parentQuery = targetUrl.search;
      const toAbs = (r) => {
        const u = new URL(r, targetUrl);
        if (!u.search && parentQuery) u.search = parentQuery;
        return u.toString();
      };
      const wrap = (abs) => base + '?url=' + encodeURIComponent(abs) + extras;

      /* Three kinds of line, three rules:
       *
       *   blank                    → leave it, so the file stays readable
       *   #EXT-X-KEY:URI="..."     → rewrite the URI inside the quotes
       *   #EXT-X-MEDIA:URI="..."   → rewrite the URI inside the quotes
       *   #EXT-X-STREAM-INF, ...   → a tag, keep as-is
       *   anything else            → a URL, wrap it
       *
       * The tag branch only touches URI="..." attributes, so a comment like
       * #EXT-X-ENDLIST comes through unchanged and a tag that carries an
       * ordinary string does not get mangled. */
      const rewritten = body.split('\n').map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
        }
        return wrap(toAbs(t));
      }).join('\n');

      return new Response(rewritten, {
        status: 200,
        headers: {
          ...CORS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
        },
      });
    }

    /* ── segments and keys ───────────────────────────────────────────────
     *
     * Hand the bytes back with CORS added. The upstream body is streamed
     * through untouched — a Worker does not load it into memory, which
     * matters for a large segment on a slow connection.
     *
     * The upstream cache-control is passed on. For a .ts segment that is
     * usually a long max-age, which is correct: the segment never changes.
     * For a key it is usually no-cache, which is also correct. */
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': ct || 'application/octet-stream',
        'Cache-Control': upstream.headers.get('cache-control') || 'no-cache',
      },
    });
  },
};

/* A short text response with the CORS headers attached, for the error paths. */
function text(msg, status, CORS) {
  return new Response(msg, { status, headers: CORS });
}
