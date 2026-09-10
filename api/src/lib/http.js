/** Request/response plumbing shared by the HTTP router. */
const crypto = require('crypto');

const BASE_HEADERS = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
};

function json(statusCode, body) {
    return { statusCode, headers: BASE_HEADERS, body: JSON.stringify(body) };
}

const ok = (body = {}) => json(200, body);
const created = (body = {}) => json(201, body);

/** Thrown anywhere in a handler; the router turns it into a clean response. */
class HttpError extends Error {
    constructor(statusCode, code, message) {
        super(message || code);
        this.statusCode = statusCode;
        this.code = code;
    }
}

const badRequest = (msg) => new HttpError(400, 'bad_request', msg);
const unauthorized = (msg) => new HttpError(401, 'unauthorized', msg);
const forbidden = (msg) => new HttpError(403, 'forbidden', msg);
const notFound = (msg) => new HttpError(404, 'not_found', msg);
const conflict = (msg) => new HttpError(409, 'conflict', msg);

function parseBody(event) {
    if (!event.body) return {};
    const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf-8')
        : event.body;
    try {
        return JSON.parse(raw || '{}');
    } catch {
        throw badRequest('Body must be valid JSON.');
    }
}

function bearer(event) {
    const h = event.headers?.authorization || event.headers?.Authorization;
    if (!h) return null;
    const [scheme, token] = h.split(/\s+/);
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
    return token;
}

/** Pagination cursors are opaque to the client; they are just a packed key. */
function encodeCursor(key) {
    return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null;
}

function decodeCursor(cursor) {
    if (!cursor) return undefined;
    try {
        return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    } catch {
        throw badRequest('Invalid cursor.');
    }
}

/** Required, non-empty, length-capped string. */
function str(body, field, { max = 500, required = true } = {}) {
    const v = body[field];
    if (v === undefined || v === null || v === '') {
        if (required) throw badRequest(`"${field}" is required.`);
        return undefined;
    }
    if (typeof v !== 'string') throw badRequest(`"${field}" must be a string.`);
    const trimmed = v.trim();
    if (required && !trimmed) throw badRequest(`"${field}" is required.`);
    if (trimmed.length > max) throw badRequest(`"${field}" exceeds ${max} characters.`);
    return trimmed;
}

function oneOf(body, field, allowed, { required = true, fallback } = {}) {
    const v = body[field];
    if (v === undefined || v === null || v === '') {
        if (required) throw badRequest(`"${field}" is required.`);
        return fallback;
    }
    if (!allowed.includes(v)) {
        throw badRequest(`"${field}" must be one of: ${allowed.join(', ')}.`);
    }
    return v;
}

/** Constant-time compare that tolerates unequal lengths. */
function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
    json, ok, created, HttpError,
    badRequest, unauthorized, forbidden, notFound, conflict,
    parseBody, bearer, encodeCursor, decodeCursor, str, oneOf, safeEqual,
};
