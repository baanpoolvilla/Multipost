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
    pageId:       { type: String, default: null },
    pageName:     { type: String, default: null },
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

async function getById(id) {
    try {
        await connect();
        const mongoose = require('mongoose');
        return GroupJob.findById(new mongoose.Types.ObjectId(id)).lean();
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

async function statsByDateRange(fromDate, toDate) {
    try {
        await connect();
        const q = { status: { $in: ['done', 'failed'] } };
        if (fromDate || toDate) {
            q.createdAt = {};
            if (fromDate) q.createdAt.$gte = fromDate;
            if (toDate)   q.createdAt.$lte = toDate;
        }
        const jobs = await GroupJob.find(q).lean();
        return {
            total:   jobs.length,
            success: jobs.reduce((s, j) => s + (j.results || []).filter(r => r.status === 'success').length, 0),
            fail:    jobs.reduce((s, j) => s + (j.results || []).filter(r => r.status === 'failed').length, 0),
        };
    } catch { return { total: 0, success: 0, fail: 0 }; }
}

async function updateOne(id, data) {
    try {
        await connect();
        return GroupJob.findByIdAndUpdate(id, { $set: data }, { new: true }).lean();
    } catch { return null; }
}

async function listScheduled() {
    try {
        await connect();
        return GroupJob.find({ status: 'pending', scheduledAt: { $ne: null } }).sort({ scheduledAt: 1 }).lean();
    } catch { return []; }
}

module.exports = { list, create, remove, listHistory, deleteHistory, getById, statsByDateRange, updateOne, listScheduled };
