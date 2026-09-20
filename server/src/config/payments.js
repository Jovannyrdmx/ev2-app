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

/**
 * Which Mercado Pago account the token belongs to. Says so out loud, in a variable.
 *
 * This used to read the prefix: `TEST-` meant test, anything else meant live. That was
 * true once and is not true now -- Mercado Pago hands out a TEST access token that
 * begins with `APP_USR`, exactly like the production one, and the two are told apart
 * only by which panel tab you copied them from. Guessing from the prefix would now call
 * a test token "live" (the app would refuse to start outside production, which is
 * annoying) and -- the day the format changes again -- could call a LIVE token "test",
 * which is the mistake that charges a real card during a rehearsal.
 *
 * So it is not guessed. `MERCADOPAGO_ENV` is declared by whoever sets up the server, and
 * `services/mercadopago.js` checks that declaration against the `live_mode` flag that
 * Mercado Pago itself puts on every response. If the two disagree, the charge stops:
 * a mismatch means somebody pasted the wrong credentials, and that is precisely the
 * moment to stop rather than to keep going and find out from a bank statement.
 */
function mercadoPagoMode(token, declared = process.env.MERCADOPAGO_ENV) {
  if (!token) return null;
  const said = String(declared || '').trim().toLowerCase();
  if (said === 'test' || said === 'live') return said;
  // Legacy tokens still carry the old prefix and say what they are on their own.
  if (token.startsWith('TEST-')) return 'test';
  return 'undeclared';
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
  const mode = mercadoPagoMode(accessToken);
  const missing = [];
  if (!accessToken) missing.push('MERCADOPAGO_ACCESS_TOKEN');
  if (!publicKey) missing.push('MERCADOPAGO_PUBLIC_KEY');
  if (accessToken && mode === 'undeclared') missing.push('MERCADOPAGO_ENV');
  return {
    provider: 'mercadopago',
    // The webhook secret is NOT required to charge. It is required to trust an incoming
    // notification -- and this integration never trusts one anyway: when a webhook
    // arrives, the order is fetched again with our own token and the answer to that is
    // what moves money. So a club without the secret can still take payments; it just
    // gets no signature to check. `webhook_verified` says which of the two it is.
    configured: missing.length === 0,
    webhook_verified: Boolean(webhookSecret),
    mode,
    missing,
    public_key: publicKey || null,
    currencies: ['MXN'],
    methods: ['card', 'oxxo', 'spei'],
    // The terminal is the only Mercado Pago method wired today (D47). The rest of the
    // list above is what the account can do, not what this system does.
    in_person: true,
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
  // 'undeclared' does NOT count as live: it means nobody said, and refusing to start
  // over a missing label would stop a development server for a reason that has nothing
  // to do with money. What it does mean is that no charge can be made -- the client
  // refuses that separately -- so an unlabelled token can never reach a card.
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
