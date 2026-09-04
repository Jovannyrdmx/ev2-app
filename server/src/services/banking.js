// Bank account validation and encryption helpers (D19).
//
// Account numbers are encrypted at rest with pgcrypto (pgp_sym_encrypt) using a key that
// lives only in the server's environment. Nothing in this module ever returns a full
// account number: callers get the last four digits and that is all the API exposes.
'use strict';

const { ApiError } = require('../middleware/errors');

/** The symmetric key. Missing key = the server must not handle bank data at all. */
function encryptionKey() {
  const key = process.env.BANK_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('BANK_ENCRYPTION_KEY is required (at least 32 characters) to store bank accounts');
  }
  return key;
}

/**
 * CLABE: 18 digits; the 18th is a check digit over the first 17 with weights 3,7,1
 * repeating, summing (digit * weight) mod 10, check = (10 - sum mod 10) mod 10.
 */
function isValidClabe(value) {
  if (!/^\d{18}$/.test(value)) return false;
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += (Number(value[i]) * weights[i % 3]) % 10;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(value[17]);
}

/** ABA routing number: 9 digits, weights 3,7,1 repeating, total must be divisible by 10. */
function isValidAbaRouting(value) {
  if (!/^\d{9}$/.test(value)) return false;
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(value[i]) * weights[i % 3];
  return sum % 10 === 0;
}

/** US account numbers vary by bank; 4 to 17 digits is the accepted range. */
function isValidUsAccount(value) {
  return /^\d{4,17}$/.test(value);
}

/**
 * Validates the raw input for one account and returns what the INSERT needs.
 * Throws a 422 with a plain-language message on any problem.
 */
function normalizeAccount(input) {
  if (input.type === 'clabe') {
    const clabe = String(input.account_number || '').replace(/\s/g, '');
    if (!isValidClabe(clabe)) {
      throw ApiError.unprocessable('La CLABE no es válida: deben ser 18 dígitos y el dígito verificador no coincide');
    }
    return { country: 'MX', account: clabe, routing: null, last4: clabe.slice(-4), routingLast4: null };
  }

  const routing = String(input.routing_number || '').replace(/\s/g, '');
  const account = String(input.account_number || '').replace(/\s/g, '');
  if (!isValidAbaRouting(routing)) {
    throw ApiError.unprocessable('El routing number no es válido: deben ser 9 dígitos con checksum ABA correcto');
  }
  if (!isValidUsAccount(account)) {
    throw ApiError.unprocessable('El número de cuenta de EE. UU. debe tener entre 4 y 17 dígitos');
  }
  return { country: 'US', account, routing, last4: account.slice(-4), routingLast4: routing.slice(-4) };
}

/** What the API shows for an account. Never the number. */
function maskAccount(row) {
  return {
    id: row.id,
    country: row.country,
    type: row.type,
    bank_name: row.bank_name,
    holder_name: row.holder_name,
    account_masked: `****${row.account_last4}`,
    routing_masked: row.routing_last4 ? `****${row.routing_last4}` : null,
    is_default: row.is_default,
    verified: !!row.verified_at,
    verified_at: row.verified_at,
    created_at: row.created_at,
  };
}

module.exports = {
  encryptionKey, isValidClabe, isValidAbaRouting, isValidUsAccount, normalizeAccount, maskAccount,
};
