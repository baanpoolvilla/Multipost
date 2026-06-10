const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
let _server  = null;
let _store   = null;
let _runner  = null;

function init(jobStore, jobRunner) {
    _store  = jobStore;
    _runner = jobRunner;
}

// ── Health check ──────────────────────────────────────────────
app.get('/api/ping', (_, res) => res.json({ ok: true, version: '2.0.0' }));

// ── Agent status ──────────────────────────────────────────────
app.get('/api/status', (_, res) => {
    res.json({
        ok:          true,
        version:     '2.0.0',
        port:        PORT,
        running:     _runner?.isRunning() ?? false,
        dbConnected: _store?.isDbConnected() ?? false,
        uptime:      Math.floor(process.uptime()),
    });
});

// ── Jobs ──────────────────────────────────────────────────────
app.get('/api/jobs', async (_, res) => {
    try {
        const jobs = await _store.getJobs();
        res.json({ ok: true, jobs });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/jobs', async (req, res) => {
    try {
        const { message, groups, delaySeconds, accountId } = req.body;
        if (!message || !groups?.length)
            return res.status(400).json({ ok: false, error: 'message and groups required' });
        const job = await _store.createJob({ message, groups, delaySeconds: delaySeconds || 5, accountId });
        res.json({ ok: true, job });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/jobs/:id', async (req, res) => {
    try {
        await _store.deleteJob(req.params.id);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Start / stop ──────────────────────────────────────────────
function start() {
    _server = app.listen(PORT, '127.0.0.1', () => {
        console.log(`[API] Local API running on http://127.0.0.1:${PORT}`);
    });
    _server.on('error', (e) => {
        if (e.code === 'EADDRINUSE')
            console.warn(`[API] Port ${PORT} already in use — skipping`);
    });
}

function stop() {
    if (_server) _server.close();
}

module.exports = { init, start, stop, PORT };
