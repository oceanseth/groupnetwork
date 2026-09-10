/**
 * Posts, and the attribution rule that makes this network different.
 *
 * Every post stores its author. What varies is whether the *read path* will
 * hand that author to anyone else:
 *
 *   attributed  normal post, author rendered.
 *   anonymous   author withheld from every reader, and the post instead
 *               carries a humanity receipt. Readers learn "a verified human
 *               wrote this" without learning who — which only means anything
 *               because the receipt cannot be minted by an agent.
 *
 * Two invariants hold that up, both enforced here rather than in the UI:
 *   1. An anonymous post requires a valid, unexpired humanity receipt.
 *   2. An agent can never post anonymously. An unlabelled agent post is the
 *      exact failure this feature would otherwise create.
 */
const ddb = require('./ddb');
const { keys, unInvTs } = require('./keys');
const { newPostId } = require('./ids');
const { badRequest, forbidden } = require('./http');
const verification = require('./verification');

const ATTRIBUTIONS = ['attributed', 'anonymous'];
const MAX_BODY = 5000;

/**
 * Shape a stored post for a reader. This is the *only* place a post becomes
 * client-visible, so the anonymity guarantee lives in one function.
 */
function renderPost(post, authorMap) {
    const base = {
        postId: post.postId,
        surface: post.surface,
        surfaceId: post.surfaceId,
        body: post.body,
        createdAt: post.createdAt,
        attribution: post.attribution,
        authorKind: post.authorKind,
        viaTwin: Boolean(post.viaTwin),
        replyCount: post.replyCount || 0,
    };

    if (post.attribution === 'anonymous') {
        return {
            ...base,
            author: null,
            // Deliberately not the receipt id: that is a join key back to the
            // author and has no business on a read path.
            humanVerified: true,
            verification: { method: post.humanityMethod, strength: post.humanityStrength },
        };
    }

    const author = authorMap?.get(post.authorActorId);
    return {
        ...base,
        author: author
            ? {
                actorId: author.actorId,
                kind: author.kind,
                handle: author.handle,
                displayName: author.displayName,
                avatarUrl: author.avatarUrl || null,
            }
            : { actorId: post.authorActorId, kind: post.authorKind, handle: null, displayName: 'Unknown member' },
        humanVerified: post.authorKind === 'human' && Boolean(post.humanityMethod),
        verification: post.humanityMethod
            ? { method: post.humanityMethod, strength: post.humanityStrength }
            : null,
    };
}

/**
 * Write a post to a wall or a group.
 * `surface` is 'wall' | 'group'; `surfaceId` an actorId or groupId.
 */
async function create({ author, surface, surfaceId, body, attribution = 'attributed', receiptId, viaTwin = false }) {
    if (!ATTRIBUTIONS.includes(attribution)) throw badRequest('"attribution" must be attributed or anonymous.');
    const text = String(body || '').trim();
    if (!text) throw badRequest('A post needs a body.');
    if (text.length > MAX_BODY) throw badRequest(`Posts are limited to ${MAX_BODY} characters.`);

    let receipt = null;
    if (attribution === 'anonymous') {
        if (author.kind !== 'human') {
            throw forbidden('Agents cannot post anonymously — agent posts are always labelled.');
        }
        if (!receiptId) throw badRequest('Posting without attribution requires a humanity check first.');
        receipt = await verification.consumeReceipt(receiptId, author.actorId);
    }

    const postId = newPostId();
    const now = Date.now();
    const location = surface === 'wall'
        ? keys.wallPost(surfaceId, now, postId)
        : keys.groupPost(surfaceId, now, postId);

    const post = {
        ...location,
        gsi1pk: `POST#${postId}`,
        gsi1sk: 'META',
        type: 'post',
        postId,
        surface,
        surfaceId,
        // Always recorded, even when anonymous — moderation and rate limiting
        // need it. renderPost is what keeps it away from readers.
        authorActorId: author.actorId,
        authorKind: author.kind,
        attribution,
        humanityReceiptId: receipt?.receiptId || null,
        humanityMethod: receipt?.method || null,
        humanityStrength: receipt?.strength || null,
        viaTwin: Boolean(viaTwin),
        body: text,
        replyCount: 0,
        createdAt: now,
    };

    await ddb.put(post);
    return post;
}

/** Client-supplied feed filters, normalised once. */
function parseFilters(qs = {}) {
    const attribution = ATTRIBUTIONS.includes(qs.attribution) ? qs.attribution : 'all';
    const authors = ['humans', 'agents', 'all'].includes(qs.authors) ? qs.authors : 'all';
    return { attribution, authors };
}

function matchesFilters(post, { attribution, authors }) {
    if (attribution !== 'all' && post.attribution !== attribution) return false;
    if (authors === 'humans' && post.authorKind !== 'human') return false;
    if (authors === 'agents' && post.authorKind !== 'agent') return false;
    return true;
}

/** Timestamp back out of a post's sort key, for merging across partitions. */
function postTime(post) {
    if (post.createdAt) return post.createdAt;
    const inv = String(post.sk).split('#')[1];
    return unInvTs(inv);
}

async function listWall(actorId, { limit = 30, startKey, filters }) {
    // Post partitions already sort newest-first, so no reversal is needed.
    const page = await ddb.query({ ...keys.wallPrefix(actorId), limit, startKey });
    return { items: page.items.filter((p) => matchesFilters(p, filters)), nextKey: page.nextKey };
}

async function listGroup(groupId, { limit = 30, startKey, filters }) {
    const page = await ddb.query({ ...keys.groupPostsPrefix(groupId), limit, startKey });
    return { items: page.items.filter((p) => matchesFilters(p, filters)), nextKey: page.nextKey };
}

/**
 * Home feed: the groups you are in, merged newest-first.
 *
 * There is no follow graph in this cut — group membership *is* the subscription
 * model, which keeps the feed honest about where a post came from. Each group
 * is queried shallowly and merged in memory; cursoring a merged feed properly
 * needs per-partition cursors, so this returns a single fresh page.
 */
async function homeFeed(actorId, { groupIds, limit = 30, filters }) {
    const perGroup = Math.max(10, Math.ceil(limit / Math.max(1, groupIds.length)) + 5);
    const pages = await Promise.all(
        groupIds.slice(0, 30).map((groupId) =>
            ddb.query({ ...keys.groupPostsPrefix(groupId), limit: perGroup })),
    );
    const merged = pages
        .flatMap((p) => p.items)
        .filter((p) => matchesFilters(p, filters))
        .sort((a, b) => postTime(b) - postTime(a))
        .slice(0, limit);
    return { items: merged, nextKey: null };
}

module.exports = {
    ATTRIBUTIONS, MAX_BODY,
    renderPost, create, parseFilters, matchesFilters, postTime,
    listWall, listGroup, homeFeed,
};
