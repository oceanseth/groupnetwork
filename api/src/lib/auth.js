/**
 * Who is calling?
 *
 * Two credentials reach this service and both resolve to the same thing — an
 * `actor` row — which is what lets a group hold humans and agents side by side:
 *
 *   gn_<jwt>   a Group Network session, minted after Google or Masky sign-in.
 *   mky_...    a Masky service-avatar token, presented by an agent acting as
 *              itself. We resolve it at masky.ai and map the avatar to an actor.
 */
const crypto = require('crypto');
const ddb = require('./ddb');
const { keys } = require('./keys');
const masky = require('./masky');
const { unauthorized, forbidden } = require('./http');

const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url');

// ---------------------------------------------------------------- sessions --

function signSession(payload) {
    const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const body = b64(JSON.stringify({ ...payload, iat: now, exp: now + SESSION_TTL_SEC }));
    const data = `${header}.${body}`;
    const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(data).digest('base64url');
    return `gn_${data}.${sig}`;
}

function verifySession(token) {
    if (!token || !token.startsWith('gn_')) return null;
    const parts = token.slice(3).split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET)
        .update(`${header}.${body}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let claims;
    try {
        claims = JSON.parse(unb64(body).toString('utf-8'));
    } catch {
        return null;
    }
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
}

// ------------------------------------------------------- Google ID tokens --

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
let jwksCache = { keys: [], expiresAt: 0 };

async function googleJwks() {
    if (jwksCache.expiresAt > Date.now()) return jwksCache.keys;
    const res = await fetch(GOOGLE_JWKS_URL);
    if (!res.ok) throw unauthorized('Could not fetch Google signing keys.');
    const body = await res.json();
    // Respect Google's cache-control; fall back to an hour.
    const cc = res.headers.get('cache-control') || '';
    const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] || 3600);
    jwksCache = { keys: body.keys || [], expiresAt: Date.now() + maxAge * 1000 };
    return jwksCache.keys;
}

/**
 * Verify a Google Identity Services ID token locally against Google's JWKS.
 * Returns the claims, or throws. We check signature, issuer, audience and
 * expiry — skipping any one of those makes the token forgeable.
 */
async function verifyGoogleIdToken(idToken) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw unauthorized('Malformed Google ID token.');
    const [header, body, sig] = parts;

    let head;
    let claims;
    try {
        head = JSON.parse(unb64(header).toString('utf-8'));
        claims = JSON.parse(unb64(body).toString('utf-8'));
    } catch {
        throw unauthorized('Malformed Google ID token.');
    }
    if (head.alg !== 'RS256') throw unauthorized('Unexpected Google token algorithm.');

    const jwk = (await googleJwks()).find((k) => k.kid === head.kid);
    if (!jwk) throw unauthorized('Unknown Google signing key.');

    const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verified = crypto.createVerify('RSA-SHA256')
        .update(`${header}.${body}`)
        .verify(pubKey, unb64(sig));
    if (!verified) throw unauthorized('Google ID token signature is invalid.');

    if (!GOOGLE_ISSUERS.includes(claims.iss)) throw unauthorized('Unexpected token issuer.');
    // Without a configured client id every audience would be a mismatch, which
    // surfaces as "not issued for this app" — a misleading error for what is
    // really an unconfigured deployment.
    if (!process.env.GOOGLE_CLIENT_ID) throw unauthorized('Google sign-in is not configured on this deployment.');
    if (claims.aud !== process.env.GOOGLE_CLIENT_ID) throw unauthorized('Token was not issued for this app.');
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) throw unauthorized('Google ID token has expired.');

    return claims; // { sub, email, email_verified, name, picture, ... }
}

// ------------------------------------------------------------ agent tokens --

/**
 * Resolve a Masky service-avatar token to an actor. The avatar's pseudonymous
 * `sub` is the identity key, so an agent must have been registered here once
 * (POST /agents/register) before it can act.
 */
async function resolveAgentToken(token) {
    const info = await masky.userinfo(token);
    if (!info?.sub) throw unauthorized('Masky did not recognise this token.');
    const link = await ddb.get(keys.maskyLink(info.sub));
    if (!link?.actorId) {
        throw forbidden('This Masky avatar is not registered on Group Network. Register the agent first.');
    }
    const actor = await ddb.get(keys.actor(link.actorId));
    if (!actor) throw unauthorized('Actor record is missing.');
    return actor;
}

/**
 * The caller for this request, or null when unauthenticated.
 * Handlers that require a caller use `requireActor`.
 */
async function currentActor(token) {
    if (!token) return null;
    if (token.startsWith('gn_')) {
        const claims = verifySession(token);
        if (!claims?.sub) return null;
        return ddb.get(keys.actor(claims.sub));
    }
    if (token.startsWith('mky_')) return resolveAgentToken(token);
    return null;
}

async function requireActor(token) {
    const actor = await currentActor(token);
    if (!actor) throw unauthorized('Sign in to continue.');
    return actor;
}

module.exports = {
    signSession, verifySession, verifyGoogleIdToken,
    currentActor, requireActor, resolveAgentToken, SESSION_TTL_SEC,
};
