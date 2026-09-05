// Where the payment providers are configured, and how the app knows whether they are
// (docs/PAGOS_SETUP.md).
//
// Secret keys live in environment variables, never in the database. A secret key in
// Postgres is a secret in every backup, every dump and every replica -- and the database
// is also the thing most likely to be handed to someone for a restore. The publishable
// key and the account identifiers are not secrets and reach the browser anyway, but they
// are kept here too so there is exactly one place to look.
//
// Until the keys exist the providers report themselves as not configured and the charging
// endpoints answer 501. Nothing pretends to work.
'use strict';

/** Stripe test keys start with sk_test_/rk_test_; live ones with sk_live_/rk_live_. */
function stripeMode(secret) {
  if (!secret) return null;
  if (secret.startsWith('sk_test_') || secret.startsWith('rk_test_')) return 'test';
  if (secret.startsWith('sk_live_') || secret.startsWith('rk_live_')) return 'live';
  return 'unknown';
}

/** Mercado Pago test credentials carry the TEST- prefix on the access token. */
function mercadoPagoMode(token) {
  if (!token) return null;
  return token.startsWith('TEST-') ? 'test' : 'live';
}

function stripeConfig() {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const missing = [];
  if (!secretKey) missing.push('STRIPE_SECRET_KEY');
  if (!publishableKey) missing.push('STRIPE_PUBLISHABLE_KEY');
  if (!webhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');
  return {
    provider: 'stripe',
    configured: missing.length === 0,
    mode: stripeMode(secretKey),
    missing,
    // Safe to expose: this is the key the browser itself uses.
    publishable_key: publishableKey || null,
    currencies: ['USD', 'MXN'],
    methods: ['card', 'apple_pay', 'google_pay'],
  };
}

function mercadoPagoConfig() {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
  const publicKey = process.env.MERCADOPAGO_PUBLIC_KEY || '';
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET || '';
  const missing = [];
  if (!accessToken) missing.push('MERCADOPAGO_ACCESS_TOKEN');
  if (!publicKey) missing.push('MERCADOPAGO_PUBLIC_KEY');
  if (!webhookSecret) missing.push('MERCADOPAGO_WEBHOOK_SECRET');
  return {
    provider: 'mercadopago',
    configured: missing.length === 0,
    mode: mercadoPagoMode(accessToken),
    missing,
    public_key: publicKey || null,
    currencies: ['MXN'],
    methods: ['card', 'oxxo', 'spei'],
  };
}

/**
 * Live keys outside production are the mistake that charges a real card during a demo,
 * so the app refuses to start that way rather than trusting whoever set the variable.
 */
function assertSafeMode() {
  const env = process.env.NODE_ENV || 'development';
  if (env === 'production') return;
  const live = [];
  if (stripeMode(process.env.STRIPE_SECRET_KEY) === 'live') live.push('Stripe');
  if (mercadoPagoMode(process.env.MERCADOPAGO_ACCESS_TOKEN) === 'live') live.push('Mercado Pago');
  if (live.length > 0) {
    throw new Error(
      `Llaves de PRODUCCIÓN de ${live.join(' y ')} con NODE_ENV=${env}. `
      + 'Fuera de producción usa las llaves de prueba: estas cobrarían tarjetas reales.',
    );
  }
}

function status() {
  const providers = [stripeConfig(), mercadoPagoConfig()];
  return {
    providers,
    // Manual payments (step 3.6) work with no provider at all, which is what the club
    // uses today.
    manual_available: true,
    any_provider_configured: providers.some((p) => p.configured),
  };
}

module.exports = {
  stripeConfig, mercadoPagoConfig, status, assertSafeMode, stripeMode, mercadoPagoMode,
};
