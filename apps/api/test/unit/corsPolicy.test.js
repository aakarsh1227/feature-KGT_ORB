const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { corsPolicy, allowedOrigins, isPublicPath, DEV_ORIGINS } = require('../../src/utils/corsPolicy');

describe('corsPolicy — open for the widget, web-app-only for everything else', () => {
  test('allowedOrigins is the configured origins PLUS the local dev origins', () => {
    assert.deepEqual(allowedOrigins({ CORS_ORIGINS: ' https://a.example.com/ , https://b.example.com ' }),
      ['https://a.example.com', 'https://b.example.com', ...DEV_ORIGINS]);
    assert.deepEqual(allowedOrigins({}), DEV_ORIGINS);
    // No duplicate when CORS_ORIGINS already lists a dev origin (order is
    // irrelevant to CORS — compare membership).
    assert.deepEqual(
      allowedOrigins({ CORS_ORIGINS: 'http://localhost:3100' }).slice().sort(),
      DEV_ORIGINS.slice().sort()
    );
  });

  test('the dev origins cover localhost :3000, :3001 and :3100', () => {
    assert.deepEqual(DEV_ORIGINS, ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3100']);
  });

  test('localhost stays allowed even under DEPLOY_ENV=production (local docker runs as production)', () => {
    // The real failure: the local stack ships DEPLOY_ENV=production with
    // production-only CORS_ORIGINS, yet localhost must still reach the API.
    const origins = allowedOrigins({ CORS_ORIGINS: 'https://hub.kgt.solutions', DEPLOY_ENV: 'production' });
    assert.ok(origins.includes('https://hub.kgt.solutions'));
    for (const dev of DEV_ORIGINS) assert.ok(origins.includes(dev), `${dev} must be allowed`);
  });

  test('only the widget, its chat API and /health are public', () => {
    assert.ok(isPublicPath('/widgets/tenant-chat-widget.js'));
    assert.ok(isPublicPath('/api/v1/tenant-chat/acme/chat'));
    assert.ok(isPublicPath('/health'));
    assert.ok(!isPublicPath('/api/v1/client/login'));
    assert.ok(!isPublicPath('/api/v1/tenants'));
    assert.ok(!isPublicPath('/api/v1/tenant-chatx/acme/chat'));
  });

  let server;
  let base;
  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(corsPolicy({ CORS_ORIGINS: 'https://hub.example.com' }));
    app.all('*', (req, res) => res.json({ ip: req.ip }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const preflight = (path, origin) => fetch(base + path, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
  });

  test('a customer site can call the widget chat API', async () => {
    const r = await preflight('/api/v1/tenant-chat/acme/chat', 'https://any-customer.example.org');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });

  test('the web app origin can call dashboard and staff APIs', async () => {
    for (const path of ['/api/v1/client/workspace/documents', '/api/v1/tenants', '/api/v1/client/login']) {
      const r = await preflight(path, 'https://hub.example.com');
      assert.equal(r.headers.get('access-control-allow-origin'), 'https://hub.example.com', path);
    }
  });

  test('a local dev origin (:3001) can call dashboard APIs even when CORS_ORIGINS lists only production', async () => {
    // The exact failure from the bug report: frontend on localhost:3001,
    // CORS_ORIGINS set to the deployed origin only.
    const r = await preflight('/api/v1/public/auth/send-otp', 'http://localhost:3001');
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:3001');
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
    assert.match(r.headers.get('access-control-allow-headers') || '', /Authorization/i);
    assert.equal(r.status, 204);
  });

  test('any other origin gets no CORS grant on dashboard and staff APIs', async () => {
    for (const path of ['/api/v1/client/workspace/documents', '/api/v1/tenants', '/api/v1/public/register/complete']) {
      const r = await preflight(path, 'https://evil.example.net');
      assert.equal(r.headers.get('access-control-allow-origin'), null, path);
    }
  });

  test('with trust proxy, req.ip is the client from X-Forwarded-For, not the proxy', async () => {
    const r = await fetch(`${base}/api/v1/client/login`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    assert.equal((await r.json()).ip, '203.0.113.7');
  });
});
