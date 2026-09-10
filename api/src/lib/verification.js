/**
 * Proof that a human is behind an action — deliberately decoupled from *which*
 * human. A successful check writes a receipt; a post then carries the receipt
 * id instead of an author, which is what makes "unattributed but provably
 * human" posts possible.
 *
 * Honest scope note: anonymity here is anonymity *from other members*. The
 * receipt row records the actor so we can rate-limit and act on abuse
 * reports, so an operator with database access can still de-anonymise. Do not
 * describe this to users as anonymity from Group Network itself.
 */
const ddb = require('./ddb');
const { keys } = require('./keys');
const { newReceiptId } = require('./ids');
const { badRequest } = require('./http');

const RECEIPT_TTL_SEC = 15 * 60; // a proof is good for one posting session

/**
 * Cloudflare Turnstile — the "human-only captcha". Fully wired: the client
 * widget produces a token, we redeem it once at siteverify.
 */
const turnstile = {
    id: 'captcha',
    label: 'Human-only captcha',
    available: () => Boolean(process.env.TURNSTILE_SECRET),
    async verify({ token, remoteIp }) {
        if (!token) throw badRequest('Captcha token is required.');
        const form = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET, response: token });
        if (remoteIp) form.set('remoteip', remoteIp);
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form,
        });
        const body = await res.json().catch(() => ({}));
        return {
            verified: body.success === true,
            reason: body.success === true ? null : (body['error-codes'] || ['verification_failed']).join(','),
            strength: 'captcha',
        };
    },
};

/**
 * VoiceCert — voice-biometric proof of a live human, a materially stronger
 * signal than a captcha.
 *
 * NOT WIRED YET. No VoiceCert API contract was available when this was built,
 * so rather than guess at an endpoint and ship something that silently passes
 * everyone, this provider reports itself unavailable until VOICECERT_API_BASE
 * is set and `verify` below is filled in against the real contract.
 */
const voicecert = {
    id: 'voicecert',
    label: 'VoiceCert voice verification',
    available: () => Boolean(process.env.VOICECERT_API_BASE && process.env.VOICECERT_API_KEY),
    async verify({ token }) {
        if (!voicecert.available()) {
            return { verified: false, reason: 'voicecert_not_configured', strength: 'voice' };
        }
        // TODO(contract): replace with the real VoiceCert verification call.
        // Expected shape once known: POST {base}/verify { token } -> { verified, subjectRef }.
        const res = await fetch(`${process.env.VOICECERT_API_BASE.replace(/\/$/, '')}/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.VOICECERT_API_KEY}`,
            },
            body: JSON.stringify({ token }),
        });
        const body = await res.json().catch(() => ({}));
        return {
            verified: res.ok && body.verified === true,
            reason: res.ok ? null : `voicecert_http_${res.status}`,
            strength: 'voice',
        };
    },
};

const PROVIDERS = { captcha: turnstile, voicecert };

/** What the client should offer on the "post without your name" control. */
function availableMethods() {
    return Object.values(PROVIDERS).map((p) => ({
        method: p.id,
        label: p.label,
        available: p.available(),
        strength: p.id === 'voicecert' ? 'voice' : 'captcha',
    }));
}

/**
 * Run a check and, on success, persist a short-lived receipt.
 * The receipt — not the actor — is what an anonymous post references.
 */
async function issueReceipt({ method, token, actorId, remoteIp }) {
    const provider = PROVIDERS[method];
    if (!provider) throw badRequest(`Unknown verification method "${method}".`);
    if (!provider.available()) {
        return { verified: false, reason: `${method}_not_configured`, receipt: null };
    }

    const result = await provider.verify({ token, remoteIp });
    if (!result.verified) return { verified: false, reason: result.reason, receipt: null };

    const now = Date.now();
    const receiptId = newReceiptId();
    await ddb.put({
        ...keys.receipt(receiptId),
        type: 'receipt',
        receiptId,
        method,
        strength: result.strength,
        // Retained for rate-limiting and abuse response only; never returned on
        // a read path that renders an anonymous post.
        actorId,
        issuedAt: now,
        expiresAt: Math.floor(now / 1000) + RECEIPT_TTL_SEC,
    });

    return {
        verified: true,
        receipt: { receiptId, method, strength: result.strength, expiresAt: now + RECEIPT_TTL_SEC * 1000 },
    };
}

/**
 * Redeem a receipt at post time. Must exist, be unexpired, and be the caller's.
 *
 * Single use: the row is deleted on redemption so one check authorises exactly
 * one unattributed post. Without that, a single captcha would mint an unlimited
 * anonymous posting session for its whole TTL.
 */
async function consumeReceipt(receiptId, actorId) {
    const receipt = await ddb.get(keys.receipt(receiptId));
    if (!receipt) throw badRequest('Humanity proof not found, already used, or expired.');
    if (receipt.actorId !== actorId) throw badRequest('Humanity proof belongs to someone else.');
    if (receipt.expiresAt * 1000 < Date.now()) throw badRequest('Humanity proof has expired.');
    await ddb.del(keys.receipt(receiptId));
    return receipt;
}

module.exports = { availableMethods, issueReceipt, consumeReceipt, RECEIPT_TTL_SEC };
