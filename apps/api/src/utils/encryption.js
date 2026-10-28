const crypto = require('crypto');

// AES-256-GCM encryption for secrets that must live in the database but never
// in plaintext — currently tenant SMTP passwords (services/tenantSmtp.js).
// GCM is authenticated: decrypt() verifies the tag and throws if the
// ciphertext was tampered with or the key is wrong, so a corrupted value can
// never be silently mis-decrypted into a bad password.
//
// The master secret is ENCRYPTION_KEY from the environment, never committed
// and never logged. Any length is accepted: a 32-byte AES key is derived from
// it with scrypt and a fixed, app-specific salt, so the derivation is
// deterministic (the same secret always yields the same key — required to
// decrypt what an earlier run stored) without forcing the operator to supply
// exactly 32 bytes. Rotating ENCRYPTION_KEY makes existing ciphertext
// undecryptable by design; re-save each secret after a rotation.

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';          // lets the format evolve without ambiguity
const KEY_SALT = 'kgt-encryption-v1';
const IV_BYTES = 12;           // 96-bit nonce, the GCM standard

let cachedKey = null;
let cachedSecret = null;

function masterSecret() {
  const secret = String(process.env.ENCRYPTION_KEY || '').trim();
  if (!secret) {
    throw new Error('ENCRYPTION_KEY is not set — it is required to store or read encrypted secrets (e.g. SMTP passwords).');
  }
  return secret;
}

function derivedKey() {
  const secret = masterSecret();
  if (cachedKey && cachedSecret === secret) return cachedKey; // avoid re-deriving every call
  cachedKey = crypto.scryptSync(secret, KEY_SALT, 32);
  cachedSecret = secret;
  return cachedKey;
}

/** True when a master secret is configured, so callers can fail cleanly before touching data. */
function encryptionConfigured() {
  return !!String(process.env.ENCRYPTION_KEY || '').trim();
}

/**
 * @param {string} plaintext
 * @returns {string} "v1:<iv>:<tag>:<ciphertext>", all base64 — safe to store as TEXT.
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * @param {string} payload a string produced by encrypt()
 * @returns {string} the original plaintext
 * @throws {Error} if the format is unrecognised, or the tag/key don't verify
 */
function decrypt(payload) {
  const parts = String(payload || '').split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unrecognised ciphertext format');
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Whether a stored string looks like our ciphertext (vs. a legacy plaintext value). */
function isEncrypted(payload) {
  return typeof payload === 'string' && payload.startsWith(`${VERSION}:`) && payload.split(':').length === 4;
}

module.exports = { encrypt, decrypt, isEncrypted, encryptionConfigured };
