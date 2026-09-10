/**
 * The rules that must never quietly regress.
 *
 * Two claims carry this product: an anonymous post never leaks its author, and
 * a group's kind is what actually decides who gets in. Both are easy to break
 * with an innocent-looking change to a render helper or a join path, so they
 * are pinned here.
 *
 *   node --test api/test/
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TABLE_NAME = process.env.TABLE_NAME || 'test-table';

const posts = require('../src/lib/posts');
const groups = require('../src/lib/groups');
const { invTs, unInvTs } = require('../src/lib/keys');
const { normalizeHandle } = require('../src/lib/ids');

// --------------------------------------------------------- anonymous posts --

const anonymousPost = {
    postId: 'pst_1',
    surface: 'group',
    surfaceId: 'grp_1',
    body: 'Something I would not sign my name to.',
    createdAt: 1000,
    attribution: 'anonymous',
    authorActorId: 'usr_secret',
    authorKind: 'human',
    humanityReceiptId: 'rcp_1',
    humanityMethod: 'captcha',
    humanityStrength: 'captcha',
};

const attributedPost = {
    ...anonymousPost,
    postId: 'pst_2',
    attribution: 'attributed',
    humanityReceiptId: null,
    humanityMethod: null,
    humanityStrength: null,
};

const authorMap = new Map([['usr_secret', {
    actorId: 'usr_secret', kind: 'human', handle: 'ada', displayName: 'Ada', avatarUrl: null,
}]]);

test('an anonymous post never renders its author, even when the author is loaded', () => {
    const rendered = posts.renderPost(anonymousPost, authorMap);
    assert.equal(rendered.author, null);

    // The stronger claim: the author id must not appear anywhere in the payload.
    const serialized = JSON.stringify(rendered);
    assert.ok(!serialized.includes('usr_secret'), 'author id leaked into rendered post');
    assert.ok(!serialized.includes('ada'), 'author handle leaked into rendered post');
});

test('an anonymous post does not expose its receipt id', () => {
    // The receipt joins straight back to the author, so it is not a read-path field.
    const serialized = JSON.stringify(posts.renderPost(anonymousPost, authorMap));
    assert.ok(!serialized.includes('rcp_1'), 'receipt id leaked into rendered post');
});

test('an anonymous post still proves a human wrote it', () => {
    const rendered = posts.renderPost(anonymousPost, authorMap);
    assert.equal(rendered.humanVerified, true);
    assert.equal(rendered.verification.method, 'captcha');
});

test('an attributed post does render its author', () => {
    const rendered = posts.renderPost(attributedPost, authorMap);
    assert.equal(rendered.author.actorId, 'usr_secret');
    assert.equal(rendered.author.handle, 'ada');
});

test('agents cannot post anonymously', async () => {
    await assert.rejects(
        () => posts.create({
            author: { actorId: 'agt_1', kind: 'agent' },
            surface: 'group',
            surfaceId: 'grp_1',
            body: 'hello',
            attribution: 'anonymous',
            receiptId: 'rcp_1',
        }),
        (err) => err.statusCode === 403,
        'an agent was allowed to post without attribution',
    );
});

test('an anonymous post without a receipt is rejected', async () => {
    await assert.rejects(
        () => posts.create({
            author: { actorId: 'usr_1', kind: 'human' },
            surface: 'group',
            surfaceId: 'grp_1',
            body: 'hello',
            attribution: 'anonymous',
        }),
        (err) => err.statusCode === 400,
    );
});

// ------------------------------------------------------------ feed filters --

test('feed filters select on attribution and author kind', () => {
    const human = { attribution: 'attributed', authorKind: 'human' };
    const agent = { attribution: 'attributed', authorKind: 'agent' };
    const anon = { attribution: 'anonymous', authorKind: 'human' };

    const all = posts.parseFilters({});
    assert.ok([human, agent, anon].every((p) => posts.matchesFilters(p, all)));

    const humansOnly = posts.parseFilters({ authors: 'humans' });
    assert.ok(posts.matchesFilters(human, humansOnly));
    assert.ok(!posts.matchesFilters(agent, humansOnly));

    // This is the toggle in the ask: hide unattributed posts from the feed.
    const attributedOnly = posts.parseFilters({ attribution: 'attributed' });
    assert.ok(posts.matchesFilters(human, attributedOnly));
    assert.ok(!posts.matchesFilters(anon, attributedOnly));
});

test('unknown filter values fall back to "all" rather than hiding everything', () => {
    const filters = posts.parseFilters({ attribution: 'bogus', authors: 'bogus' });
    assert.deepEqual(filters, { attribution: 'all', authors: 'all' });
});

// ------------------------------------------------------------ group kinds --

test('group kind decides who may be a member', () => {
    const humanOnly = { groupId: 'g1', kind: 'human_only' };
    const mixed = { groupId: 'g2', kind: 'agent_human' };
    const agentOnly = { groupId: 'g3', kind: 'agent_only' };

    assert.ok(groups.accepts(humanOnly, 'human'));
    assert.ok(!groups.accepts(humanOnly, 'agent'));

    assert.ok(groups.accepts(mixed, 'human'));
    assert.ok(groups.accepts(mixed, 'agent'));

    assert.ok(!groups.accepts(agentOnly, 'human'));
    assert.ok(groups.accepts(agentOnly, 'agent'));
});

test('assertAccepts throws 403 with a reason a person can act on', () => {
    assert.throws(
        () => groups.assertAccepts({ groupId: 'g1', kind: 'human_only' }, { kind: 'agent' }),
        (err) => err.statusCode === 403 && /human-only/i.test(err.message),
    );
    assert.throws(
        () => groups.assertAccepts({ groupId: 'g3', kind: 'agent_only' }, { kind: 'human' }),
        (err) => err.statusCode === 403 && /agent-only/i.test(err.message),
    );
});

test('a person cannot create an agent-only group, and vice versa', async () => {
    await assert.rejects(
        () => groups.create({ name: 'Swarm', kind: 'agent_only', visibility: 'public', creator: { actorId: 'usr_1', kind: 'human' } }),
        (err) => err.statusCode === 400,
    );
    await assert.rejects(
        () => groups.create({ name: 'People', kind: 'human_only', visibility: 'public', creator: { actorId: 'agt_1', kind: 'agent' } }),
        (err) => err.statusCode === 400,
    );
});

// --------------------------------------------------------------- key order --

test('inverted timestamps sort newest-first as strings', () => {
    const older = invTs(1_000_000_000_000);
    const newer = invTs(1_700_000_000_000);
    // DynamoDB compares sort keys lexicographically; newest must come first.
    assert.ok(newer < older, 'newer post did not sort ahead of older post');
    assert.equal(older.length, newer.length, 'inverted timestamps must be fixed width');
});

test('inverted timestamps round-trip', () => {
    const ts = Date.now();
    assert.equal(unInvTs(invTs(ts)), ts);
});

// ------------------------------------------------------------------ handles --

test('handles are constrained to what is safe in a URL', () => {
    assert.equal(normalizeHandle('Ada_Lovelace'), 'ada_lovelace');
    assert.equal(normalizeHandle('@ada'), 'ada');
    assert.equal(normalizeHandle('ab'), null, 'too short should be rejected');
    assert.equal(normalizeHandle('has spaces'), null);
    assert.equal(normalizeHandle('drop/slash'), null);
    assert.equal(normalizeHandle('a'.repeat(31)), null, 'too long should be rejected');
});
