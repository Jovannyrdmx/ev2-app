// The general rate limit counts per signed-in user, not per IP (the whole club shares one).
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../src/middleware/rate-key');
const { signAccessToken } = require('../src/middleware/auth');

const userA = { id: '11111111-1111-4111-8111-111111111111', role: 'bartender', nightclub_id: 'c1' };
const userB = { id: '22222222-2222-4222-8222-222222222222', role: 'cashier', nightclub_id: 'c1' };

function fakeReq(authorization, ip = '201.1.2.3') {
  return { headers: authorization ? { authorization } : {}, ip };
}

describe('rateLimitKey', () => {
  it('con token válido cuenta por usuario', () => {
    expect(rateLimitKey(fakeReq(`Bearer ${signAccessToken(userA)}`))).toBe(`user:${userA.id}`);
  });

  it('sin token cuenta por IP', () => {
    expect(rateLimitKey(fakeReq(null))).toBe('ip:201.1.2.3');
  });

  it('un token con firma falsa NO da cupo propio: cae a la IP', () => {
    const forged = jwt.sign({ sub: 'inventado' }, 'otra-llave-de-al-menos-16', { issuer: 'ev2' });
    expect(rateLimitKey(fakeReq(`Bearer ${forged}`))).toBe('ip:201.1.2.3');
  });

  it('un token vencido cae a la IP', () => {
    const expired = jwt.sign({ sub: userA.id, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET, { issuer: 'ev2' });
    expect(rateLimitKey(fakeReq(`Bearer ${expired}`))).toBe('ip:201.1.2.3');
  });

  it('un token de otro emisor cae a la IP', () => {
    const other = jwt.sign({ sub: userA.id }, process.env.JWT_SECRET, { issuer: 'otro' });
    expect(rateLimitKey(fakeReq(`Bearer ${other}`))).toBe('ip:201.1.2.3');
  });
});

describe('límite general con la misma IP para todo el club', () => {
  // Igual que en app.js, con un tope chico para poder llegar a él.
  function appWithLimit(limit) {
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, limit, keyGenerator: rateLimitKey,
      standardHeaders: 'draft-7', legacyHeaders: false }));
    app.get('/x', (req, res) => res.json({ ok: true }));
    return app;
  }

  it('lo que gasta un empleado no le quita cupo a otro', async () => {
    const app = appWithLimit(3);
    const a = { Authorization: `Bearer ${signAccessToken(userA)}` };
    const b = { Authorization: `Bearer ${signAccessToken(userB)}` };
    for (let i = 0; i < 3; i += 1) expect((await request(app).get('/x').set(a)).status).toBe(200);
    expect((await request(app).get('/x').set(a)).status).toBe(429);
    // Mismo origen (supertest siempre llama desde la misma IP), otro empleado: pasa.
    expect((await request(app).get('/x').set(b)).status).toBe(200);
  });

  it('los anónimos siguen compartiendo el cupo de su IP', async () => {
    const app = appWithLimit(2);
    expect((await request(app).get('/x')).status).toBe(200);
    expect((await request(app).get('/x')).status).toBe(200);
    expect((await request(app).get('/x')).status).toBe(429);
  });
});
