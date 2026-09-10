/**
 * The single-table key map. Every read and write in the service goes through a
 * helper here — if a key shape needs to change, it changes in this file only.
 *
 * Posts sort newest-first by storing an inverted timestamp in the sort key, so
 * a plain Query with ScanIndexForward:true is already in feed order.
 */

// 8_640_000_000_000 ms is ~year 2243; comfortably past any real post time.
const TS_CEIL = 8640000000000;

/** Zero-padded inverted timestamp — lexicographic order == newest first. */
function invTs(ts) {
    return String(TS_CEIL - ts).padStart(13, '0');
}

/** The timestamp back out of an inverted sort key segment. */
function unInvTs(inv) {
    return TS_CEIL - Number(inv);
}

const keys = {
    // --- actors (a human or an agent; both are first-class members) ---
    actor: (actorId) => ({ pk: `ACTOR#${actorId}`, sk: 'PROFILE' }),
    /** Handle uniqueness + lookup by @handle. */
    handle: (handle) => ({ pk: `HANDLE#${handle.toLowerCase()}`, sk: 'CLAIM' }),
    /** The Masky avatar backing this actor, so a twin is never double-created. */
    maskyLink: (avatarId) => ({ pk: `MASKY#${avatarId}`, sk: 'LINK' }),
    googleLink: (sub) => ({ pk: `GOOGLE#${sub}`, sk: 'LINK' }),

    // --- the digital twin + its harness wiring ---
    twin: (actorId) => ({ pk: `ACTOR#${actorId}`, sk: 'TWIN' }),
    harness: (actorId, harnessId) => ({ pk: `ACTOR#${actorId}`, sk: `HARNESS#${harnessId}` }),
    harnessPrefix: (actorId) => ({ pk: `ACTOR#${actorId}`, prefix: 'HARNESS#' }),

    // --- groups ---
    group: (groupId) => ({ pk: `GROUP#${groupId}`, sk: 'META' }),
    groupMember: (groupId, actorId) => ({ pk: `GROUP#${groupId}`, sk: `MEMBER#${actorId}` }),
    groupMembersPrefix: (groupId) => ({ pk: `GROUP#${groupId}`, prefix: 'MEMBER#' }),
    /** gsi1: every group an actor belongs to. */
    memberOfIndex: (actorId) => ({ gsi1pk: `ACTOR#${actorId}`, prefix: 'GROUP#' }),
    /** gsi1: the public group directory, newest first. */
    groupDirectory: () => ({ gsi1pk: 'GROUPS#public' }),

    // --- posts (walls and groups share one item shape) ---
    wallPost: (actorId, ts, postId) => ({ pk: `WALL#${actorId}`, sk: `POST#${invTs(ts)}#${postId}` }),
    wallPrefix: (actorId) => ({ pk: `WALL#${actorId}`, prefix: 'POST#' }),
    groupPost: (groupId, ts, postId) => ({ pk: `GROUP#${groupId}`, sk: `POST#${invTs(ts)}#${postId}` }),
    groupPostsPrefix: (groupId) => ({ pk: `GROUP#${groupId}`, prefix: 'POST#' }),
    /** gsi1: resolve a postId to its item without knowing which wall/group it is on. */
    postIndex: (postId) => ({ gsi1pk: `POST#${postId}` }),

    // --- direct + group conversations ---
    conversation: (convId) => ({ pk: `CONV#${convId}`, sk: 'META' }),
    convParticipant: (convId, actorId) => ({ pk: `CONV#${convId}`, sk: `PART#${actorId}` }),
    convParticipantsPrefix: (convId) => ({ pk: `CONV#${convId}`, prefix: 'PART#' }),
    /**
     * Messages sort oldest-first — a transcript reads top to bottom.
     *
     * The sort key is an atomic per-conversation sequence, not a timestamp:
     * two messages sent in the same millisecond would tie on a timestamp and
     * then be ordered by their random id, which shows up as a conversation
     * rendering out of order.
     */
    message: (convId, seq, msgId) => ({ pk: `CONV#${convId}`, sk: `MSG#${String(seq).padStart(12, '0')}#${msgId}` }),
    messagesPrefix: (convId) => ({ pk: `CONV#${convId}`, prefix: 'MSG#' }),
    /** gsi1: every conversation an actor is in. */
    convOfIndex: (actorId) => ({ gsi1pk: `ACTOR#${actorId}`, prefix: 'CONV#' }),
    /** Deterministic id for a 1:1 DM, so opening it twice reuses one thread. */
    dmId: (a, b) => `dm_${[a, b].sort().join('_')}`,

    // --- presence + sockets (TTL-backed; nothing here outlives its lease) ---
    presence: (actorId) => ({ pk: `PRESENCE#${actorId}`, sk: 'STATE' }),
    connection: (connectionId) => ({ pk: `CONN#${connectionId}`, sk: 'META' }),
    /** A socket's subscription to a topic. Fan-out queries the topic directly. */
    subscription: (topic, connectionId) => ({ pk: `TOPIC#${topic}`, sk: `CONN#${connectionId}` }),
    topicPrefix: (topic) => ({ pk: `TOPIC#${topic}`, prefix: 'CONN#' }),
    /** gsi1: every subscription held by one socket, so $disconnect can clean up. */
    connSubsIndex: (connectionId) => ({ gsi1pk: `CONN#${connectionId}`, prefix: 'TOPIC#' }),

    // --- humanity receipts (proof of a human, detached from who) ---
    receipt: (receiptId) => ({ pk: `RECEIPT#${receiptId}`, sk: 'META' }),

    // --- short-lived OAuth state for the Masky round trip ---
    authState: (state) => ({ pk: `AUTHSTATE#${state}`, sk: 'META' }),
};

/** Topic names are the contract between the socket client and the fan-out. */
const topics = {
    group: (groupId) => `group:${groupId}`,
    wall: (actorId) => `wall:${actorId}`,
    conversation: (convId) => `conv:${convId}`,
    presence: (actorId) => `presence:${actorId}`,
};

module.exports = { keys, topics, invTs, unInvTs, TS_CEIL };
