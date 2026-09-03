// supertest wrapper: builds the app once and signs tokens without going through login
// (login itself is covered by the auth suite).
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/middleware/auth');

const app = createApp();
const api = () => request(app);

/** Authorization header for a user row from the factories. */
function auth(user) {
  return { Authorization: `Bearer ${signAccessToken(user)}` };
}

module.exports = { app, api, auth };
