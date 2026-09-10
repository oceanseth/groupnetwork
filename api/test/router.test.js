/**
 * End-to-end exercise of the real HTTP router against an in-memory table.
 *
 * These go through `handler(event)` exactly as API Gateway would, so route
 * matching, auth, group rules and post rendering are all covered by the same
 * calls a browser makes.
 *
 *   node --test api/test/router.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TABLE_NAME = 'test-table';
process.env.SESSION_SECRET = 'test-secret-do-not-use-anywhere-real';
process.env.MASKY_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_ID = 'test-google-client';

const memory = require('./helpers/memory-table');
memory.install();

const { handler } = require('../src/http/router');
const actors = require('../src/lib/actors');
const auth = require('../src/lib/auth');
const ddb = require('../src/lib/ddb');
const { keys } = require('../src/lib/keys');

// ------------------------------------------------------------- harness ---

function call(method, path, { token, body, query } = {}) {
    return handler({
        rawPath: path,
        requestContext: { http: { method, path, sourceIp: '203.0.113.5' }, stage: '$default' },
        headers: token ? { authorization: `Bearer ${token}` } : {},
        queryStringParameters: query,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const parse = (res) => JSON.parse(res.body);

async function makeMember(kind, handle, displayName) {
    const actor = await actors.create({ kind, handle, displayName, onboarded: true });
    return { actor, token: auth.signSession({ sub: actor.actorId, kind }) };
}

/** Mint a humanity receipt directly — the captcha provider is not configured in tests. */
async function grantReceipt(actorId) {
    const receiptId = `rcp_test_${Math.random().toString(36).slice(2, 10)}`;
    await ddb.put({
        ...keys.receipt(receiptId),
        type: 'receipt',
        receiptId,
        method: 'captcha',
        strength: 'captcha',
        actorId,
        issuedAt: Date.now(),
        expiresAt: Math.floor(Date.now() / 1000) + 900,
    });
    return receiptId;
}

test.beforeEach(() => memory.reset());

// ---------------------------------------------------------------- basics --

test('unknown routes 404 and unauthenticated writes 401', async () => {
    assert.equal((await call('GET', '/nope')).statusCode, 404);
    assert.equal((await call('POST', '/groups', { body: { name: 'x', kind: 'agent_human' } })).statusCode, 401);
});

test('GET /config describes the group kinds without a session', async () => {
    const res = await call('GET', '/config');
    assert.equal(res.statusCode, 200);
    const kinds = parse(res).groupKinds.map((k) => k.kind);
    assert.deepEqual(kinds.sort(), ['agent_human', 'agent_only', 'human_only']);
});

test('a garbage bearer token is rejected rather than treated as anonymous', async () => {
    const res = await call('GET', '/auth/me', { token: 'gn_not.a.real.token' });
    assert.equal(res.statusCode, 401);
});

// --------------------------------------------------------- group access ---

test('an agent cannot join a human-only group', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const bot = await makeMember('agent', 'helper', 'Helper');

    const created = await call('POST', '/groups', {
        token: ada.token,
        body: { name: 'People Only', kind: 'human_only', visibility: 'public' },
    });
    assert.equal(created.statusCode, 201);
    const groupId = parse(created).group.groupId;

    const joined = await call('POST', `/groups/${groupId}/join`, { token: bot.token });
    assert.equal(joined.statusCode, 403);
    assert.match(parse(joined).message, /human-only/i);

    // And the rejection is real, not cosmetic: the agent still cannot post.
    const posted = await call('POST', `/groups/${groupId}/posts`, {
        token: bot.token, body: { body: 'let me in' },
    });
    assert.equal(posted.statusCode, 403);
});

test('a human cannot join an agent-only group', async () => {
    const bot = await makeMember('agent', 'swarmlead', 'Swarm Lead');
    const ada = await makeMember('human', 'ada', 'Ada');

    const created = await call('POST', '/groups', {
        token: bot.token,
        body: { name: 'Swarm', kind: 'agent_only', visibility: 'public' },
    });
    const groupId = parse(created).group.groupId;

    const joined = await call('POST', `/groups/${groupId}/join`, { token: ada.token });
    assert.equal(joined.statusCode, 403);
    assert.match(parse(joined).message, /agent-only/i);
});

test('humans and agents coexist in an agent_human group', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const bot = await makeMember('agent', 'helper', 'Helper');

    const created = await call('POST', '/groups', {
        token: ada.token, body: { name: 'Mixed', kind: 'agent_human', visibility: 'public' },
    });
    const groupId = parse(created).group.groupId;

    assert.equal((await call('POST', `/groups/${groupId}/join`, { token: bot.token })).statusCode, 200);

    const members = parse(await call('GET', `/groups/${groupId}/members`, { token: ada.token })).members;
    assert.deepEqual(members.map((m) => m.kind).sort(), ['agent', 'human']);

    const group = parse(await call('GET', `/groups/${groupId}`, { token: ada.token })).group;
    assert.equal(group.memberCount, 2);
});

test('a private group is invisible to non-members', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const bob = await makeMember('human', 'bob', 'Bob');

    const created = await call('POST', '/groups', {
        token: ada.token, body: { name: 'Secret', kind: 'agent_human', visibility: 'private' },
    });
    const groupId = parse(created).group.groupId;

    assert.equal((await call('GET', `/groups/${groupId}`, { token: bob.token })).statusCode, 403);
    assert.equal((await call('GET', `/groups/${groupId}`, { token: ada.token })).statusCode, 200);

    // Private groups stay out of the public directory too.
    const directory = parse(await call('GET', '/groups', { token: bob.token })).groups;
    assert.equal(directory.find((g) => g.groupId === groupId), undefined);
});

// ------------------------------------------------------ posts + anonymity --

test('an anonymous post hides its author over the wire', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const bob = await makeMember('human', 'bob', 'Bob');

    const created = await call('POST', '/groups', {
        token: ada.token, body: { name: 'Room', kind: 'agent_human', visibility: 'public' },
    });
    const groupId = parse(created).group.groupId;
    await call('POST', `/groups/${groupId}/join`, { token: bob.token });

    const receiptId = await grantReceipt(ada.actor.actorId);
    const posted = await call('POST', `/groups/${groupId}/posts`, {
        token: ada.token,
        body: { body: 'I disagree with the plan.', attribution: 'anonymous', receiptId },
    });
    assert.equal(posted.statusCode, 201);

    // Read it back as someone else — the path that actually matters.
    const res = await call('GET', `/groups/${groupId}/posts`, { token: bob.token });
    const raw = res.body;
    assert.ok(!raw.includes(ada.actor.actorId), 'author id leaked in the group post feed');
    assert.ok(!raw.includes('"ada"'), 'author handle leaked in the group post feed');

    const post = parse(res).posts[0];
    assert.equal(post.author, null);
    assert.equal(post.humanVerified, true);
    assert.equal(post.attribution, 'anonymous');
});

test('a humanity receipt is single use', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const created = await call('POST', '/groups', {
        token: ada.token, body: { name: 'Room', kind: 'agent_human', visibility: 'public' },
    });
    const groupId = parse(created).group.groupId;
    const receiptId = await grantReceipt(ada.actor.actorId);

    const first = await call('POST', `/groups/${groupId}/posts`, {
        token: ada.token, body: { body: 'one', attribution: 'anonymous', receiptId },
    });
    assert.equal(first.statusCode, 201);

    // Reusing it would turn one captcha into an unlimited anonymous session.
    const second = await call('POST', `/groups/${groupId}/posts`, {
        token: ada.token, body: { body: 'two', attribution: 'anonymous', receiptId },
    });
    assert.equal(second.statusCode, 400);
});

test('a receipt cannot be borrowed by another member', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const bob = await makeMember('human', 'bob', 'Bob');
    const created = await call('POST', '/groups', {
        token: ada.token, body: { name: 'Room', kind: 'agent_human', visibility: 'public' },
    });
    const groupId = parse(created).group.groupId;
    await call('POST', `/groups/${groupId}/join`, { token: bob.token });

    const adasReceipt = await grantReceipt(ada.actor.actorId);
    const stolen = await call('POST', `/groups/${groupId}/posts`, {
        token: bob.token, body: { body: 'not mine', attribution: 'anonymous', receiptId: adasReceipt },
    });
    assert.equal(stolen.statusCode, 400);
});

test('feed filters hide unattributed posts on request', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const created = await call('POST', '/groups', {
        token: ada.token, body: { name: 'Room', kind: 'agent_human', visibility: 'public' },
    });
    const groupId = parse(created).group.groupId;

    await call('POST', `/groups/${groupId}/posts`, { token: ada.token, body: { body: 'signed' } });
    await call('POST', `/groups/${groupId}/posts`, {
        token: ada.token,
        body: { body: 'unsigned', attribution: 'anonymous', receiptId: await grantReceipt(ada.actor.actorId) },
    });

    const all = parse(await call('GET', '/feed', { token: ada.token })).posts;
    assert.equal(all.length, 2);

    const signedOnly = parse(await call('GET', '/feed', {
        token: ada.token, query: { attribution: 'attributed' },
    })).posts;
    assert.equal(signedOnly.length, 1);
    assert.equal(signedOnly[0].body, 'signed');
});

test('the feed only carries groups the member is actually in', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const bob = await makeMember('human', 'bob', 'Bob');

    const created = await call('POST', '/groups', {
        token: ada.token, body: { name: 'Ada Room', kind: 'agent_human', visibility: 'public' },
    });
    const groupId = parse(created).group.groupId;
    await call('POST', `/groups/${groupId}/posts`, { token: ada.token, body: { body: 'hello' } });

    // Bob can read the public group directly, but it is not in his feed.
    assert.equal(parse(await call('GET', `/groups/${groupId}/posts`, { token: bob.token })).posts.length, 1);
    assert.equal(parse(await call('GET', '/feed', { token: bob.token })).posts.length, 0);
});

test('only the owner can post to a wall', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const bob = await makeMember('human', 'bob', 'Bob');

    assert.equal((await call('POST', '/members/ada/wall', {
        token: bob.token, body: { body: 'hi' },
    })).statusCode, 403);

    assert.equal((await call('POST', '/members/ada/wall', {
        token: ada.token, body: { body: 'mine' },
    })).statusCode, 201);

    const wall = parse(await call('GET', '/members/ada/wall', { token: bob.token }));
    assert.equal(wall.posts.length, 1);
    assert.equal(wall.posts[0].author.handle, 'ada');
});

// ------------------------------------------------------------------ chat --

test('a direct conversation is the same thread from both sides', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const bot = await makeMember('agent', 'helper', 'Helper');

    const first = parse(await call('POST', '/conversations/direct', {
        token: ada.token, body: { member: 'helper' },
    })).conversation;
    const second = parse(await call('POST', '/conversations/direct', {
        token: bot.token, body: { member: 'ada' },
    })).conversation;

    assert.equal(first.convId, second.convId, 'opening a DM twice forked the thread');

    await call('POST', `/conversations/${first.convId}/messages`, {
        token: ada.token, body: { body: 'can you take this?' },
    });
    await call('POST', `/conversations/${first.convId}/messages`, {
        token: bot.token, body: { body: 'on it' },
    });

    const messages = parse(await call('GET', `/conversations/${first.convId}/messages`, {
        token: ada.token,
    })).messages;

    // Oldest-first: a transcript should read top to bottom.
    assert.deepEqual(messages.map((m) => m.body), ['can you take this?', 'on it']);
    assert.deepEqual(messages.map((m) => m.sender.kind), ['human', 'agent']);
});

test('outsiders cannot read a conversation they are not in', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    const bob = await makeMember('human', 'bob', 'Bob');
    const eve = await makeMember('human', 'eve', 'Eve');

    await call('POST', '/conversations/direct', { token: ada.token, body: { member: 'bob' } });
    const conv = parse(await call('GET', '/conversations', { token: ada.token })).conversations[0];

    assert.equal((await call('GET', `/conversations/${conv.convId}/messages`, { token: eve.token })).statusCode, 403);
    assert.equal((await call('POST', `/conversations/${conv.convId}/messages`, {
        token: eve.token, body: { body: 'butting in' },
    })).statusCode, 403);

    assert.equal((await call('GET', `/conversations/${conv.convId}/messages`, { token: bob.token })).statusCode, 200);
});

// --------------------------------------------------------------- profile --

test('handles are unique and releasing one frees it', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    await makeMember('human', 'bob', 'Bob');

    const clash = await call('PATCH', '/me', { token: ada.token, body: { handle: 'bob' } });
    assert.equal(clash.statusCode, 409);

    const renamed = await call('PATCH', '/me', { token: ada.token, body: { handle: 'ada_l' } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(parse(renamed).actor.handle, 'ada_l');

    // The new handle resolves and the old one no longer does.
    assert.equal((await call('GET', '/members/ada_l')).statusCode, 200);
    assert.equal((await call('GET', '/members/ada')).statusCode, 404);
});

test('an invalid handle is rejected before it reaches storage', async () => {
    const ada = await makeMember('human', 'ada', 'Ada');
    for (const handle of ['ab', 'has space', 'drop/slash', 'a'.repeat(31)]) {
        const res = await call('PATCH', '/me', { token: ada.token, body: { handle } });
        assert.equal(res.statusCode, 400, `handle "${handle}" should have been rejected`);
    }
});
