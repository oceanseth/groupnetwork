/**
 * Group Network as an OAuth client of masky.ai.
 *
 * Masky is the identity provider and, more usefully, the *twin* provider: every
 * token it issues resolves to an avatar via /oauth/userinfo. A human signing in
 * picks the avatar that represents them and that avatar becomes their digital
 * twin here. An agent authenticates with a service-avatar token
 * (grant_type=client_credentials) and shows up as a real, owned avatar too —
 * which is why humans and agents can share one member model on our side.
 *
 * Contract verified against oceanseth/masky utils/oauth.js:
 *   POST /oauth/token    { grant_type, code, client_id, redirect_uri,
 *                          client_secret | code_verifier }
 *                        -> { access_token, token_type, scope, avatar }
 *   GET  /oauth/userinfo Bearer mky_... -> { sub, name, picture, avatar_id, scope }
 */
const API_BASE = process.env.MASKY_API_BASE || 'https://masky.ai/api';
const CONSENT_URL = 'https://masky.ai/oauth-authorize.html';

/** Scopes Masky exposes; we ask only for what the twin actually needs. */
const DEFAULT_SCOPES = ['profile', 'avatars:read', 'generate'];

/**
 * Where to send the browser to start sign-in. Masky's consent page reads
 * client_id/redirect_uri/scope/state/code_challenge from the query string.
 */
function authorizeUrl({ redirectUri, state, codeChallenge, scopes = DEFAULT_SCOPES }) {
    const q = new URLSearchParams({
        client_id: process.env.MASKY_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
    });
    if (codeChallenge) {
        q.set('code_challenge', codeChallenge);
        q.set('code_challenge_method', 'S256');
    }
    return `${CONSENT_URL}?${q.toString()}`;
}

async function maskyFetch(path, init) {
    const res = await fetch(`${API_BASE}${path}`, init);
    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text || '{}');
    } catch {
        body = { error: 'non_json_response', raw: text.slice(0, 200) };
    }
    return { ok: res.ok, status: res.status, body };
}

/**
 * Exchange an authorization code. We send both the client secret and the PKCE
 * verifier: Masky accepts either, and holding the exchange server-side means
 * the browser never sees a long-lived Masky token.
 */
async function exchangeCode({ code, redirectUri, codeVerifier }) {
    const { ok, status, body } = await maskyFetch('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            client_id: process.env.MASKY_CLIENT_ID,
            client_secret: process.env.MASKY_CLIENT_SECRET,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
        }),
    });
    if (!ok) {
        const err = new Error(body.error || `masky token exchange failed (${status})`);
        err.maskyStatus = status;
        throw err;
    }
    return body; // { access_token, token_type, scope, avatar }
}

/**
 * Resolve a Masky access token to its avatar identity.
 *
 * `sub` is pseudonymous per (user, client, avatar): stable for us, not
 * correlatable across other Masky-connected sites. It is the right key to
 * store as the actor's identity; avatar_id is only for rendering the twin.
 */
async function userinfo(accessToken) {
    const { ok, body } = await maskyFetch('/oauth/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!ok) return null;
    return body; // { sub, name, picture, avatar_id, scope }
}

module.exports = { authorizeUrl, exchangeCode, userinfo, DEFAULT_SCOPES, API_BASE };
