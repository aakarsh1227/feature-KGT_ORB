const cors = require('cors');

// Two CORS policies, one per kind of caller:
//   public    any origin — the embed widget runs on customers' own sites.
//             Only the widget script, the widget's chat API and /health.
//   dashboard the KGT web app only (CORS_ORIGINS) — client dashboard, staff
//             console, sign-in, password reset and the signup wizard.
// A browser on any other origin gets no Access-Control-Allow-Origin header,
// so it can't read these responses. Requests without an Origin header
// (curl, server-to-server) are unaffected: CORS is a browser control.
//
// Preflight is handled here too: the cors middleware answers an OPTIONS
// request with 204 and the headers below, so a preflight never falls through
// to a route or the JSON 404. nginx (infra/nginx/api.conf) proxies OPTIONS
// straight to the app rather than adding its own CORS headers, so there is
// exactly one Access-Control-Allow-Origin on every response — a second one
// (from nginx) would make the browser reject it.

const PUBLIC_PREFIXES = ['/widgets/', '/api/v1/tenant-chat/'];

// Local dev origins the dashboard runs on: the dockerized web app (WEB_PORT,
// published on 3100), and `next dev` run straight off the host on its default
// port (3000) or the in-container port (3001). ALWAYS allowed — even when
// DEPLOY_ENV=production — because the local docker-compose stack itself runs
// with DEPLOY_ENV=production (apps/api/src/utils/assertProdSafety.js explains
// why the image always sets it), so gating these on the env would lock
// localhost out of local Docker, which is the exact failure this prevents.
//
// This is safe for a real production deployment too: a browser only ever
// sends `Origin: http://localhost:xxxx` from a page already running on the
// user's own machine, so a remote attacker cannot forge that origin to read a
// victim's responses. The dashboard authenticates with a Bearer token in the
// Authorization header (apps/web/lib/api.js), not cookies, so there is no
// ambient credential for a local page to ride on either.
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3100'];

// The dashboard's fetch client sends Content-Type and a Bearer Authorization
// header (apps/web/lib/api.js); the others are common extras a browser or
// tooling may add. Listed explicitly so a preflight for any of them succeeds.
const ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'];
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** CORS_ORIGINS: comma-separated, e.g. "https://hub.example.com,https://admin.example.com". */
function allowedOrigins(env = process.env) {
  const listed = String(env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  // The configured production origins (CORS_ORIGINS) AND the local dev
  // origins, unconditionally — see DEV_ORIGINS for why localhost is always
  // allowed, including under DEPLOY_ENV=production. De-duplicated so a dev
  // origin also present in CORS_ORIGINS isn't listed twice.
  return [...new Set([...listed, ...DEV_ORIGINS])];
}

function isPublicPath(path) {
  return path === '/health' || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

function corsPolicy(env = process.env) {
  // Widget + its chat API + /health: any origin, no credentials (an embed on
  // a customer's own site, and `*` + credentials is illegal anyway).
  const publicCors = cors();
  // Dashboard/staff APIs: the web app origins only, with credentials and the
  // dashboard's request headers explicitly allowed.
  const dashboardCors = cors({
    origin: allowedOrigins(env),
    credentials: true,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS
  });
  return (req, res, next) => (isPublicPath(req.path) ? publicCors : dashboardCors)(req, res, next);
}

module.exports = { corsPolicy, allowedOrigins, isPublicPath, DEV_ORIGINS, ALLOWED_HEADERS, ALLOWED_METHODS };
