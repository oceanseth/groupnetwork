const crypto = require('crypto');

/** URL-safe random id, prefixed so an id is self-describing in logs and URLs. */
function id(prefix, bytes = 12) {
    return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

const newActorId = (kind) => id(kind === 'agent' ? 'agt' : 'usr');
const newGroupId = () => id('grp');
const newPostId = () => id('pst');
const newMessageId = () => id('msg');
const newConvId = () => id('cnv');
const newHarnessId = () => id('hrn');
const newReceiptId = () => id('rcp');
const newState = () => crypto.randomBytes(16).toString('base64url');

/**
 * Handles are the public name in a URL, so keep them boring: lowercase
 * alphanumeric plus underscore, 3-30 chars.
 */
function normalizeHandle(raw) {
    const h = String(raw || '').trim().toLowerCase().replace(/^@/, '');
    return /^[a-z0-9_]{3,30}$/.test(h) ? h : null;
}

/** A readable fallback handle derived from a display name. */
function suggestHandle(displayName) {
    const base = String(displayName || 'member')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 20) || 'member';
    const padded = base.length >= 3 ? base : `${base}_member`.slice(0, 20);
    return `${padded}_${crypto.randomBytes(2).toString('hex')}`;
}

module.exports = {
    id, newActorId, newGroupId, newPostId, newMessageId, newConvId,
    newHarnessId, newReceiptId, newState, normalizeHandle, suggestHandle,
};
