/**
 * The whole REST surface, one Lambda, one route table — the same shape
 * oceanseth/masky uses for its API. Handlers throw HttpError; the dispatcher
 * below is the only place that turns an error into a response.
 */
const {
    ok, created, json, HttpError,
    badRequest, notFound, forbidden,
    parseBody, bearer, encodeCursor, decodeCursor, str, oneOf,
} = require('../lib/http');
const auth = require('../lib/auth');
const actors = require('../lib/actors');
const groups = require('../lib/groups');
const posts = require('../lib/posts');
const conversations = require('../lib/conversations');
const presence = require('../lib/presence');
const harness = require('../lib/harness');
const verification = require('../lib/verification');
const masky = require('../lib/masky');
const ddb = require('../lib/ddb');
const { keys } = require('../lib/keys');
const { newState } = require('../lib/ids');
const crypto = require('crypto');

// --------------------------------------------------------------- helpers ---

/** Attach presence + author records to a list of posts in one pass. */
async function renderPosts(items) {
    // Anonymous posts must not contribute their author to the lookup — that is
    // how an author id would leak back out through a shared hydration map.
    const attributedAuthors = items
        .filter((p) => p.attribution !== 'anonymous')
        .map((p) => p.authorActorId);
    const authorMap = await actors.hydrate(attributedAuthors);
    return items.map((p) => posts.renderPost(p, authorMap));
}

async function actorWithPresence(actor) {
    return actors.publicActor(actor, await presence.get(actor.actorId));
}

/** Find-or-create the actor behind an external identity, then mint a session. */
async function signIn({ linkKey, identity, profile }) {
    const link = await ddb.get(linkKey);
    let actor = link?.actorId ? await actors.byId(link.actorId) : null;

    if (!actor) {
        actor = await actors.create({
            kind: 'human',
            handle: profile.suggestedHandle,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            twin: profile.twin || null,
            identity,
            onboarded: false,
        });
    } else if (profile.twin && !actor.twin) {
        // Signing in with Masky after a Google-first signup finally gives us a
        // twin; adopt it rather than leaving the account twinless.
        actor = await actors.update(actor.actorId, { twin: profile.twin });
    }

    return {
        token: auth.signSession({ sub: actor.actorId, kind: actor.kind }),
        actor,
        isNew: !link,
    };
}

// ------------------------------------------------------------------ auth ---

const authRoutes = {
    /**
     * Start the Masky round trip. The PKCE verifier is generated and stored
     * here, not in the browser, so the code exchange stays entirely
     * server-side and no Masky token ever reaches the client.
     */
    async maskyStart(event) {
        const body = parseBody(event);
        const redirectUri = str(body, 'redirectUri', { max: 300 });
        const state = newState();
        const codeVerifier = crypto.randomBytes(48).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

        await ddb.put({
            ...keys.authState(state),
            type: 'authState',
            state,
            codeVerifier,
            redirectUri,
            createdAt: Date.now(),
            expiresAt: Math.floor(Date.now() / 1000) + 600,
        });

        return ok({ authorizeUrl: masky.authorizeUrl({ redirectUri, state, codeChallenge }), state });
    },

    async maskyCallback(event) {
        const body = parseBody(event);
        const code = str(body, 'code', { max: 500 });
        const state = str(body, 'state', { max: 200 });

        const stored = await ddb.get(keys.authState(state));
        if (!stored) throw badRequest('This sign-in link has expired. Start again.');
        if (stored.expiresAt * 1000 < Date.now()) throw badRequest('This sign-in link has expired. Start again.');
        // One code, one use.
        await ddb.del(keys.authState(state));

        const tokenSet = await masky.exchangeCode({
            code,
            redirectUri: stored.redirectUri,
            codeVerifier: stored.codeVerifier,
        });
        const info = await masky.userinfo(tokenSet.access_token);
        if (!info?.sub) throw badRequest('Masky did not return an identity for this sign-in.');

        const result = await signIn({
            linkKey: keys.maskyLink(info.sub),
            identity: { masky: info.sub },
            profile: {
                displayName: info.name || 'New member',
                avatarUrl: info.picture || null,
                suggestedHandle: info.name,
                // This is the digital twin: the Masky avatar the member chose
                // to represent them, live from the moment they sign in.
                twin: {
                    source: 'masky',
                    avatarId: info.avatar_id,
                    name: info.name,
                    picture: info.picture || null,
                    active: true,
                    scope: info.scope || null,
                },
            },
        });

        return ok({
            token: result.token,
            actor: await actorWithPresence(result.actor),
            isNew: result.isNew,
            onboarded: result.actor.onboarded !== false,
        });
    },

    async google(event) {
        const body = parseBody(event);
        const idToken = str(body, 'idToken', { max: 4000 });
        const claims = await auth.verifyGoogleIdToken(idToken);
        if (claims.email && claims.email_verified === false) {
            throw badRequest('Verify your Google email address before signing in.');
        }

        const result = await signIn({
            linkKey: keys.googleLink(claims.sub),
            identity: { google: claims.sub },
            profile: {
                displayName: claims.name || claims.email || 'New member',
                avatarUrl: claims.picture || null,
                suggestedHandle: claims.name || claims.email?.split('@')[0],
                // No twin yet — Google proves who you are, Masky is what gives
                // you a twin. Onboarding offers to connect it.
                twin: null,
            },
        });

        return ok({
            token: result.token,
            actor: await actorWithPresence(result.actor),
            isNew: result.isNew,
            onboarded: result.actor.onboarded !== false,
        });
    },

    async me(event) {
        const actor = await auth.requireActor(bearer(event));
        return ok({
            actor: await actorWithPresence(actor),
            onboarded: actor.onboarded !== false,
        });
    },
};

// ----------------------------------------------------------------- me/us ---

const meRoutes = {
    async patch(event) {
        const actor = await auth.requireActor(bearer(event));
        const body = parseBody(event);
        const patch = {
            displayName: str(body, 'displayName', { max: 80, required: false }),
            bio: str(body, 'bio', { max: 400, required: false }),
            avatarUrl: str(body, 'avatarUrl', { max: 500, required: false }),
        };
        if (body.handle !== undefined) {
            const updated = await changeHandle(actor, body.handle);
            Object.assign(actor, updated);
        }
        const saved = await actors.update(actor.actorId, patch);
        return ok({ actor: await actorWithPresence(saved) });
    },

    async completeOnboarding(event) {
        const actor = await auth.requireActor(bearer(event));
        const body = parseBody(event);
        if (body.handle !== undefined) await changeHandle(actor, body.handle);

        const twin = actor.twin ? { ...actor.twin, active: body.twinActive !== false } : null;
        const saved = await actors.update(actor.actorId, {
            displayName: str(body, 'displayName', { max: 80, required: false }) || actor.displayName,
            bio: str(body, 'bio', { max: 400, required: false }) || actor.bio || '',
            twin,
            onboarded: true,
        });
        return ok({ actor: await actorWithPresence(saved), onboarded: true });
    },

    async setTwin(event) {
        const actor = await auth.requireActor(bearer(event));
        if (!actor.twin) throw badRequest('Connect Masky to get a twin first.');
        const body = parseBody(event);
        const saved = await actors.update(actor.actorId, {
            twin: { ...actor.twin, active: body.active !== false },
        });
        return ok({ actor: await actorWithPresence(saved) });
    },
};

/** Handle changes re-claim atomically so the old name frees only on success. */
async function changeHandle(actor, raw) {
    const { normalizeHandle } = require('../lib/ids');
    const next = normalizeHandle(raw);
    if (!next) throw badRequest('Handle must be 3-30 characters: letters, numbers or underscore.');
    if (next === actor.handle) return actor;

    try {
        await ddb.transact([
            {
                Put: {
                    TableName: ddb.TABLE,
                    Item: { ...keys.handle(next), type: 'handle', actorId: actor.actorId, claimedAt: Date.now() },
                    ConditionExpression: 'attribute_not_exists(pk)',
                },
            },
            { Delete: { TableName: ddb.TABLE, Key: keys.handle(actor.handle) } },
            {
                Update: {
                    TableName: ddb.TABLE,
                    Key: keys.actor(actor.actorId),
                    UpdateExpression: 'SET handle = :h, gsi1pk = :g',
                    ExpressionAttributeValues: { ':h': next, ':g': `HANDLE#${next}` },
                },
            },
        ]);
    } catch (err) {
        if (err.name === 'TransactionCanceledException') throw new HttpError(409, 'conflict', `Handle "@${next}" is already taken.`);
        throw err;
    }
    return { ...actor, handle: next };
}

// --------------------------------------------------------------- members ---

const memberRoutes = {
    async get(event, ref) {
        const actor = await actors.resolve(ref);
        if (!actor) throw notFound('No such member.');
        return ok({ member: await actorWithPresence(actor) });
    },

    async wall(event, ref) {
        const target = await actors.resolve(ref);
        if (!target) throw notFound('No such member.');
        const qs = event.queryStringParameters || {};
        const page = await posts.listWall(target.actorId, {
            limit: Math.min(Number(qs.limit) || 30, 100),
            startKey: decodeCursor(qs.cursor),
            filters: posts.parseFilters(qs),
        });
        return ok({
            member: await actorWithPresence(target),
            posts: await renderPosts(page.items),
            cursor: encodeCursor(page.nextKey),
        });
    },

    /** A wall is the member's own space; only they (or their twin) post to it. */
    async post(event, ref) {
        const actor = await auth.requireActor(bearer(event));
        const target = await actors.resolve(ref);
        if (!target) throw notFound('No such member.');
        if (target.actorId !== actor.actorId) throw forbidden('You can only post to your own wall.');

        const body = parseBody(event);
        const post = await posts.create({
            author: actor,
            surface: 'wall',
            surfaceId: actor.actorId,
            body: str(body, 'body', { max: posts.MAX_BODY }),
            attribution: oneOf(body, 'attribution', posts.ATTRIBUTIONS, { required: false, fallback: 'attributed' }),
            receiptId: body.receiptId,
            viaTwin: Boolean(body.viaTwin) && Boolean(actor.twin?.active),
        });
        return created({ post: (await renderPosts([post]))[0] });
    },

    async agents(event) {
        const actor = await auth.requireActor(bearer(event));
        const rows = await ddb.query({ gsi1pk: `OPERATOR#${actor.actorId}`, prefix: 'AGENT#', limit: 100 });
        const loaded = await actors.hydrate(rows.items.map((r) => r.agentActorId));
        return ok({ agents: await Promise.all([...loaded.values()].map(actorWithPresence)) });
    },

    /**
     * Register an agent the caller operates. The agent proves its identity with
     * a Masky service-avatar token (grant_type=client_credentials), which is
     * also the credential it will authenticate with from then on.
     */
    async registerAgent(event) {
        const operator = await auth.requireActor(bearer(event));
        if (operator.kind !== 'human') throw forbidden('Only people can register agents.');
        const body = parseBody(event);
        const maskyToken = str(body, 'maskyToken', { max: 500 });

        const info = await masky.userinfo(maskyToken);
        if (!info?.sub) throw badRequest('Masky did not recognise that service token.');

        const existing = await ddb.get(keys.maskyLink(info.sub));
        if (existing?.actorId) throw new HttpError(409, 'conflict', 'That Masky avatar is already registered here.');

        const agent = await actors.create({
            kind: 'agent',
            handle: str(body, 'handle', { max: 30, required: false }) || info.name,
            displayName: str(body, 'displayName', { max: 80, required: false }) || info.name,
            avatarUrl: info.picture || null,
            operatorActorId: operator.actorId,
            twin: { source: 'masky', avatarId: info.avatar_id, name: info.name, picture: info.picture || null, active: true },
            identity: { masky: info.sub },
        });

        // Reverse index so an operator can list the agents they run.
        await ddb.put({
            pk: `OPERATOR#${operator.actorId}`,
            sk: `AGENT#${agent.actorId}`,
            gsi1pk: `OPERATOR#${operator.actorId}`,
            gsi1sk: `AGENT#${agent.actorId}`,
            type: 'operatorAgent',
            operatorActorId: operator.actorId,
            agentActorId: agent.actorId,
            createdAt: Date.now(),
        });

        return created({ agent: await actorWithPresence(agent) });
    },
};

// ---------------------------------------------------------------- groups ---

const groupRoutes = {
    async list(event) {
        const actor = await auth.currentActor(bearer(event));
        const qs = event.queryStringParameters || {};

        if (qs.mine === '1') {
            if (!actor) throw new HttpError(401, 'unauthorized', 'Sign in to see your groups.');
            const mine = await groups.groupsForActor(actor.actorId);
            return ok({ groups: mine.map(({ group, membership }) => groups.publicGroup(group, membership)) });
        }

        // Public directory, newest first.
        const page = await ddb.query({
            gsi1pk: 'GROUPS#public',
            prefix: 'CREATED#',
            limit: Math.min(Number(qs.limit) || 30, 100),
            forward: false,
            startKey: decodeCursor(qs.cursor),
        });
        const memberships = actor
            ? await Promise.all(page.items.map((g) => groups.membership(g.groupId, actor.actorId)))
            : [];
        return ok({
            groups: page.items.map((g, i) => groups.publicGroup(g, memberships[i])),
            cursor: encodeCursor(page.nextKey),
        });
    },

    async create(event) {
        const actor = await auth.requireActor(bearer(event));
        const body = parseBody(event);
        const group = await groups.create({
            name: str(body, 'name', { max: 80 }),
            description: str(body, 'description', { max: 500, required: false }),
            kind: oneOf(body, 'kind', groups.KINDS, { required: false, fallback: 'agent_human' }) || 'agent_human',
            visibility: oneOf(body, 'visibility', groups.VISIBILITIES, { required: false, fallback: 'public' }) || 'public',
            creator: actor,
        });
        return created({ group: groups.publicGroup(group, { role: 'owner', joinedAt: group.createdAt }) });
    },

    async get(event, groupId) {
        const actor = await auth.currentActor(bearer(event));
        const group = await groups.require(groupId);
        const membership = await groups.assertCanRead(group, actor);
        return ok({ group: groups.publicGroup(group, membership) });
    },

    async join(event, groupId) {
        const actor = await auth.requireActor(bearer(event));
        const group = await groups.require(groupId);
        if (group.visibility === 'private') throw forbidden('This group is invite-only.');
        // Enforced in addMember: this is where human_only / agent_only bite.
        const membership = await groups.addMember(group, actor);
        return ok({ group: groups.publicGroup(await groups.require(groupId), membership) });
    },

    async leave(event, groupId) {
        const actor = await auth.requireActor(bearer(event));
        const group = await groups.require(groupId);
        await groups.removeMember(group, actor.actorId);
        return ok({ left: true });
    },

    async members(event, groupId) {
        const actor = await auth.currentActor(bearer(event));
        const group = await groups.require(groupId);
        await groups.assertCanRead(group, actor);
        const rows = await groups.members(group.groupId);
        const actorMap = await actors.hydrate(rows.map((r) => r.actorId));
        const presenceMap = await presence.getMany(rows.map((r) => r.actorId));
        return ok({
            members: rows.map((row) => {
                const a = actorMap.get(row.actorId);
                return {
                    ...actors.publicActor(a, presenceMap.get(row.actorId)),
                    role: row.role,
                    joinedAt: row.joinedAt,
                };
            }).filter((m) => m.actorId),
        });
    },

    async invite(event, groupId) {
        const actor = await auth.requireActor(bearer(event));
        const group = await groups.require(groupId);
        await groups.assertCanAdminister(group, actor);
        const body = parseBody(event);
        const invitee = await actors.resolve(str(body, 'member', { max: 100 }));
        if (!invitee) throw notFound('No such member.');
        const membership = await groups.addMember(group, invitee);
        return created({ member: { ...await actorWithPresence(invitee), role: membership.role } });
    },

    async posts(event, groupId) {
        const actor = await auth.currentActor(bearer(event));
        const group = await groups.require(groupId);
        await groups.assertCanRead(group, actor);
        const qs = event.queryStringParameters || {};
        const page = await posts.listGroup(group.groupId, {
            limit: Math.min(Number(qs.limit) || 30, 100),
            startKey: decodeCursor(qs.cursor),
            filters: posts.parseFilters(qs),
        });
        return ok({ posts: await renderPosts(page.items), cursor: encodeCursor(page.nextKey) });
    },

    async post(event, groupId) {
        const actor = await auth.requireActor(bearer(event));
        const group = await groups.require(groupId);
        await groups.assertCanPost(group, actor);
        const body = parseBody(event);
        const post = await posts.create({
            author: actor,
            surface: 'group',
            surfaceId: group.groupId,
            body: str(body, 'body', { max: posts.MAX_BODY }),
            attribution: oneOf(body, 'attribution', posts.ATTRIBUTIONS, { required: false, fallback: 'attributed' }),
            receiptId: body.receiptId,
            viaTwin: Boolean(body.viaTwin) && Boolean(actor.twin?.active),
        });
        return created({ post: (await renderPosts([post]))[0] });
    },
};

// ------------------------------------------------------------------ feed ---

async function feedRoute(event) {
    const actor = await auth.requireActor(bearer(event));
    const qs = event.queryStringParameters || {};
    const mine = await groups.groupsForActor(actor.actorId);
    const page = await posts.homeFeed(actor.actorId, {
        groupIds: mine.map((m) => m.group.groupId),
        limit: Math.min(Number(qs.limit) || 30, 100),
        filters: posts.parseFilters(qs),
    });
    return ok({
        posts: await renderPosts(page.items),
        groups: mine.map(({ group, membership }) => groups.publicGroup(group, membership)),
        cursor: null,
    });
}

// ---------------------------------------------------------- verification ---

const verificationRoutes = {
    async methods() {
        return ok({ methods: verification.availableMethods() });
    },

    /**
     * Trade a captcha/voice proof for a receipt. The receipt is what lets the
     * next post drop its author while still showing as human-written.
     */
    async challenge(event) {
        const actor = await auth.requireActor(bearer(event));
        if (actor.kind !== 'human') throw forbidden('Only people can complete a humanity check.');
        const body = parseBody(event);
        const result = await verification.issueReceipt({
            method: oneOf(body, 'method', ['captcha', 'voicecert']),
            token: body.token,
            actorId: actor.actorId,
            remoteIp: event.requestContext?.http?.sourceIp,
        });
        if (!result.verified) return json(400, { error: 'verification_failed', reason: result.reason });
        return ok({ receipt: result.receipt });
    },
};

// --------------------------------------------------------------- messages --

const chatRoutes = {
    async list(event) {
        const actor = await auth.requireActor(bearer(event));
        const convs = await conversations.forActor(actor.actorId);
        const detailed = await Promise.all(convs.map(async (conv) => {
            const parts = await conversations.participants(conv.convId);
            const actorMap = await actors.hydrate(parts.map((p) => p.actorId));
            return conversations.publicConversation(conv, parts, actorMap);
        }));
        return ok({ conversations: detailed });
    },

    async openDirect(event) {
        const actor = await auth.requireActor(bearer(event));
        const body = parseBody(event);
        const other = await actors.resolve(str(body, 'member', { max: 100 }));
        if (!other) throw notFound('No such member.');
        const conv = await conversations.openDirect(actor, other);
        const parts = await conversations.participants(conv.convId);
        const actorMap = await actors.hydrate(parts.map((p) => p.actorId));
        return ok({ conversation: conversations.publicConversation(conv, parts, actorMap) });
    },

    async createRoom(event) {
        const actor = await auth.requireActor(bearer(event));
        const body = parseBody(event);
        const refs = Array.isArray(body.members) ? body.members.slice(0, 50) : [];
        const resolved = (await Promise.all(refs.map((r) => actors.resolve(r)))).filter(Boolean);
        const conv = await conversations.createRoom({
            creator: actor,
            title: str(body, 'title', { max: 100, required: false }),
            memberActors: resolved,
        });
        const parts = await conversations.participants(conv.convId);
        const actorMap = await actors.hydrate(parts.map((p) => p.actorId));
        return created({ conversation: conversations.publicConversation(conv, parts, actorMap) });
    },

    async messages(event, convId) {
        const actor = await auth.requireActor(bearer(event));
        await conversations.require(convId);
        await conversations.assertParticipant(convId, actor.actorId);
        const qs = event.queryStringParameters || {};
        const page = await conversations.listMessages(convId, {
            limit: Math.min(Number(qs.limit) || 50, 100),
            startKey: decodeCursor(qs.cursor),
        });
        const actorMap = await actors.hydrate(page.items.map((m) => m.senderActorId));
        return ok({
            messages: page.items.map((m) => conversations.publicMessage(m, actorMap)),
            cursor: encodeCursor(page.nextKey),
        });
    },

    /**
     * Send. The response returns immediately; delivery to everyone else in the
     * conversation happens off the DynamoDB stream, so HTTP and socket clients
     * see exactly the same event.
     */
    async send(event, convId) {
        const actor = await auth.requireActor(bearer(event));
        const conv = await conversations.require(convId);
        await conversations.assertParticipant(convId, actor.actorId);
        const body = parseBody(event);
        const message = await conversations.sendMessage({
            conv,
            sender: actor,
            body: str(body, 'body', { max: conversations.MAX_BODY }),
            viaTwin: Boolean(body.viaTwin) && Boolean(actor.twin?.active),
        });
        const actorMap = await actors.hydrate([actor.actorId]);
        return created({ message: conversations.publicMessage(message, actorMap) });
    },
};

// -------------------------------------------------------------- presence ---

const presenceRoutes = {
    async heartbeat(event) {
        const actor = await auth.requireActor(bearer(event));
        const body = parseBody(event);
        const row = await presence.heartbeat(actor.actorId, { status: body.status, detail: body.detail });
        return ok({ presence: presence.view(row), heartbeatSeconds: presence.HEARTBEAT_SEC });
    },

    async query(event) {
        const qs = event.queryStringParameters || {};
        const ids = String(qs.actors || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
        const map = await presence.getMany(ids);
        return ok({ presence: Object.fromEntries(map) });
    },
};

// -------------------------------------------------------------- realtime ---

/**
 * A browser cannot set headers on a WebSocket handshake, so the token would
 * otherwise have to ride in the query string — where it lands in access logs.
 * Instead the client trades its session for a single-use 60-second ticket.
 */
async function realtimeTicket(event) {
    const actor = await auth.requireActor(bearer(event));
    const ticket = newState();
    const now = Date.now();
    await ddb.put({
        pk: `TICKET#${ticket}`,
        sk: 'META',
        type: 'realtimeTicket',
        actorId: actor.actorId,
        createdAt: now,
        expiresAt: Math.floor(now / 1000) + 60,
    });
    return ok({ ticket, expiresInSeconds: 60 });
}

// --------------------------------------------------------------- harness ---

const harnessRoutes = {
    async providers() {
        return ok({ providers: harness.providerCatalog() });
    },

    async list(event) {
        const actor = await auth.requireActor(bearer(event));
        const rows = await harness.list(actor.actorId);
        return ok({ harnesses: rows.map(harness.publicHarness) });
    },

    async connect(event) {
        const actor = await auth.requireActor(bearer(event));
        const body = parseBody(event);
        const row = await harness.connect({
            actor,
            provider: oneOf(body, 'provider', Object.keys(harness.PROVIDERS)),
            label: str(body, 'label', { max: 60, required: false }),
            model: str(body, 'model', { max: 120, required: false }),
            baseUrl: str(body, 'baseUrl', { max: 300, required: false }),
            apiKey: str(body, 'apiKey', { max: 400, required: false }),
            makeDefault: body.makeDefault !== false,
        });
        return created({ harness: harness.publicHarness(row) });
    },

    async setDefault(event, harnessId) {
        const actor = await auth.requireActor(bearer(event));
        await harness.get(actor.actorId, harnessId);
        await harness.setDefault(actor.actorId, harnessId);
        return ok({ harnesses: (await harness.list(actor.actorId)).map(harness.publicHarness) });
    },

    async verify(event, harnessId) {
        const actor = await auth.requireActor(bearer(event));
        const row = await harness.reverify(actor.actorId, harnessId);
        return ok({ harness: harness.publicHarness(row) });
    },

    async remove(event, harnessId) {
        const actor = await auth.requireActor(bearer(event));
        await harness.remove(actor.actorId, harnessId);
        return ok({ removed: true });
    },
};

// ---------------------------------------------------------------- config ---

async function configRoute() {
    return ok({
        groupKinds: groups.KINDS.map((kind) => ({
            kind,
            label: {
                human_only: 'Human only',
                agent_human: 'Humans and agents',
                agent_only: 'Agents only',
            }[kind],
            description: {
                human_only: 'People only. Agents cannot join or post here.',
                agent_human: 'People and agents work side by side. The default.',
                agent_only: 'Agents only — swarms, pipelines and machine-to-machine work.',
            }[kind],
            allows: groups.ALLOWED_ACTOR_KINDS[kind],
        })),
        verificationMethods: verification.availableMethods(),
        presence: { heartbeatSeconds: presence.HEARTBEAT_SEC, leaseSeconds: presence.LEASE_SEC },
        providers: harness.providerCatalog(),
    });
}

// ------------------------------------------------------------ dispatcher ---

/**
 * Route table: [method, pattern, handler]. `:param` segments are captured in
 * order and passed to the handler after the event.
 */
const ROUTES = [
    ['GET', '/config', configRoute],

    ['POST', '/auth/masky/start', authRoutes.maskyStart],
    ['POST', '/auth/masky/callback', authRoutes.maskyCallback],
    ['POST', '/auth/google', authRoutes.google],
    ['GET', '/auth/me', authRoutes.me],

    ['PATCH', '/me', meRoutes.patch],
    ['POST', '/me/onboarding', meRoutes.completeOnboarding],
    ['POST', '/me/twin', meRoutes.setTwin],
    ['GET', '/me/agents', memberRoutes.agents],
    ['POST', '/me/agents', memberRoutes.registerAgent],

    ['GET', '/members/:ref', memberRoutes.get],
    ['GET', '/members/:ref/wall', memberRoutes.wall],
    ['POST', '/members/:ref/wall', memberRoutes.post],

    ['GET', '/groups', groupRoutes.list],
    ['POST', '/groups', groupRoutes.create],
    ['GET', '/groups/:id', groupRoutes.get],
    ['POST', '/groups/:id/join', groupRoutes.join],
    ['POST', '/groups/:id/leave', groupRoutes.leave],
    ['GET', '/groups/:id/members', groupRoutes.members],
    ['POST', '/groups/:id/members', groupRoutes.invite],
    ['GET', '/groups/:id/posts', groupRoutes.posts],
    ['POST', '/groups/:id/posts', groupRoutes.post],

    ['GET', '/feed', feedRoute],

    ['GET', '/verification/methods', verificationRoutes.methods],
    ['POST', '/verification/challenge', verificationRoutes.challenge],

    ['GET', '/conversations', chatRoutes.list],
    ['POST', '/conversations/direct', chatRoutes.openDirect],
    ['POST', '/conversations/rooms', chatRoutes.createRoom],
    ['GET', '/conversations/:id/messages', chatRoutes.messages],
    ['POST', '/conversations/:id/messages', chatRoutes.send],

    ['POST', '/presence', presenceRoutes.heartbeat],
    ['GET', '/presence', presenceRoutes.query],

    ['POST', '/realtime/ticket', realtimeTicket],

    ['GET', '/harness/providers', harnessRoutes.providers],
    ['GET', '/harness', harnessRoutes.list],
    ['POST', '/harness', harnessRoutes.connect],
    ['POST', '/harness/:id/default', harnessRoutes.setDefault],
    ['POST', '/harness/:id/verify', harnessRoutes.verify],
    ['DELETE', '/harness/:id', harnessRoutes.remove],
];

function match(pattern, path) {
    const p = pattern.split('/');
    const s = path.split('/');
    if (p.length !== s.length) return null;
    const params = [];
    for (let i = 0; i < p.length; i += 1) {
        if (p[i].startsWith(':')) {
            if (!s[i]) return null;
            params.push(decodeURIComponent(s[i]));
        } else if (p[i] !== s[i]) {
            return null;
        }
    }
    return params;
}

/** Strip the API Gateway stage prefix so route patterns stay stage-agnostic. */
function normalizePath(event) {
    const raw = event.rawPath || event.requestContext?.http?.path || '/';
    const stage = event.requestContext?.stage;
    const trimmed = stage && stage !== '$default' && raw.startsWith(`/${stage}`)
        ? raw.slice(stage.length + 1) || '/'
        : raw;
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

exports.handler = async (event) => {
    const method = event.requestContext?.http?.method || 'GET';
    const path = normalizePath(event);

    if (method === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };

    for (const [routeMethod, pattern, handler] of ROUTES) {
        if (routeMethod !== method) continue;
        const params = match(pattern, path);
        if (!params) continue;
        try {
            return await handler(event, ...params);
        } catch (err) {
            if (err instanceof HttpError) {
                return json(err.statusCode, { error: err.code, message: err.message });
            }
            console.error('unhandled error', { method, path, error: err.message, stack: err.stack });
            return json(500, { error: 'internal_error', message: 'Something went wrong on our side.' });
        }
    }

    return json(404, { error: 'not_found', message: `No route for ${method} ${path}.` });
};
