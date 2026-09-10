/**
 * End-to-end shake-out of the DEPLOYED stack.
 *
 * The one thing this cannot cover is the Masky handshake itself — that needs a
 * real person consenting at masky.ai. So it seeds actors directly into the prod
 * table and mints session tokens with the deployed signing secret, then drives
 * everything else strictly over the wire: the real HTTP API, the real WebSocket
 * API, the real DynamoDB Streams fan-out.
 *
 * Everything it creates is namespaced and deleted at the end.
 *
 *   node scripts/smoke-prod.cjs
 */
process.env.TABLE_NAME = process.env.TABLE_NAME || 'groupnetwork-prod';
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const path = require('node:path');
const API = process.env.API_BASE;
const WS = process.env.WS_URL;
if (!API || !WS) throw new Error('Set API_BASE and WS_URL.');

const lib = (m) => require(path.join(__dirname, '..', 'api', 'src', 'lib', m));
const ddb = lib('ddb');
const actors = lib('actors');
const auth = lib('auth');
const { keys } = lib('keys');

const created = []; // { pk, sk } rows to remove on the way out
let failures = 0;

function check(name, condition, detail) {
    if (condition) {
        console.log(`  ok   ${name}`);
    } else {
        failures += 1;
        console.log(`  FAIL ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
    }
}

async function call(token, method, route, body) {
    const res = await fetch(`${API}${route}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text || '{}'); } catch { payload = { raw: text }; }
    return { status: res.status, body: payload };
}

async function seedActor(kind, handle, displayName) {
    const actor = await actors.create({ kind, handle, displayName });
    // Presence is written by heartbeats and by the socket's $connect, so it has
    // to come out too — it carries a TTL, but not one worth waiting on.
    created.push(keys.actor(actor.actorId), keys.handle(actor.handle), keys.presence(actor.actorId));
    return actor;
}

/** Minimal WebSocket client — enough to connect, subscribe and collect pushes. */
function openSocket(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const received = [];
        ws.addEventListener('message', (ev) => {
            try { received.push(JSON.parse(ev.data)); } catch { received.push({ raw: ev.data }); }
        });
        ws.addEventListener('open', () => resolve({
            ws,
            received,
            send: (obj) => ws.send(JSON.stringify(obj)),
            /** Wait for the first message matching `pred`, or null on timeout. */
            async wait(pred, ms = 15000) {
                const deadline = Date.now() + ms;
                for (;;) {
                    const hit = received.find(pred);
                    if (hit) return hit;
                    if (Date.now() > deadline) return null;
                    await new Promise((r) => setTimeout(r, 250));
                }
            },
        }));
        ws.addEventListener('error', reject);
    });
}

async function main() {
    const stamp = Date.now().toString(36);
    console.log(`\nHTTP  ${API}\nWS    ${WS}\n`);

    // --------------------------------------------------------------- config --
    console.log('config');
    const config = await call(null, 'GET', '/config');
    check('GET /config is public', config.status === 200);
    const voice = config.body.verificationMethods?.find((m) => m.method === 'voicecert');
    check('VoiceCert reports available with a site key', voice?.available === true && Boolean(voice.siteKey), voice);

    // --------------------------------------------------------------- actors --
    console.log('\nidentity');
    const ada = await seedActor('human', `smoke_ada_${stamp}`, 'Ada (smoke)');
    const grace = await seedActor('human', `smoke_grace_${stamp}`, 'Grace (smoke)');
    const bot = await seedActor('agent', `smoke_bot_${stamp}`, 'Bot (smoke)');
    const adaTok = auth.signSession({ sub: ada.actorId });
    const graceTok = auth.signSession({ sub: grace.actorId });
    const botTok = auth.signSession({ sub: bot.actorId });

    const me = await call(adaTok, 'GET', '/auth/me');
    check('a session token resolves to its actor', me.status === 200 && me.body.actor?.handle === ada.handle, me.body);
    const anon = await call(null, 'GET', '/feed');
    check('the feed rejects an unauthenticated caller', anon.status === 401, anon.body);
    const forged = await call(`${adaTok}x`, 'GET', '/auth/me');
    check('a tampered session token is rejected', forged.body.actor == null, forged.body);

    // --------------------------------------------------------------- groups --
    console.log('\ngroups');
    const mixed = await call(adaTok, 'POST', '/groups', {
        name: `Smoke mixed ${stamp}`, kind: 'agent_human', visibility: 'public',
    });
    check('a human can create an agent_human group', mixed.status === 201, mixed.body);
    const mixedId = mixed.body.group?.groupId;
    if (mixedId) created.push(keys.group(mixedId));

    const humanOnly = await call(adaTok, 'POST', '/groups', {
        name: `Smoke human-only ${stamp}`, kind: 'human_only', visibility: 'public',
    });
    const humanOnlyId = humanOnly.body.group?.groupId;
    if (humanOnlyId) created.push(keys.group(humanOnlyId));

    const botJoinsMixed = await call(botTok, 'POST', `/groups/${mixedId}/join`, {});
    check('an agent may join an agent_human group', botJoinsMixed.status === 200, botJoinsMixed.body);
    const botJoinsHumanOnly = await call(botTok, 'POST', `/groups/${humanOnlyId}/join`, {});
    check('an agent is refused by a human_only group', botJoinsHumanOnly.status === 403, botJoinsHumanOnly.body);

    // ------------------------------------------------------- posts + anonymity --
    console.log('\nposts');
    const signed = await call(adaTok, 'POST', `/groups/${mixedId}/posts`, {
        body: 'Attributed smoke post.', attribution: 'attributed',
    });
    check('an attributed post carries its author', signed.body.post?.author?.handle === ada.handle, signed.body);

    const noReceipt = await call(adaTok, 'POST', `/groups/${mixedId}/posts`, {
        body: 'Should not publish.', attribution: 'anonymous',
    });
    check('an unattributed post without a receipt is refused', noReceipt.status >= 400, noReceipt.body);

    const agentAnon = await call(botTok, 'POST', `/groups/${mixedId}/posts`, {
        body: 'Agent trying to hide.', attribution: 'anonymous',
    });
    check('an agent cannot post unattributed', agentAnon.status === 403, agentAnon.body);

    const badVoice = await call(adaTok, 'POST', '/verification/challenge', {
        method: 'voicecert', token: 'not-a-real-voicecert-token',
    });
    check('a bogus VoiceCert token is rejected by the live verifier', badVoice.status === 400, badVoice.body);
    check('  ...and is rejected for the right reason', badVoice.body.reason === 'invalid-input-response', badVoice.body);

    const agentChallenge = await call(botTok, 'POST', '/verification/challenge', {
        method: 'voicecert', token: 'x',
    });
    check('an agent cannot even attempt a humanity check', agentChallenge.status === 403, agentChallenge.body);

    // ----------------------------------------------------------- realtime --
    console.log('\nrealtime (WebSocket + DynamoDB Streams fan-out)');
    const ticket = await call(graceTok, 'POST', '/realtime/ticket', {});
    check('a realtime ticket is issued', ticket.status === 200 && Boolean(ticket.body.ticket), ticket.body);

    const badSocket = await openSocket(`${WS}?ticket=obviously-invalid`).then(() => 'connected', () => 'rejected');
    check('the socket rejects an invalid ticket', badSocket === 'rejected');

    const sock = await openSocket(`${WS}?ticket=${ticket.body.ticket}`);
    sock.send({ action: 'ping' });
    check('the socket answers a ping', Boolean(await sock.wait((m) => m.type === 'pong')));

    sock.send({ action: 'subscribe', topics: [`group:${mixedId}`] });
    const sub = await sock.wait((m) => m.type === 'subscribed');
    check('a public group topic is granted', sub?.topics?.includes(`group:${mixedId}`), sub);

    const privateGroup = await call(adaTok, 'POST', '/groups', {
        name: `Smoke private ${stamp}`, kind: 'agent_human', visibility: 'private',
    });
    const privateId = privateGroup.body.group?.groupId;
    if (privateId) created.push(keys.group(privateId));
    sock.send({ action: 'subscribe', topics: [`group:${privateId}`] });
    const denied = await sock.wait((m) => m.type === 'subscribed' && m.denied?.length);
    check('a private group topic is denied to a non-member', denied?.denied?.includes(`group:${privateId}`), denied);

    // The actual fan-out: Ada posts over HTTP, Grace's socket must receive it.
    const pushed = await call(adaTok, 'POST', `/groups/${mixedId}/posts`, {
        body: `Realtime smoke ${stamp}`, attribution: 'attributed',
    });
    const push = await sock.wait((m) => JSON.stringify(m).includes(`Realtime smoke ${stamp}`), 25000);
    check('a post written over HTTP arrives on a subscribed socket', Boolean(push), {
        posted: pushed.status, seen: sock.received.map((m) => m.type),
    });

    sock.ws.close();

    // ----------------------------------------------------------------- chat --
    console.log('\nchat');
    const conv = await call(adaTok, 'POST', '/conversations/direct', { member: grace.actorId });
    check('a direct conversation opens', conv.status === 200, conv.body);
    const convId = conv.body.conversation?.convId;
    if (convId) created.push({ pk: `CONV#${convId}`, sk: 'META' });

    for (let i = 0; i < 5; i += 1) {
        await call(adaTok, 'POST', `/conversations/${convId}/messages`, { body: `msg ${i}` });
    }
    const msgs = await call(graceTok, 'GET', `/conversations/${convId}/messages`);
    const bodies = (msgs.body.messages || []).map((m) => m.body);
    const ordered = [...bodies].sort((a, b) => Number(a.split(' ')[1]) - Number(b.split(' ')[1]));
    check('both sides see the same thread', bodies.length === 5, bodies);
    check('messages come back in send order', JSON.stringify(bodies) === JSON.stringify(ordered), bodies);

    const outsider = await call(botTok, 'GET', `/conversations/${convId}/messages`);
    check('an outsider cannot read the conversation', outsider.status >= 400, outsider.body);

    // ------------------------------------------------------------- presence --
    console.log('\npresence');
    const beat = await call(adaTok, 'POST', '/presence', { status: 'online' });
    check('a heartbeat is accepted', beat.status === 200, beat.body);
    const seen = await call(graceTok, 'GET', `/presence?actors=${ada.actorId}`);
    check('presence is visible to another member', JSON.stringify(seen.body).includes(ada.actorId), seen.body);

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
}

async function cleanup() {
    console.log('cleaning up seeded rows');
    // Posts, memberships and messages hang off the group/conversation rows, so
    // sweep each partition rather than only deleting the ones recorded above.
    const partitions = [...new Set(created.map((k) => k.pk))];
    for (const pk of partitions) {
        const rows = await ddb.queryAll({ pk });
        await ddb.batchDelete(rows.map((r) => ({ pk: r.pk, sk: r.sk })));
    }
    await ddb.batchDelete(created);
}

main()
    .catch((err) => { failures += 1; console.error('\nsmoke run threw:', err); })
    .finally(() => cleanup().catch((err) => console.error('cleanup failed:', err))
        .then(() => process.exit(failures === 0 ? 0 : 1)));
