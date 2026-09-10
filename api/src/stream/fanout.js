/**
 * The single delivery path.
 *
 * Every realtime event in the product is a DynamoDB write that passed through
 * here: a message, a post, someone joining a group, someone going online or
 * timing out. Nothing pushes to sockets except this function, which is why an
 * action taken over HTTP and the same action taken over the socket look
 * identical to every recipient.
 */
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const actors = require('../lib/actors');
const groups = require('../lib/groups');
const posts = require('../lib/posts');
const conversations = require('../lib/conversations');
const presence = require('../lib/presence');
const { topics } = require('../lib/keys');
const { publish } = require('../lib/push');

const image = (record, which) =>
    (record.dynamodb?.[which] ? unmarshall(record.dynamodb[which]) : null);

/**
 * Turn one stream record into `{ topics, payload }`, or null to ignore it.
 * Infrastructure rows (subscriptions, connections, tickets, handle claims)
 * deliberately fall through — they are bookkeeping, not events.
 */
async function toEvent(record) {
    const isRemove = record.eventName === 'REMOVE';
    const item = image(record, isRemove ? 'OldImage' : 'NewImage');
    if (!item?.type) return null;

    switch (item.type) {
        case 'message': {
            if (record.eventName !== 'INSERT') return null;
            const actorMap = await actors.hydrate([item.senderActorId]);
            return {
                topics: [topics.conversation(item.convId)],
                payload: { type: 'message', message: conversations.publicMessage(item, actorMap) },
            };
        }

        case 'post': {
            if (record.eventName !== 'INSERT') return null;
            // An anonymous post must not hydrate its author, or the author
            // would ride out to every subscriber on the socket.
            const actorMap = item.attribution === 'anonymous'
                ? new Map()
                : await actors.hydrate([item.authorActorId]);
            const topic = item.surface === 'wall'
                ? topics.wall(item.surfaceId)
                : topics.group(item.surfaceId);
            return {
                topics: [topic],
                payload: { type: 'post', post: posts.renderPost(item, actorMap) },
            };
        }

        case 'presence': {
            const previous = image(record, 'OldImage');

            if (isRemove) {
                // Either a clean sign-off or a TTL expiry — the lease lapsed
                // and the member is offline either way.
                return {
                    topics: await presenceTopics(item.actorId),
                    payload: {
                        type: 'presence',
                        actorId: item.actorId,
                        presence: { status: 'offline', detail: null, lastSeen: item.updatedAt || null },
                        reason: record.userIdentity?.principalId === 'dynamodb.amazonaws.com' ? 'expired' : 'signed_out',
                    },
                };
            }

            // Heartbeats land every 30s and mostly say nothing new. Only push
            // when the state a client renders actually changed.
            if (previous && previous.status === item.status && previous.detail === item.detail) return null;

            return {
                topics: await presenceTopics(item.actorId),
                payload: { type: 'presence', actorId: item.actorId, presence: presence.view(item) },
            };
        }

        case 'groupMember': {
            const actor = await actors.byId(item.actorId);
            return {
                topics: [topics.group(item.groupId)],
                payload: {
                    type: isRemove ? 'member_left' : 'member_joined',
                    groupId: item.groupId,
                    member: actor ? actors.publicActor(actor) : { actorId: item.actorId, kind: item.actorKind },
                    role: item.role,
                },
            };
        }

        default:
            return null;
    }
}

/**
 * Where a presence change is interesting: the member's own presence topic, and
 * every group they are in — that is what keeps a group's member list live.
 */
async function presenceTopics(actorId) {
    const mine = await groups.groupsForActor(actorId).catch(() => []);
    return [topics.presence(actorId), ...mine.map(({ group }) => topics.group(group.groupId))];
}

exports.handler = async (event) => {
    // Records are processed in order within a shard; a failure in one must not
    // silently drop the rest of the batch, so each is isolated and logged.
    for (const record of event.Records || []) {
        try {
            const result = await toEvent(record);
            if (!result) continue;
            await Promise.all(result.topics.map((topic) => publish(topic, result.payload)));
        } catch (err) {
            console.error('fan-out failed for record', {
                eventName: record.eventName,
                keys: record.dynamodb?.Keys,
                error: err.message,
            });
        }
    }
    return { batchItemFailures: [] };
};
