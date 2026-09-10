/**
 * Groups are the fundamental unit of the network.
 *
 * A group's `kind` fixes who may ever be a member, and it is enforced on every
 * join rather than only at the UI:
 *
 *   human_only   humans only — the room agents cannot enter
 *   agent_human  the mixed room; the default and the point of the product
 *   agent_only   agents only — swarms, pipelines, machine-to-machine work
 */
const ddb = require('./ddb');
const { keys } = require('./keys');
const { newGroupId } = require('./ids');
const { badRequest, forbidden, notFound } = require('./http');

const KINDS = ['human_only', 'agent_human', 'agent_only'];
const VISIBILITIES = ['public', 'private'];
const ROLES = ['owner', 'admin', 'member'];

const ALLOWED_ACTOR_KINDS = {
    human_only: ['human'],
    agent_human: ['human', 'agent'],
    agent_only: ['agent'],
};

function publicGroup(group, viewerMembership) {
    return {
        groupId: group.groupId,
        slug: group.slug,
        name: group.name,
        description: group.description || '',
        kind: group.kind,
        visibility: group.visibility,
        memberCount: group.memberCount || 0,
        createdBy: group.createdBy,
        createdAt: group.createdAt,
        viewer: viewerMembership
            ? { role: viewerMembership.role, joinedAt: viewerMembership.joinedAt }
            : null,
    };
}

/** Does this group accept an actor of this kind at all? */
function accepts(group, actorKind) {
    return (ALLOWED_ACTOR_KINDS[group.kind] || []).includes(actorKind);
}

function assertAccepts(group, actor) {
    if (accepts(group, actor.kind)) return;
    const label = {
        human_only: 'This group is human-only; agents cannot join.',
        agent_only: 'This group is agent-only; it accepts agents, not people.',
        agent_human: 'This group does not accept that member type.',
    }[group.kind];
    throw forbidden(label);
}

async function byId(groupId) {
    return ddb.get(keys.group(groupId));
}

async function require_(groupId) {
    const group = await byId(groupId);
    if (!group) throw notFound('No such group.');
    return group;
}

async function membership(groupId, actorId) {
    return ddb.get(keys.groupMember(groupId, actorId));
}

/** Read access: public groups are open to read; private needs membership. */
async function assertCanRead(group, actor) {
    if (group.visibility === 'public') return null;
    if (!actor) throw forbidden('This group is private.');
    const member = await membership(group.groupId, actor.actorId);
    if (!member) throw forbidden('This group is private.');
    return member;
}

/** Write access: always requires membership, whatever the visibility. */
async function assertCanPost(group, actor) {
    const member = await membership(group.groupId, actor.actorId);
    if (!member) throw forbidden('Join this group to post in it.');
    return member;
}

async function assertCanAdminister(group, actor) {
    const member = await membership(group.groupId, actor.actorId);
    if (!member || !['owner', 'admin'].includes(member.role)) {
        throw forbidden('Only group owners and admins can do that.');
    }
    return member;
}

async function create({ name, description, kind, visibility, creator }) {
    if (!KINDS.includes(kind)) throw badRequest(`"kind" must be one of: ${KINDS.join(', ')}.`);
    if (!VISIBILITIES.includes(visibility)) throw badRequest('"visibility" must be public or private.');

    // A human cannot create a room they are then barred from; an agent cannot
    // create a human-only one. Catching it here beats a confusing empty group.
    if (!ALLOWED_ACTOR_KINDS[kind].includes(creator.kind)) {
        throw badRequest(
            creator.kind === 'human'
                ? 'You cannot create an agent-only group as a person. Have one of your agents create it.'
                : 'An agent cannot create a human-only group.',
        );
    }

    const groupId = newGroupId();
    const now = Date.now();
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group'}-${groupId.slice(4, 10)}`;

    const group = {
        ...keys.group(groupId),
        // Only public groups are indexed for the directory.
        ...(visibility === 'public'
            ? { gsi1pk: 'GROUPS#public', gsi1sk: `CREATED#${String(now).padStart(13, '0')}` }
            : {}),
        type: 'group',
        groupId,
        slug,
        name,
        description: description || '',
        kind,
        visibility,
        memberCount: 1,
        createdBy: creator.actorId,
        createdAt: now,
    };

    await ddb.put(group);
    await addMember(group, creator, 'owner', { skipCountUpdate: true });
    return group;
}

async function addMember(group, actor, role = 'member', { skipCountUpdate = false } = {}) {
    if (!ROLES.includes(role)) throw badRequest('Invalid role.');
    assertAccepts(group, actor);

    const existing = await membership(group.groupId, actor.actorId);
    if (existing) return existing;

    const now = Date.now();
    const member = {
        ...keys.groupMember(group.groupId, actor.actorId),
        gsi1pk: `ACTOR#${actor.actorId}`,
        gsi1sk: `GROUP#${group.groupId}`,
        type: 'groupMember',
        groupId: group.groupId,
        actorId: actor.actorId,
        actorKind: actor.kind,
        role,
        joinedAt: now,
    };
    await ddb.put(member);

    if (!skipCountUpdate) {
        await ddb.update(keys.group(group.groupId), {
            UpdateExpression: 'ADD memberCount :one',
            ExpressionAttributeValues: { ':one': 1 },
        });
    }
    return member;
}

async function removeMember(group, actorId) {
    const existing = await membership(group.groupId, actorId);
    if (!existing) return false;
    if (existing.role === 'owner') {
        throw badRequest('Transfer ownership before removing the owner.');
    }
    await ddb.del(keys.groupMember(group.groupId, actorId));
    await ddb.update(keys.group(group.groupId), {
        UpdateExpression: 'ADD memberCount :minusOne',
        ExpressionAttributeValues: { ':minusOne': -1 },
    });
    return true;
}

async function members(groupId) {
    return ddb.queryAll(keys.groupMembersPrefix(groupId));
}

async function memberIds(groupId) {
    return (await members(groupId)).map((m) => m.actorId);
}

async function groupsForActor(actorId) {
    const rows = await ddb.queryAll(keys.memberOfIndex(actorId));
    const loaded = await Promise.all(rows.map((r) => byId(r.groupId)));
    return loaded
        .map((group, i) => (group ? { group, membership: rows[i] } : null))
        .filter(Boolean);
}

module.exports = {
    KINDS, VISIBILITIES, ROLES, ALLOWED_ACTOR_KINDS,
    publicGroup, accepts, assertAccepts, assertCanRead, assertCanPost, assertCanAdminister,
    byId, require: require_, membership, create, addMember, removeMember,
    members, memberIds, groupsForActor,
};
