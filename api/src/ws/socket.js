/**
 * The realtime socket: $connect, $disconnect and every client action.
 *
 * This handler only ever *writes*. It never pushes an event to other members
 * directly — those go out from the DynamoDB stream fan-out, so a message sent
 * over HTTP and a message sent over the socket produce byte-identical events
 * for every recipient. One delivery path, no drift.
 */
const ddb = require('../lib/ddb');
const { keys, topics } = require('../lib/keys');
const actors = require('../lib/actors');
const groups = require('../lib/groups');
const presence = require('../lib/presence');
const conversations = require('../lib/conversations');
const { sendToConnection, reapConnection } = require('../lib/push');

const CONNECTION_TTL_SEC = 12 * 60 * 60; // hard ceiling; API Gateway caps at 2h anyway

function endpointFor(event) {
    const { domainName, stage } = event.requestContext;
    return `https://${domainName}/${stage}`;
}

/** Redeem the single-use ticket minted by POST /realtime/ticket. */
async function redeemTicket(ticket) {
    if (!ticket) return null;
    const key = { pk: `TICKET#${ticket}`, sk: 'META' };
    const row = await ddb.get(key);
    if (!row) return null;
    await ddb.del(key); // single use
    if (row.expiresAt * 1000 < Date.now()) return null;
    return actors.byId(row.actorId);
}

/** Topics a member may subscribe to, checked against real membership. */
async function authorizeTopics(actor, requested) {
    const allowed = [];
    for (const topic of requested.slice(0, 100)) {
        const [kind, id] = String(topic).split(':');
        if (!kind || !id) continue;

        if (kind === 'group') {
            const group = await groups.byId(id);
            if (!group) continue;
            // Public groups are readable by anyone signed in; private needs membership.
            if (group.visibility === 'public' || await groups.membership(id, actor.actorId)) {
                allowed.push(topic);
            }
        } else if (kind === 'conv') {
            if (await ddb.get(keys.convParticipant(id, actor.actorId))) allowed.push(topic);
        } else if (kind === 'wall' || kind === 'presence') {
            // Walls and presence are public surfaces.
            allowed.push(topic);
        }
    }
    return allowed;
}

async function subscribe(connectionId, actor, requested) {
    const allowed = await authorizeTopics(actor, requested);
    const expiresAt = Math.floor(Date.now() / 1000) + CONNECTION_TTL_SEC;
    await Promise.all(allowed.map((topic) => ddb.put({
        ...keys.subscription(topic, connectionId),
        gsi1pk: `CONN#${connectionId}`,
        gsi1sk: `TOPIC#${topic}`,
        type: 'subscription',
        topic,
        connectionId,
        actorId: actor.actorId,
        expiresAt,
    })));
    return allowed;
}

async function unsubscribe(connectionId, requested) {
    await ddb.batchDelete(requested.map((topic) => keys.subscription(topic, connectionId)));
    return requested;
}

// ------------------------------------------------------------------ routes --

async function onConnect(event) {
    const connectionId = event.requestContext.connectionId;
    const ticket = event.queryStringParameters?.ticket;
    const actor = await redeemTicket(ticket);
    // 401 here makes API Gateway reject the handshake outright.
    if (!actor) return { statusCode: 401, body: 'Invalid or expired ticket.' };

    const now = Date.now();
    await ddb.put({
        ...keys.connection(connectionId),
        type: 'connection',
        connectionId,
        actorId: actor.actorId,
        actorKind: actor.kind,
        connectedAt: now,
        expiresAt: Math.floor(now / 1000) + CONNECTION_TTL_SEC,
    });

    // Coming online is itself a presence write, so the stream announces it.
    await presence.heartbeat(actor.actorId, { status: 'online', connectionId });

    // Auto-subscribe to the member's own groups and wall — the things they
    // would immediately ask for anyway.
    const mine = await groups.groupsForActor(actor.actorId);
    await subscribe(connectionId, actor, [
        ...mine.map(({ group }) => topics.group(group.groupId)),
        topics.wall(actor.actorId),
        topics.presence(actor.actorId),
    ]);

    return { statusCode: 200, body: 'connected' };
}

async function onDisconnect(event) {
    const connectionId = event.requestContext.connectionId;
    const conn = await ddb.get(keys.connection(connectionId));
    await reapConnection(connectionId);

    if (conn?.actorId) {
        // Only clear presence if this socket is the one currently holding it —
        // otherwise closing one tab would knock the member offline in another.
        const current = await ddb.get(keys.presence(conn.actorId));
        if (current?.connectionId === connectionId) await presence.clear(conn.actorId);
    }
    return { statusCode: 200, body: 'disconnected' };
}

const ACTIONS = {
    async ping(_ctx) {
        return { type: 'pong', at: Date.now() };
    },

    async subscribe(ctx, body) {
        const list = Array.isArray(body.topics) ? body.topics : [];
        const granted = await subscribe(ctx.connectionId, ctx.actor, list);
        const denied = list.filter((t) => !granted.includes(t));
        return { type: 'subscribed', topics: granted, denied };
    },

    async unsubscribe(ctx, body) {
        const list = Array.isArray(body.topics) ? body.topics : [];
        return { type: 'unsubscribed', topics: await unsubscribe(ctx.connectionId, list) };
    },

    async heartbeat(ctx, body) {
        const row = await presence.heartbeat(ctx.actor.actorId, {
            status: body.status,
            detail: body.detail,
            connectionId: ctx.connectionId,
        });
        return { type: 'heartbeat', presence: presence.view(row) };
    },

    /** Send a chat message without leaving the socket. */
    async message(ctx, body) {
        const convId = String(body.convId || '');
        if (!convId) return { type: 'error', message: 'convId is required.' };
        const conv = await conversations.byId(convId);
        if (!conv) return { type: 'error', message: 'No such conversation.' };
        if (!await ddb.get(keys.convParticipant(convId, ctx.actor.actorId))) {
            return { type: 'error', message: 'You are not in this conversation.' };
        }
        const message = await conversations.sendMessage({
            conv,
            sender: ctx.actor,
            body: body.body,
            viaTwin: Boolean(body.viaTwin) && Boolean(ctx.actor.twin?.active),
        });
        // Acknowledge only. The message itself reaches everyone — including
        // this sender — through the stream fan-out.
        return { type: 'accepted', messageId: message.messageId, convId };
    },
};

async function onMessage(event) {
    const connectionId = event.requestContext.connectionId;
    const endpoint = endpointFor(event);

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        await sendToConnection(connectionId, { type: 'error', message: 'Expected JSON.' }, endpoint);
        return { statusCode: 200, body: 'ok' };
    }

    const conn = await ddb.get(keys.connection(connectionId));
    if (!conn?.actorId) {
        await sendToConnection(connectionId, { type: 'error', message: 'Reconnect required.' }, endpoint);
        return { statusCode: 200, body: 'ok' };
    }
    const actor = await actors.byId(conn.actorId);
    if (!actor) {
        await sendToConnection(connectionId, { type: 'error', message: 'Reconnect required.' }, endpoint);
        return { statusCode: 200, body: 'ok' };
    }

    const action = ACTIONS[body.action];
    if (!action) {
        await sendToConnection(connectionId, {
            type: 'error',
            message: `Unknown action "${body.action}".`,
            actions: Object.keys(ACTIONS),
        }, endpoint);
        return { statusCode: 200, body: 'ok' };
    }

    try {
        const reply = await action({ connectionId, actor, endpoint }, body);
        // `id` lets a client correlate a reply with the request it sent.
        if (reply) await sendToConnection(connectionId, { ...reply, id: body.id || null }, endpoint);
    } catch (err) {
        console.error('socket action failed', { action: body.action, error: err.message });
        await sendToConnection(connectionId, {
            type: 'error',
            id: body.id || null,
            message: err.statusCode ? err.message : 'Something went wrong on our side.',
        }, endpoint);
    }
    return { statusCode: 200, body: 'ok' };
}

exports.handler = async (event) => {
    switch (event.requestContext.routeKey) {
        case '$connect': return onConnect(event);
        case '$disconnect': return onDisconnect(event);
        default: return onMessage(event);
    }
};
