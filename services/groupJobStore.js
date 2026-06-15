const mongoose = require('mongoose');
const { connect } = require('./db');

const groupJobSchema = new mongoose.Schema({
    message:      { type: String, required: true },
    groups:       [{
        groupId:   String,
        groupName: String,
        pageId:    String,
        pageName:  String,
    }],
    delaySeconds: { type: Number, default: 5 },
    accountId:    { type: String, default: null },
    scheduledAt:  { type: String, default: null },
    status:       { type: String, enum: ['pending','running','done','failed'], default: 'pending' },
    images:       { type: [String], default: [] },
    results:      [{
        groupId:   String,
        groupName: String,
        status:    String,
        error:     String,
        timestamp: String,
    }],
    createdAt:    { type: Date, default: Date.now },
}, { versionKey: false });

const GroupJob = mongoose.models.GroupJob || mongoose.model('GroupJob', groupJobSchema, 'groupjobs');

async function list() {
    try {
        await connect();
        return GroupJob.find().sort({ createdAt: -1 }).limit(100).lean();
    } catch(e) { return []; }
}

async function create(data) {
    try {
        await connect();
        const job = await GroupJob.create(data);
        return job.toObject();
    } catch(e) { throw e; }
}

async function remove(id) {
    try {
        await connect();
        return GroupJob.findByIdAndDelete(id).lean();
    } catch { return null; }
}

async function listHistory() {
    try {
        await connect();
        return GroupJob.find({ status: { $in: ['done', 'failed'] } })
            .sort({ createdAt: -1 }).limit(300).lean();
    } catch(e) { return []; }
}

async function deleteHistory(id) {
    try {
        await connect();
        return GroupJob.findByIdAndDelete(id).lean();
    } catch { return null; }
}

module.exports = { list, create, remove, listHistory, deleteHistory };
