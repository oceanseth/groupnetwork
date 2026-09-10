/** Thin DynamoDB document-client wrapper. Nothing clever, just less ceremony. */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand,
    DeleteCommand, QueryCommand, BatchWriteCommand, TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.TABLE_NAME;
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
});

async function get(key) {
    const r = await doc.send(new GetCommand({ TableName: TABLE, Key: key }));
    return r.Item || null;
}

async function put(item, opts = {}) {
    await doc.send(new PutCommand({ TableName: TABLE, Item: item, ...opts }));
    return item;
}

async function update(key, params) {
    const r = await doc.send(new UpdateCommand({
        TableName: TABLE, Key: key, ReturnValues: 'ALL_NEW', ...params,
    }));
    return r.Attributes;
}

async function del(key) {
    await doc.send(new DeleteCommand({ TableName: TABLE, Key: key }));
}

/**
 * Query one partition, optionally on gsi1 and optionally by sort-key prefix.
 * `forward:false` reverses; note post partitions already store newest-first.
 */
async function query({ pk, gsi1pk, prefix, limit = 50, forward = true, startKey, filter }) {
    const onIndex = gsi1pk !== undefined;
    const names = { '#pk': onIndex ? 'gsi1pk' : 'pk' };
    const values = { ':pk': onIndex ? gsi1pk : pk };
    let expr = '#pk = :pk';
    if (prefix) {
        names['#sk'] = onIndex ? 'gsi1sk' : 'sk';
        values[':prefix'] = prefix;
        expr += ' AND begins_with(#sk, :prefix)';
    }
    const cmd = new QueryCommand({
        TableName: TABLE,
        IndexName: onIndex ? 'gsi1' : undefined,
        KeyConditionExpression: expr,
        ExpressionAttributeNames: { ...names, ...(filter?.names || {}) },
        ExpressionAttributeValues: { ...values, ...(filter?.values || {}) },
        FilterExpression: filter?.expr,
        Limit: limit,
        ScanIndexForward: forward,
        ExclusiveStartKey: startKey,
    });
    const r = await doc.send(cmd);
    return { items: r.Items || [], nextKey: r.LastEvaluatedKey || null };
}

/** Every page of a query. Only used where the set is bounded (members, subs). */
async function queryAll(params) {
    const out = [];
    let startKey;
    do {
        const page = await query({ ...params, limit: 200, startKey });
        out.push(...page.items);
        startKey = page.nextKey;
    } while (startKey);
    return out;
}

async function batchDelete(keys) {
    for (let i = 0; i < keys.length; i += 25) {
        const chunk = keys.slice(i, i + 25);
        await doc.send(new BatchWriteCommand({
            RequestItems: { [TABLE]: chunk.map((Key) => ({ DeleteRequest: { Key } })) },
        }));
    }
}

async function transact(items) {
    await doc.send(new TransactWriteCommand({ TransactItems: items }));
}

module.exports = { doc, TABLE, get, put, update, del, query, queryAll, batchDelete, transact };
