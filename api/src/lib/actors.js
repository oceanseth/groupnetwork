/**
 * An actor is a member of the network. `kind` is 'human' or 'agent' and that
 * is the only structural difference between them — both hold handles, walls,
 * group memberships and conversations. Groups then filter on `kind`, which is
 * how human-only / agent-human / agent-only becomes a one-field check instead
 * of two parallel data models.
 */
const ddb = require('./ddb');
const { keys } = require('./keys');
const { newActorId, normalizeHandle, suggestHandle } = require('./ids');
const { badRequest, conflict, notFound } = require('./http');

/** The shape every client sees. Nothing sensitive is in here. */
function publicActor(actor, presence) {
    if (!actor) return null;
    return {
        actorId: actor.actorId,
        kind: actor.kind,
        handle: actor.handle,
        displayName: actor.displayName,
        avatarUrl: actor.avatarUrl || null,
        bio: actor.bio || '',
        twin: actor.twin
            ? { source: actor.twin.source, avatarId: actor.twin.avatarId, name: actor.twin.name, active: Boolean(actor.twin.active) }
            : null,
        operatorActorId: actor.operatorActorId || null,
        createdAt: actor.createdAt,
        presence: presence || { status: 'offline', lastSeen: actor.lastSeen || null },
    };
}

async function byId(actorId) {
    return ddb.get(keys.actor(actorId));
}

async function byHandle(handle) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return null;
    const claim = await ddb.get(keys.handle(normalized));
    return claim?.actorId ? byId(claim.actorId) : null;
}

/** Resolve `usr_...`/`agt_...` or `@handle` — used by routes that accept either. */
async function resolve(ref) {
    if (!ref) return null;
    return /^(usr|agt)_/.test(ref) ? byId(ref) : byHandle(ref);
}

/**
 * Claim a handle and write the actor in one transaction, so two people racing
 * for the same handle cannot both win.
 */
async function create({ kind, handle, displayName, avatarUrl, twin, operatorActorId, identity, onboarded = true }) {
    const normalized = normalizeHandle(handle) || normalizeHandle(suggestHandle(displayName));
    if (!normalized) throw badRequest('Handle must be 3-30 characters: letters, numbers or underscore.');

    const actorId = newActorId(kind);
    const now = Date.now();
    const actor = {
        ...keys.actor(actorId),
        gsi1pk: `HANDLE#${normalized}`,
        gsi1sk: `ACTOR#${actorId}`,
        type: 'actor',
        actorId,
        kind,
        handle: normalized,
        displayName: displayName || normalized,
        avatarUrl: avatarUrl || null,
        bio: '',
        twin: twin || null,
        operatorActorId: operatorActorId || null,
        // Agents are usable the moment they are registered; people go through
        // the onboarding screen first.
        onboarded,
        createdAt: now,
        lastSeen: now,
    };

    const items = [
        { Put: { TableName: ddb.TABLE, Item: actor, ConditionExpression: 'attribute_not_exists(pk)' } },
        {
            Put: {
                TableName: ddb.TABLE,
                Item: { ...keys.handle(normalized), type: 'handle', actorId, claimedAt: now },
                ConditionExpression: 'attribute_not_exists(pk)',
            },
        },
    ];

    // Identity links (Masky `sub` or Google `sub`) are unique per actor, so a
    // second sign-in finds the existing actor instead of forking a new one.
    if (identity?.masky) {
        items.push({
            Put: {
                TableName: ddb.TABLE,
                Item: { ...keys.maskyLink(identity.masky), type: 'link', actorId, linkedAt: now },
                ConditionExpression: 'attribute_not_exists(pk)',
            },
        });
    }
    if (identity?.google) {
        items.push({
            Put: {
                TableName: ddb.TABLE,
                Item: { ...keys.googleLink(identity.google), type: 'link', actorId, linkedAt: now },
                ConditionExpression: 'attribute_not_exists(pk)',
            },
        });
    }

    try {
        await ddb.transact(items);
    } catch (err) {
        if (err.name === 'TransactionCanceledException') {
            throw conflict(`Handle "@${normalized}" is already taken.`);
        }
        throw err;
    }
    return actor;
}

async function update(actorId, patch) {
    const names = {};
    const values = {};
    const sets = [];
    for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        names[`#${field}`] = field;
        values[`:${field}`] = value;
        sets.push(`#${field} = :${field}`);
    }
    if (!sets.length) return byId(actorId);
    return ddb.update(keys.actor(actorId), {
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(pk)',
    });
}

/** Bulk-load actors for a member list, deduped, in one pass. */
async function hydrate(actorIds) {
    const unique = [...new Set(actorIds.filter(Boolean))];
    const loaded = await Promise.all(unique.map(byId));
    const map = new Map();
    loaded.forEach((a) => { if (a) map.set(a.actorId, a); });
    return map;
}

async function require_(actorId) {
    const actor = await byId(actorId);
    if (!actor) throw notFound('No such member.');
    return actor;
}

module.exports = { publicActor, byId, byHandle, resolve, create, update, hydrate, require: require_ };
