const { GridFSBucket } = require('mongodb');
const mongoose = require('mongoose');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const { connect } = require('./jobStore');

const BUCKET = 'agentmedia';

async function _bucket() {
    await connect();
    return new GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
}

async function save(filename, buffer, contentType) {
    const bucket = await _bucket();
    // Remove old file with same name first
    const existing = await bucket.find({ filename }).toArray();
    for (const f of existing) { try { await bucket.delete(f._id); } catch {} }

    await new Promise((resolve, reject) => {
        const up = bucket.openUploadStream(filename, { metadata: { contentType } });
        up.on('error', reject);
        up.on('finish', resolve);
        up.end(buffer);
    });
}

async function downloadToTemp(filename) {
    try {
        const bucket = await _bucket();
        const files = await bucket.find({ filename }).toArray();
        if (!files.length) return null;
        const tmpPath = path.join(os.tmpdir(), filename);
        await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(tmpPath);
            const rs = bucket.openDownloadStreamByName(filename);
            rs.on('error', reject);
            ws.on('error', reject);
            ws.on('finish', resolve);
            rs.pipe(ws);
        });
        return tmpPath;
    } catch { return null; }
}

async function remove(filename) {
    try {
        const bucket = await _bucket();
        const files = await bucket.find({ filename }).toArray();
        for (const f of files) { try { await bucket.delete(f._id); } catch {} }
    } catch {}
}

module.exports = { save, downloadToTemp, remove };
