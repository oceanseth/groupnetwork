/**
 * Chat. A conversation is either a 1:1 DM or a room with a participant list;
 * humans and agents sit in both on equal terms.
 *
 * A DM's id is derived from its two participants, so "message this member"
 * is idempotent — opening the same DM twice reuses the one thread instead of
 * quietly forking a second empty one.
 */
const ddb = require('./ddb');
const { keys } = require('./keys');
const { newConvId, newMessageId } = require('./ids');
const { badRequest, forbidden, notFound } = require('./http');

const MAX_BODY = 4000;

function publicConversation(conv, participants, actorMap) {
    return {
        convId: conv.convId,
        kind: conv.kind,
        title: conv.title || null,
        createdAt: conv.createdAt,
        lastMessageAt: conv.lastMessageAt || conv.createdAt,
        lastMessagePreview: conv.lastMessagePreview || null,
        participants: (participants || []).map((p) => {
            const actor = actorMap?.get(p.actorId);
            return {
                actorId: p.actorId,
                kind: p.actorKind,
                handle: actor?.handle || null,
                displayName: actor?.displayName || 'Unknown member',
                avatarUrl: actor?.avatarUrl || null,
            };
        }),
    };
}

function publicMessage(msg, actorMap) {
    const sender = actorMap?.get(msg.senderActorId);
    return {
        messageId: msg.messageId,
        convId: msg.convId,
        body: msg.body,
        createdAt: msg.createdAt,
        viaTwin: Boolean(msg.viaTwin),
        sender: {
            actorId: msg.senderActorId,
            kind: msg.senderKind,
            handle: sender?.handle || null,
            displayName: sender?.displayName || 'Unknown member',
            avatarUrl: sender?.avatarUrl || null,
        },
    };
}

async function byId(convId) {
    return ddb.get(keys.conversation(convId));
}

async function participants(convId) {
    return ddb.queryAll(keys.convParticipantsPrefix(convId));
}

async function assertParticipant(convId, actorId) {
    const row = await ddb.get(keys.convParticipant(convId, actorId));
    if (!row) throw forbidden('You are not in this conversation.');
    return row;
}

async function addParticipant(convId, actor) {
    return ddb.put({
        ...keys.convParticipant(convId, actor.actorId),
        gsi1pk: `ACTOR#${actor.actorId}`,
        gsi1sk: `CONV#${convId}`,
        type: 'convParticipant',
        convId,
        actorId: actor.actorId,
        actorKind: actor.kind,
        joinedAt: Date.now(),
    });
}

/** Open (or reopen) the single DM between two actors. */
async function openDirect(a, b) {
    if (a.actorId === b.actorId) throw badRequest('You cannot open a conversation with yourself.');
    const convId = keys.dmId(a.actorId, b.actorId);
    const existing = await byId(convId);
    if (existing) return existing;

    const now = Date.now();
    const conv = {
        ...keys.conversation(convId),
        type: 'conversation',
        convId,
        kind: 'dm',
        title: null,
        createdAt: now,
        lastMessageAt: now,
        lastMessagePreview: null,
    };
    await ddb.put(conv);
    await Promise.all([addParticipant(convId, a), addParticipant(convId, b)]);
    return conv;
}

async function createRoom({ creator, title, memberActors }) {
    const convId = newConvId();
    const now = Date.now();
    const conv = {
        ...keys.conversation(convId),
        type: 'conversation',
        convId,
        kind: 'room',
        title: title || 'Untitled room',
        createdBy: creator.actorId,
        createdAt: now,
        lastMessageAt: now,
        lastMessagePreview: null,
    };
    await ddb.put(conv);
    const everyone = [creator, ...memberActors.filter((m) => m.actorId !== creator.actorId)];
    await Promise.all(everyone.map((m) => addParticipant(convId, m)));
    return conv;
}

/**
 * Append a message.
 *
 * The conversation row is bumped first, and the atomic counter it returns
 * becomes the message's sort key. That single write does double duty: it gives
 * the conversation list its summary without touching the message partition,
 * and it establishes a total order that a wall-clock timestamp cannot — two
 * messages in the same millisecond would otherwise fall back to comparing
 * random ids and render out of order.
 */
async function sendMessage({ conv, sender, body, viaTwin = false }) {
    const text = String(body || '').trim();
    if (!text) throw badRequest('A message needs a body.');
    if (text.length > MAX_BODY) throw badRequest(`Messages are limited to ${MAX_BODY} characters.`);

    const now = Date.now();
    const summary = await ddb.update(keys.conversation(conv.convId), {
        UpdateExpression: 'SET lastMessageAt = :ts, lastMessagePreview = :preview ADD msgSeq :one',
        ExpressionAttributeValues: { ':ts': now, ':preview': text.slice(0, 140), ':one': 1 },
    });

    const messageId = newMessageId();
    const message = {
        ...keys.message(conv.convId, summary.msgSeq, messageId),
        type: 'message',
        messageId,
        convId: conv.convId,
        seq: summary.msgSeq,
        senderActorId: sender.actorId,
        senderKind: sender.kind,
        viaTwin: Boolean(viaTwin),
        body: text,
        createdAt: now,
    };
    await ddb.put(message);
    return message;
}

async function listMessages(convId, { limit = 50, startKey }) {
    // Messages sort oldest-first so a transcript reads top to bottom.
    return ddb.query({ ...keys.messagesPrefix(convId), limit, startKey });
}

async function forActor(actorId) {
    const rows = await ddb.queryAll(keys.convOfIndex(actorId));
    const loaded = await Promise.all(rows.map((r) => byId(r.convId)));
    return loaded
        .filter(Boolean)
        .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
}

async function require_(convId) {
    const conv = await byId(convId);
    if (!conv) throw notFound('No such conversation.');
    return conv;
}

module.exports = {
    MAX_BODY, publicConversation, publicMessage,
    byId, require: require_, participants, assertParticipant, addParticipant,
    openDirect, createRoom, sendMessage, listMessages, forActor,
};
