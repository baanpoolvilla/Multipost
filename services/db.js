const mongoose = require('mongoose');

let cached = global._mongooseCache || { conn: null, promise: null, failed: false };
global._mongooseCache = cached;

async function connect() {
    if (cached.failed) throw new Error('DB_UNAVAILABLE');
    if (cached.conn)   return cached.conn;
    if (!process.env.MONGODB_URI) { cached.failed = true; throw new Error('DB_UNAVAILABLE'); }

    if (!cached.promise) {
        cached.promise = mongoose.connect(process.env.MONGODB_URI, {
            bufferCommands:    false,
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS:         5000,
        });
    }
    try {
        cached.conn = await cached.promise;
        return cached.conn;
    } catch (e) {
        cached.promise = null;
        cached.failed  = true;
        throw new Error('DB_UNAVAILABLE');
    }
}

function isAvailable() { return !cached.failed && !!cached.conn; }

module.exports = { connect, isAvailable };
