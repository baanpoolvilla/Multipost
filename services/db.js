const mongoose = require('mongoose');

let cached = global._mongooseCache || { conn: null, promise: null };
global._mongooseCache = cached;

async function connect() {
    if (cached.conn) return cached.conn;
    if (!process.env.MONGODB_URI) throw new Error('DB_UNAVAILABLE');

    if (!cached.promise) {
        cached.promise = mongoose.connect(process.env.MONGODB_URI, {
            bufferCommands: false,
            serverSelectionTimeoutMS: 8000,
            connectTimeoutMS: 8000,
        });
    }
    try {
        cached.conn = await cached.promise;
        return cached.conn;
    } catch (e) {
        cached.promise = null;   // allow retry next time
        throw new Error('DB_UNAVAILABLE');
    }
}

function isAvailable() { return !!cached.conn; }

module.exports = { connect, isAvailable };
