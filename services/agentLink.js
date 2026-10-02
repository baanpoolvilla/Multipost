// How the posting machine reaches this web app: its only configuration is the
// database URL, so the web publishes its own address and a shared secret in
// the database (collection `agentlink`) and the Agent reads them from there.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { connect } = require('./db');

const ID = 'link';
let _cache = null;

async function col() { await connect(); return mongoose.connection.db.collection('agentlink'); }

// Called on normal web requests; cheap after the first time per process.
async function ensure(baseUrl) {
    if (_cache && (!baseUrl || _cache.webBaseUrl === baseUrl)) return _cache;
    const c = await col();
    let doc = await c.findOne({ _id: ID });
    const set = {};
    if (!doc || !doc.eventSecret) set.eventSecret = crypto.randomBytes(32).toString('hex');
    if (baseUrl && (!doc || doc.webBaseUrl !== baseUrl)) set.webBaseUrl = baseUrl;
    if (Object.keys(set).length) {
        await c.updateOne({ _id: ID }, { $set: set }, { upsert: true });
        doc = await c.findOne({ _id: ID });
    }
    _cache = doc;
    return doc;
}

async function verify(secret) {
    const doc = _cache || await ensure(null);
    if (!doc || !doc.eventSecret || typeof secret !== 'string') return false;
    const a = Buffer.from(secret), b = Buffer.from(doc.eventSecret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { ensure, verify };
