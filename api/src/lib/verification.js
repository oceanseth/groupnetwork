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
 * Cloudflare Turnstile — the "human-only captcha". The weaker of the two
 * providers and deliberately the fallback: it proves "not a trivial bot", not
 * "a live person". Offered when VoiceCert is unavailable or the member cannot
 * complete a voice check right now.
 */
const turnstile = {
    id: 'captcha',
    label: 'Human-only captcha',
    strength: 'captcha',
    siteKey: () => process.env.TURNSTILE_SITE_KEY || '',
    available: () => Boolean(process.env.TURNSTILE_SECRET && process.env.TURNSTILE_SITE_KEY),
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
 * VoiceCert — voice-biometric proof of a live human, and the primary provider
 * here. A captcha proves a bot did not fill the form; a voice check proves a
 * person was present, which is the claim an unattributed post actually makes.
 *
 * The browser half is VoiceCert's own widget: it opens a session, deep-links or
 * QR-codes the member into the VoiceCert app, polls until the check passes, and
 * hands back a token. This is the server half — redeeming that token.
 *
 * Contract note, because it is not written down anywhere else: the redeem
 * endpoint is Turnstile-*shaped* but not Turnstile-*compatible*. It accepts
 * JSON only, and the field is `token`, not `response`. Posting a form body (the
 * natural thing to do when porting Turnstile code) is not rejected — it comes
 * back `missing-input-response`, which reads like a client bug rather than a
 * content-type mistake. Hence the explicit JSON here.
 */
const voicecert = {
    id: 'voicecert',
    label: 'VoiceCert voice verification',
    strength: 'voice',
    siteKey: () => process.env.VOICECERT_SITE_KEY || '',
    available: () => Boolean(
        process.env.VOICECERT_API_BASE
        && process.env.VOICECERT_SECRET
        && process.env.VOICECERT_SITE_KEY,
    ),
    async verify({ token }) {
        if (!voicecert.available()) {
            return { verified: false, reason: 'voicecert_not_configured', strength: 'voice' };
        }
        if (!token) throw badRequest('VoiceCert token is required.');

        let res;
        try {
            res = await fetch(`${process.env.VOICECERT_API_BASE.replace(/\/$/, '')}/v1/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ secret: process.env.VOICECERT_SECRET, token }),
            });
        } catch (err) {
            // Fail closed. An unreachable verifier must never mint a receipt.
            return { verified: false, reason: 'voicecert_unreachable', strength: 'voice' };
        }

        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { verified: false, reason: `voicecert_http_${res.status}`, strength: 'voice' };

        return {
            verified: body.success === true,
            reason: body.success === true ? null : (body['error-codes'] || ['verification_failed']).join(','),
            strength: 'voice',
            // VoiceCert's watermarking ties a member's published content back to
            // their verification. If the redeem response carries such a handle we
            // keep it on the receipt (server-side only — it is a correlator, so it
            // must never reach a read path that renders an anonymous post).
            subjectRef: body.watermark || body.subject || body.sub || null,
        };
    },
};

// Order matters: this is the order the composer offers them in, and VoiceCert
// is the stronger proof.
const PROVIDERS = { voicecert, captcha: turnstile };

/**
 * What the client should offer on the "post without your name" control.
 *
 * Site keys are served from here rather than baked in at build time: they are
 * public by definition, and shipping them at runtime means rotating a key is a
 * stack parameter change instead of a frontend rebuild and CloudFront
 * invalidation.
 */
function availableMethods() {
    return Object.values(PROVIDERS).map((p) => ({
        method: p.id,
        label: p.label,
        available: p.available(),
        strength: p.strength,
        siteKey: p.available() ? p.siteKey() : '',
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
        subjectRef: result.subjectRef || null,
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
