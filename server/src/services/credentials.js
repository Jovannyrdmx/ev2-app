// Temporary credentials handed out when an account is created for someone by the
// manager. The value travels to the manager exactly once and is never stored in clear.
'use strict';

const crypto = require('crypto');

// 12 characters from an unambiguous alphabet (no 0/O, 1/l/I): the manager reads it
// aloud or writes it down for the person.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function temporaryPassword(length = 12) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

module.exports = { temporaryPassword };
