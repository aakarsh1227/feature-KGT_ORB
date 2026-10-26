export const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4100';

// Two separate sessions, stored under separate keys:
//   operator — KGT staff, /admin pages   (typ "operator" JWT)
//   client   — a customer company, /dashboard (typ "client" JWT)
// The API rejects each token on the other's routes; keeping them apart here
// also means signing in as one never silently reuses the other.
const TOKEN_KEYS = { operator: 'kgtStaffToken', client: 'kgtClientToken' };

export function getToken(kind) {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEYS[kind]);
  } catch {
    return null;
  }
}

export function setToken(kind, token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEYS[kind], token);
    else window.localStorage.removeItem(TOKEN_KEYS[kind]);
  } catch {
    // storage blocked — the session simply won't survive a reload
  }
}

// What to say when a failed response has no JSON { error } from the API:
// it came from something in between (a proxy or tunnel) or the API is down.
function fallbackMessage(status) {
  if (status === 413) return 'That upload is too large for the server to accept. Try a smaller file.';
  if (status === 429) return 'Too many requests. Please wait a minute and try again.';
  if ([502, 503, 504, 522, 524].includes(status)) {
    return 'The server took too long to respond or is unavailable. Please try again in a moment.';
  }
  return `Something went wrong (HTTP ${status}). Please try again.`;
}

async function send(path, init) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, init);
  } catch {
    // The browser's own "Failed to fetch": no response could be read at all
    // (offline, server down or restarting, or a response blocked by CORS).
    const err = new Error("Couldn't reach the server. Check your connection and try again — if it keeps happening, the server may be restarting.");
    err.status = 0;
    throw err;
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || fallbackMessage(res.status));
    err.status = res.status;
    err.data = data; // the API's extra fields, e.g. { retryAfter, attemptsLeft, code }
    throw err;
  }
  return data;
}

function authHeaders(auth) {
  const token = auth ? getToken(auth) : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// auth: 'operator' | 'client' | undefined (public)
function request(path, { method = 'GET', body, auth } = {}) {
  return send(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders(auth) },
    body: body ? JSON.stringify(body) : undefined
  });
}

// No Content-Type header: the browser sets multipart/form-data with its boundary.
function requestMultipart(path, formData, auth) {
  return send(path, { method: 'POST', headers: authHeaders(auth), body: formData });
}

const enc = encodeURIComponent;

export const api = {
  // ── KGT staff
  staffLogin: (email, password) => request('/api/v1/operator/login', { method: 'POST', body: { email, password } }),
  staffMe: () => request('/api/v1/operator/me', { auth: 'operator' }),
  listTenants: () => request('/api/v1/tenants', { auth: 'operator' }),
  createTenant: (payload) => request('/api/v1/tenants', { method: 'POST', body: payload, auth: 'operator' }),
  getTenant: (tenantId) => request(`/api/v1/tenants/${enc(tenantId)}`, { auth: 'operator' }),
  updateTenant: (tenantId, payload) =>
    request(`/api/v1/tenants/${enc(tenantId)}`, { method: 'PATCH', body: payload, auth: 'operator' }),

  // ── Client company
  clientLogin: (email, password) => request('/api/v1/client/login', { method: 'POST', body: { email, password } }),
  clientMe: () => request('/api/v1/client/me', { auth: 'client' }),
  // Forgot password: a 6-digit code to the account's email (404 EMAIL_NOT_FOUND
  // when there's no account), then the code + new password in one call.
  requestPasswordReset: (email) => request('/api/v1/public/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (email, otp, newPassword) => request('/api/v1/public/auth/reset-password', { method: 'POST', body: { email, otp, newPassword } }),

  // ── Public signup wizard (pages/register.js) — no auth
  // authorized: the visitor ticked the crawl-authorization box — the API refuses to crawl without it.
  analyzeCompanyUrl: (url, { authorized } = {}) =>
    request('/api/v1/public/register/analyze', { method: 'POST', body: { url, authorized: authorized === true } }),
  // Any supported file: PDF, Word (.docx), .txt, .md or a .zip of them -> { pages, files }
  analyzeCompanyFile: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return requestMultipart('/api/v1/public/register/analyze-file', formData);
  },
  analyzeCompanyPdf: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return requestMultipart('/api/v1/public/register/analyze-pdf', formData);
  },
  // Signup email verification: a 6-digit code to the address; verifying returns
  // the verificationToken /register/complete requires (as emailVerificationToken).
  sendSignupOtp: (email) => request('/api/v1/public/auth/send-otp', { method: 'POST', body: { email } }),
  verifySignupOtp: (email, otp) => request('/api/v1/public/auth/verify-otp', { method: 'POST', body: { email, otp } }),
  // Readiness audit of the wizard's pages before anything is created: { readinessScore, readinessLevel, pillarScores, ... }
  preflightAudit: (payload) => request('/api/v1/public/register/preflight-audit', { method: 'POST', body: payload }),
  completeRegistration: (payload) => request('/api/v1/public/register/complete', { method: 'POST', body: payload })
};

// One tenant's workspace (documents, keys, test chat, tickets, usage), with
// the same methods whoever is looking: a client sees its own tenant only
// (the API resolves it from the session), staff reach any tenant by id.
// components/workspace/* are written against this interface.
function workspace(base, auth) {
  const r = (path, opts = {}) => request(`${base}${path}`, { ...opts, auth });
  return {
    listDocuments: () => r('/documents'),
    createDocument: (payload) => r('/documents', { method: 'POST', body: payload }),
    updateDocument: (id, payload) => r(`/documents/${enc(id)}`, { method: 'PATCH', body: payload }),
    deleteDocument: (id) => r(`/documents/${enc(id)}`, { method: 'DELETE' }),
    // category: a DOC_CATEGORIES id to file every section under, or '' to auto-detect per section
    uploadPdf: (file, category) => {
      const formData = new FormData();
      if (category) formData.append('category', category);
      formData.append('file', file);
      return requestMultipart(`${base}/documents/pdf`, formData, auth);
    },
    // Any supported file (PDF, .docx, .txt, .md, .zip): { documentsCreated, files }
    uploadFile: (file, { category, botScope } = {}) => {
      const formData = new FormData();
      if (category) formData.append('category', category);
      if (botScope) formData.append('botScope', botScope);
      formData.append('file', file);
      return requestMultipart(`${base}/documents/file`, formData, auth);
    },
    importWebsite: (url, { authorized } = {}) => r('/scrape', { method: 'POST', body: { url, authorized: authorized === true } }),
    listApiKeys: () => r('/api-keys'),
    createApiKey: (label) => r('/api-keys', { method: 'POST', body: { label } }),
    revokeApiKey: (keyId, { force = false } = {}) => r(`/api-keys/${enc(keyId)}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
    chat: (payload) => r('/chat', { method: 'POST', body: payload }),
    // Translate one message into 'en' or 'hi' -> { text, target }. Stateless:
    // it touches no session, so translating a reply never resets the chat.
    translate: (text, target) => r('/translate', { method: 'POST', body: { text, target } }),
    // Starter questions written from this tenant's documents: { status, supportFaqs, salesFaqs, generatedAt }
    getFaqs: () => r('/faqs'),
    regenerateFaqs: () => r('/faqs/regenerate', { method: 'POST' }),
    listTickets: () => r('/tickets'),
    // Visitors who left an email, with transcript and AI summary: { leads, counts, filters }.
    // botType: 'all' | 'sales' | 'support'; status: 'all' | 'NEW' | 'CONTACTED' — filtered by the API.
    listLeads: ({ botType = 'all', status = 'all' } = {}) => r(`/leads?botType=${enc(botType)}&status=${enc(status)}`),
    updateLeadStatus: (id, status) => r(`/leads/${enc(id)}`, { method: 'PATCH', body: { status } }),
    // Every conversation with its AI summary and leads: { sessions, nextCursor }, 30 per page.
    listSessions: ({ botType = 'all', cursor } = {}) =>
      r(`/sessions?botType=${enc(botType)}${cursor ? `&cursor=${enc(cursor)}` : ''}`),
    // One conversation: its summary, leads and every message, oldest first.
    getSession: (id) => r(`/sessions/${enc(id)}`),
    summarizeSession: (id) => r(`/sessions/${enc(id)}/summarize`, { method: 'POST' }),
    // Conversations where a bot missed (under 25% confidence, or no knowledge-base answer), each with its question:
    // { below, totalSessions, totalWeakAnswers, sessions, nextPage }
    listImprovements: ({ botType = 'all', page = 0 } = {}) => r(`/improvements?botType=${enc(botType)}&page=${page}`),
    // Who gets lead and needs-attention alerts: { teamEmail, recipients, lowConfidenceBelow }
    getNotifications: () => r('/notifications'),
    updateNotifications: (teamEmail) => r('/notifications', { method: 'PATCH', body: { teamEmail } }),
    getUsage: () => r('/usage'),
    getDailyUsage: (days = 30) => r(`/usage/daily?days=${days}`),
    // Readiness audit: run now (saved), or read the saved one: { report, stale, running }
    runReadinessAudit: () => r('/preflight-audit', { method: 'POST' }),
    getReadiness: () => r('/readiness'),
    // How the documents split between the bots: { totals, documents: [{ id, title, botScope, sections, counts }] }
    getKnowledgeDistribution: () => r('/knowledge/distribution'),
    // Which bots the company deploys: 'support' | 'sales' | 'both'
    setBotPreference: (botPreference) => r('/bot-preference', { method: 'PATCH', body: { botPreference } })
  };
}

export const clientWorkspace = () => workspace('/api/v1/client/workspace', 'client');
export const staffWorkspace = (tenantId) => workspace(`/api/v1/tenants/${enc(tenantId)}`, 'operator');

// Stand-in for the key in snippets shown after the real key is gone (keys
// are stored hashed and can't be read back).
export const API_KEY_PLACEHOLDER = 'YOUR_API_KEY';

// bot: 'sales' | 'support' — the widget sends it as botType on every message
// (public/widgets/tenant-chat-widget.js). Without it the widget shows both bots.
export const embedSnippet = (slug, apiKey, bot) =>
  `<script src="${BASE_URL}/widgets/tenant-chat-widget.js"\n        data-tenant-id="${slug}"\n        data-api-key="${apiKey || API_KEY_PLACEHOLDER}"${bot ? `\n        data-bot="${bot}"` : ''}\n        defer></script>`;
