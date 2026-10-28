const express = require('express');
const prisma = require('../lib/prisma');
const { findValidApiKey, shouldTouchLastUsed } = require('../utils/tenantApiKeys');
const { handleChat } = require('../services/tenantChat');
const { endSession } = require('../services/chatSessions');

// Public chat endpoint used by the embed widget and customers' own apps:
//   POST /api/v1/tenant-chat/:slug/chat   header X-Tenant-Api-Key: tk_...
//   body { query, botType: "support" | "sales" (alias: bot; default support), sessionId?, language? }
// botType picks the persona and the category weighting (domains/tenantProfile.js);
// an unknown value is a 400, and the response echoes the botType that answered.
// language ("en" | "hi") sets the reply language; without it the engine falls
// back to detecting the message's own language (engine/language.js). The
// response echoes the `language` it came out in.
// The slug picks the tenant; the key must be a live (non-revoked) key of
// THAT tenant, matched by SHA-256 hash — a key of another tenant is
// rejected exactly like an unknown one. Everything after this point
// (services/tenantChat.js) only ever sees req.tenant.
const router = express.Router();

router.use('/:slug', async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug: req.params.slug } });
    if (!tenant || !tenant.active) return res.status(404).json({ error: 'Unknown tenant' });

    const key = await findValidApiKey(prisma, tenant.id, req.headers['x-tenant-api-key']);
    if (!key) return res.status(401).json({ error: 'Missing or invalid X-Tenant-Api-Key' });
    if (shouldTouchLastUsed(key)) {
      // Best-effort bookkeeping — never fail or delay a chat request over it.
      prisma.tenantApiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
});

router.post('/:slug/chat', handleChat);

// The widget reports its page closing: body { sessionId }. The conversation
// is summarized now instead of after the idle delay (services/chatSessions.js).
// 204 either way for a well-formed id, so the endpoint can't be used to probe
// which session ids exist.
router.post('/:slug/session/end', async (req, res) => {
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.slice(0, 64) : '';
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  await endSession({ tenantId: req.tenant.id, sessionId });
  res.status(204).end();
});

module.exports = router;
