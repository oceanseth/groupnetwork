/**
 * Bring your own brain.
 *
 * A twin is only as useful as the model behind it, so a member connects their
 * own harness: an Anthropic key, an OpenAI key, or any OpenAI-compatible
 * endpoint — which is how open-weights models (vLLM, Ollama, llama.cpp, a
 * hosted Llama/Mistral/Qwen endpoint) attach without needing a provider
 * integration each.
 *
 * Credentials are KMS-sealed on write (see secrets.js) and never returned.
 * Validation deliberately uses each provider's model-listing endpoint: it
 * proves the key works without spending a single inference token.
 */
const ddb = require('./ddb');
const { keys } = require('./keys');
const { newHarnessId } = require('./ids');
const { badRequest, notFound } = require('./http');
const { sealKey, fingerprint } = require('./secrets');

const PROVIDERS = {
    anthropic: {
        label: 'Claude (Anthropic)',
        defaultBaseUrl: 'https://api.anthropic.com',
        defaultModel: 'claude-sonnet-5',
        suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        allowCustomBaseUrl: false,
        authHeaders: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
        probePath: '/v1/models',
    },
    openai: {
        label: 'OpenAI',
        defaultBaseUrl: 'https://api.openai.com',
        defaultModel: 'gpt-4o',
        suggestedModels: ['gpt-4o', 'gpt-4o-mini', 'o3'],
        allowCustomBaseUrl: false,
        authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
        probePath: '/v1/models',
    },
    custom: {
        label: 'Custom / open-weights (OpenAI-compatible)',
        defaultBaseUrl: '',
        defaultModel: '',
        suggestedModels: [],
        allowCustomBaseUrl: true,
        authHeaders: (key) => (key ? { Authorization: `Bearer ${key}` } : {}),
        probePath: '/v1/models',
    },
};

/** What the settings screen renders. No secrets, no per-member data. */
function providerCatalog() {
    return Object.entries(PROVIDERS).map(([id, p]) => ({
        provider: id,
        label: p.label,
        defaultBaseUrl: p.defaultBaseUrl,
        defaultModel: p.defaultModel,
        suggestedModels: p.suggestedModels,
        allowCustomBaseUrl: p.allowCustomBaseUrl,
        requiresApiKey: id !== 'custom',
    }));
}

function publicHarness(row) {
    return {
        harnessId: row.harnessId,
        provider: row.provider,
        label: row.label,
        model: row.model,
        baseUrl: row.baseUrl,
        isDefault: Boolean(row.isDefault),
        status: row.status,
        statusDetail: row.statusDetail || null,
        keyLast4: row.keyLast4 || null,
        createdAt: row.createdAt,
        verifiedAt: row.verifiedAt || null,
    };
}

/**
 * Only http(s), and no obvious loopback/link-local targets — a member-supplied
 * base URL is fetched by our Lambda, so it is an SSRF surface. This blocks the
 * casual cases; a VPC egress policy is the real control.
 */
function assertSafeBaseUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw badRequest('Base URL must be a valid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw badRequest('Base URL must use http or https.');
    }
    const host = url.hostname.toLowerCase();
    const blocked = host === 'localhost'
        || host === '::1'
        || host.endsWith('.localhost')
        || /^127\./.test(host)
        || /^10\./.test(host)
        || /^192\.168\./.test(host)
        || /^169\.254\./.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (blocked) throw badRequest('Base URL must be publicly reachable, not a private address.');
    return url.origin + url.pathname.replace(/\/$/, '');
}

/** Prove the credential works, cheaply, before we store it as connected. */
async function probe({ provider, baseUrl, apiKey }) {
    const spec = PROVIDERS[provider];
    const target = `${(baseUrl || spec.defaultBaseUrl).replace(/\/$/, '')}${spec.probePath}`;
    try {
        const res = await fetch(target, {
            method: 'GET',
            headers: spec.authHeaders(apiKey),
            signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return { status: 'connected', detail: null };
        if (res.status === 401 || res.status === 403) {
            return { status: 'invalid_key', detail: 'The provider rejected this API key.' };
        }
        return { status: 'unreachable', detail: `Provider responded ${res.status}.` };
    } catch (err) {
        const detail = err.name === 'TimeoutError'
            ? 'The endpoint did not respond within 8 seconds.'
            : `Could not reach the endpoint: ${err.message}`;
        return { status: 'unreachable', detail };
    }
}

async function connect({ actor, provider, label, model, baseUrl, apiKey, makeDefault }) {
    const spec = PROVIDERS[provider];
    if (!spec) throw badRequest(`"provider" must be one of: ${Object.keys(PROVIDERS).join(', ')}.`);

    let resolvedBase = spec.defaultBaseUrl;
    if (spec.allowCustomBaseUrl) {
        if (!baseUrl) throw badRequest('A custom harness needs a base URL.');
        resolvedBase = assertSafeBaseUrl(baseUrl);
    }
    if (!spec.allowCustomBaseUrl && !apiKey) throw badRequest('An API key is required for this provider.');

    const resolvedModel = model || spec.defaultModel;
    if (!resolvedModel) throw badRequest('A model name is required for this provider.');

    const result = await probe({ provider, baseUrl: resolvedBase, apiKey });

    const harnessId = newHarnessId();
    const now = Date.now();
    const row = {
        ...keys.harness(actor.actorId, harnessId),
        type: 'harness',
        harnessId,
        actorId: actor.actorId,
        provider,
        label: label || spec.label,
        model: resolvedModel,
        baseUrl: resolvedBase,
        // Sealed under the CMK with the actor bound in as encryption context.
        sealedKey: apiKey ? await sealKey(apiKey, actor.actorId) : null,
        keyLast4: apiKey ? fingerprint(apiKey).last4 : null,
        isDefault: Boolean(makeDefault),
        status: result.status,
        statusDetail: result.detail,
        createdAt: now,
        verifiedAt: result.status === 'connected' ? now : null,
    };
    await ddb.put(row);

    if (row.isDefault) await setDefault(actor.actorId, harnessId);
    return row;
}

async function list(actorId) {
    const { items } = await ddb.query({ ...keys.harnessPrefix(actorId), limit: 50 });
    return items;
}

async function get(actorId, harnessId) {
    const row = await ddb.get(keys.harness(actorId, harnessId));
    if (!row) throw notFound('No such harness connection.');
    return row;
}

/** Exactly one default per actor. */
async function setDefault(actorId, harnessId) {
    const all = await list(actorId);
    await Promise.all(all.map((row) => ddb.update(keys.harness(actorId, row.harnessId), {
        UpdateExpression: 'SET isDefault = :v',
        ExpressionAttributeValues: { ':v': row.harnessId === harnessId },
    })));
}

async function remove(actorId, harnessId) {
    await get(actorId, harnessId);
    await ddb.del(keys.harness(actorId, harnessId));
}

/** Re-run the credential check for an already-stored connection. */
async function reverify(actorId, harnessId) {
    const row = await get(actorId, harnessId);
    const { openKey } = require('./secrets');
    const apiKey = row.sealedKey ? await openKey(row.sealedKey, actorId) : null;
    const result = await probe({ provider: row.provider, baseUrl: row.baseUrl, apiKey });
    return ddb.update(keys.harness(actorId, harnessId), {
        UpdateExpression: 'SET #s = :s, statusDetail = :d, verifiedAt = :v',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
            ':s': result.status,
            ':d': result.detail,
            ':v': result.status === 'connected' ? Date.now() : row.verifiedAt || null,
        },
    });
}

module.exports = {
    PROVIDERS, providerCatalog, publicHarness, assertSafeBaseUrl, probe,
    connect, list, get, setDefault, remove, reverify,
};
