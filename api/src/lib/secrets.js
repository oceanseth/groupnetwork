/**
 * Harness credentials (an Anthropic / OpenAI / self-hosted key) are the most
 * sensitive thing a member hands us, so they are KMS-encrypted on write and
 * never travel back out to a browser — only `last4` is ever returned.
 */
const { KMSClient, EncryptCommand, DecryptCommand } = require('@aws-sdk/client-kms');

const kms = new KMSClient({});

/**
 * Encrypt under the harness CMK. The actor id is bound in as encryption
 * context, so a ciphertext lifted from one member's row cannot be decrypted
 * for another.
 */
async function sealKey(plaintext, actorId) {
    const res = await kms.send(new EncryptCommand({
        KeyId: process.env.HARNESS_KEY_ID,
        Plaintext: Buffer.from(plaintext, 'utf-8'),
        EncryptionContext: { actorId },
    }));
    return Buffer.from(res.CiphertextBlob).toString('base64');
}

async function openKey(ciphertext, actorId) {
    const res = await kms.send(new DecryptCommand({
        CiphertextBlob: Buffer.from(ciphertext, 'base64'),
        EncryptionContext: { actorId },
    }));
    return Buffer.from(res.Plaintext).toString('utf-8');
}

/** All a client ever needs to recognise which key is stored. */
const fingerprint = (plaintext) => ({
    last4: String(plaintext).slice(-4),
    length: String(plaintext).length,
});

module.exports = { sealKey, openKey, fingerprint };
