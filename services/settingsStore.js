const mongoose = require('mongoose');
const { connect } = require('./db');

const settingsSchema = new mongoose.Schema({
    _id:          { type: String, default: 'main' },
    fbAppId:      { type: String, default: '' },
    fbAppSecret:  { type: String, default: '' },
}, { versionKey: false });

const Settings = mongoose.models.Settings || mongoose.model('Settings', settingsSchema);

async function load() {
    const fromEnv = {
        fbAppId:     process.env.FB_APP_ID     || '',
        fbAppSecret: process.env.FB_APP_SECRET || '',
    };
    try {
        await connect();
        const s = await Settings.findById('main').lean();
        return {
            fbAppId:     fromEnv.fbAppId     || (s && s.fbAppId)     || '',
            fbAppSecret: fromEnv.fbAppSecret || (s && s.fbAppSecret) || '',
        };
    } catch {
        return fromEnv;
    }
}

async function save(data) {
    await connect();
    await Settings.findByIdAndUpdate('main', { $set: data }, { upsert: true, new: true });
}

module.exports = { load, save };
