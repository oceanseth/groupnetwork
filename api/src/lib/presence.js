/**
 * Presence is a lease, not a flag.
 *
 * A socket heartbeats and the row's TTL is pushed forward. If the client dies
 * without a clean $disconnect, DynamoDB expires the row on its own and the
 * stream fan-out turns that expiry into an "offline" event. That means nobody
 * is left showing as online because a laptop lid closed — the failure mode that
 * makes most presence indicators untrustworthy.
 */
const ddb = require('./ddb');
const { keys } = require('./keys');

const LEASE_SEC = 90;       // how long a heartbeat keeps an actor online
const HEARTBEAT_SEC = 30;   // what we tell the client to use

const STATUSES = ['online', 'away', 'busy', 'offline'];

function normalizeStatus(status) {
    return STATUSES.includes(status) ? status : 'online';
}

/** Renew the lease. `detail` lets an agent say what it is currently doing. */
async function heartbeat(actorId, { status = 'online', detail = null, connectionId } = {}) {
    const now = Date.now();
    const item = {
        ...keys.presence(actorId),
        type: 'presence',
        actorId,
        status: normalizeStatus(status),
        detail: detail ? String(detail).slice(0, 120) : null,
        connectionId: connectionId || null,
        updatedAt: now,
        expiresAt: Math.floor(now / 1000) + LEASE_SEC,
    };
    await ddb.put(item);
    return item;
}

/** Explicit sign-off. Deleting the row makes the stream emit offline at once. */
async function clear(actorId) {
    await ddb.del(keys.presence(actorId));
}

function isLive(row) {
    return Boolean(row) && row.expiresAt * 1000 > Date.now();
}

function view(row, fallbackLastSeen) {
    if (!isLive(row)) {
        return { status: 'offline', detail: null, lastSeen: row?.updatedAt || fallbackLastSeen || null };
    }
    return { status: row.status, detail: row.detail || null, lastSeen: row.updatedAt };
}

async function get(actorId) {
    return view(await ddb.get(keys.presence(actorId)));
}

/** Presence for a member list in one round of reads. */
async function getMany(actorIds) {
    const unique = [...new Set(actorIds.filter(Boolean))];
    const rows = await Promise.all(unique.map((id) => ddb.get(keys.presence(id))));
    const map = new Map();
    unique.forEach((id, i) => map.set(id, view(rows[i])));
    return map;
}

module.exports = { LEASE_SEC, HEARTBEAT_SEC, STATUSES, heartbeat, clear, get, getMany, view, isLive };
