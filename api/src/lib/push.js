/**
 * Delivery to live sockets.
 *
 * Subscriptions live in the table as TOPIC#<topic> / CONN#<id> rows, so pushing
 * to a topic is one Query plus a PostToConnection per subscriber. A socket that
 * has gone away answers 410 and we reap its rows on the spot — that is the only
 * cleanup path that catches connections lost without a $disconnect.
 */
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const ddb = require('./ddb');
const { keys } = require('./keys');

let client;
function gateway(endpoint) {
    const url = endpoint || process.env.WS_ENDPOINT;
    if (!client) client = new ApiGatewayManagementApiClient({ endpoint: url });
    return client;
}

/** Drop every trace of a dead socket: its subscriptions and its own row. */
async function reapConnection(connectionId) {
    const subs = await ddb.queryAll(keys.connSubsIndex(connectionId));
    await ddb.batchDelete(subs.map((s) => ({ pk: s.pk, sk: s.sk })));
    await ddb.del(keys.connection(connectionId));
}

async function sendToConnection(connectionId, payload, endpoint) {
    try {
        await gateway(endpoint).send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: Buffer.from(JSON.stringify(payload)),
        }));
        return true;
    } catch (err) {
        if (err.name === 'GoneException' || err.$metadata?.httpStatusCode === 410) {
            await reapConnection(connectionId).catch(() => {});
            return false;
        }
        console.error('push failed', { connectionId, error: err.message });
        return false;
    }
}

/** Fan a single event out to everyone subscribed to `topic`. */
async function publish(topic, payload, endpoint) {
    const subs = await ddb.queryAll(keys.topicPrefix(topic));
    if (!subs.length) return 0;
    const body = { ...payload, topic };
    const results = await Promise.all(subs.map((sub) =>
        sendToConnection(sub.sk.slice('CONN#'.length), body, endpoint)));
    return results.filter(Boolean).length;
}

module.exports = { publish, sendToConnection, reapConnection };
