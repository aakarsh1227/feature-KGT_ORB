const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

// A real key for the suite, set before the module reads it.
before(() => { process.env.ENCRYPTION_KEY = 'unit-test-master-secret-please-ignore'; });

const { encrypt, decrypt, isEncrypted, encryptionConfigured } = require('../../src/utils/encryption');

describe('encryption (AES-256-GCM)', () => {
  test('round-trips plaintext', () => {
    const secret = 'super-secret-smtp-password-!23';
    assert.equal(decrypt(encrypt(secret)), secret);
  });

  test('ciphertext looks nothing like the plaintext and is versioned base64', () => {
    const ct = encrypt('hunter2');
    assert.ok(!ct.includes('hunter2'));
    assert.match(ct, /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.ok(isEncrypted(ct));
    assert.ok(!isEncrypted('hunter2'));
  });

  test('a fresh IV each time means identical plaintext encrypts differently', () => {
    assert.notEqual(encrypt('same'), encrypt('same'));
    assert.equal(decrypt(encrypt('same')), 'same');
  });

  test('tampering with the ciphertext is detected (GCM auth tag)', () => {
    const ct = encrypt('do-not-tamper');
    const parts = ct.split(':');
    const flipped = Buffer.from(parts[3], 'base64');
    flipped[0] ^= 0x01;
    parts[3] = flipped.toString('base64');
    assert.throws(() => decrypt(parts.join(':')));
  });

  test('a wrong key cannot decrypt', () => {
    const ct = encrypt('x');
    process.env.ENCRYPTION_KEY = 'a-completely-different-secret';
    assert.throws(() => decrypt(ct));
    process.env.ENCRYPTION_KEY = 'unit-test-master-secret-please-ignore';
  });

  test('a malformed payload is rejected, not mis-decrypted', () => {
    assert.throws(() => decrypt('not-our-format'));
    assert.throws(() => decrypt('v1:only:three'));
  });

  test('encrypt throws clearly when no master secret is set', () => {
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    assert.equal(encryptionConfigured(), false);
    assert.throws(() => encrypt('x'), /ENCRYPTION_KEY is not set/);
    process.env.ENCRYPTION_KEY = saved;
    assert.equal(encryptionConfigured(), true);
  });
});
