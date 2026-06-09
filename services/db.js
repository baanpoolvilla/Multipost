const mongoose = require('mongoose');

let cached = global._mongooseCache || { conn: null, promise: null };
global._mongooseCache = cached;

async function connect() {
    if (cached.conn) return cached.conn;
    if (!cached.promise) {
        cached.promise = mongoose.connect(process.env.MONGODB_URI, { bufferCommands: false });
    }
    try {
        cached.conn = await cached.promise;
    } catch (e) {
        cached.promise = null;
        throw e;
    }
    return cached.conn;
}

module.exports = { connect };
