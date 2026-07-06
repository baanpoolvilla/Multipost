require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { app, BrowserWindow, ipcMain, shell, Notification } = require('electron');

app.commandLine.appendSwitch('lang', 'en-GB');
const path = require('path');
const fs   = require('fs');
const { randomUUID } = require('crypto');

function getOrCreateAgentId(userDataDir) {
    const idFile = path.join(userDataDir, 'agent-id.txt');
    try { return fs.readFileSync(idFile, 'utf-8').trim(); } catch {}
    const id = randomUUID();
    fs.writeFileSync(idFile, id);
    return id;
}

// "Who is using this Desktop Agent install" — picked once via the renderer's
// staff picker (see renderer/app.js checkStaffSelection), persisted locally
// so it survives restarts without asking again. Unlike agentId this is never
// auto-generated — it stays null (shows as "ไม่ระบุ" in /user-activity) until
// a person actually picks their name.
function getSelectedStaff(userDataDir) {
    const staffFile = path.join(userDataDir, 'staff-selection.json');
    try { return JSON.parse(fs.readFileSync(staffFile, 'utf-8')); } catch { return null; }
}
function saveSelectedStaff(userDataDir, staff) {
    const staffFile = path.join(userDataDir, 'staff-selection.json');
    fs.writeFileSync(staffFile, JSON.stringify(staff));
}

const apiServer        = require('./api/server');
const accountStore     = require('./src/accountStore');
const jobStore         = require('./src/jobStore');
const jobRunner        = require('./src/jobRunner');
const facebookBot      = require('./src/facebookBot');
const jobTemplateStore = require('./src/jobTemplateStore');
const agentPresence    = require('./src/agentPresence');

let win;
let _userDataDir  = null;
let _currentStaff = null; // { id, displayName } | null
let _agentId      = null;

// Tells the web dashboard "this machine is online and signed in as this
// staff member" so a web-created job for that staff can be pinned here
// instead of left for any running agent to grab. Runs well inside
// agentPresence.ONLINE_THRESHOLD_MS so a closed/crashed Agent is correctly
// seen as offline soon after it stops.
const HEARTBEAT_INTERVAL_MS = 20 * 1000;
function heartbeat() {
    agentPresence.heartbeat(_agentId, _currentStaff?.id, _currentStaff?.displayName).catch(() => {});
}

// ── Window ─────────────────────────────────────────────────────
function createWindow() {
    win = new BrowserWindow({
        width: 1050, height: 740,
        minWidth: 860, minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'MultiPost – Desktop Agent v2',
        backgroundColor: '#1a1b1e',
        icon: path.join(__dirname, 'assets', 'icon.ico'),
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
    const userDataDir = app.getPath('userData');
    _userDataDir = userDataDir;

    // Init stores
    accountStore.init(userDataDir);
    facebookBot.init(userDataDir);
    // jobTemplateStore now uses MongoDB — no local init needed
    _agentId = getOrCreateAgentId(userDataDir);
    jobStore.setAgentId(_agentId);
    await jobStore.connect().catch(() => {});

    _currentStaff = getSelectedStaff(userDataDir);
    if (_currentStaff) {
        // Best-effort re-check: if this staff was deleted on the web side
        // while the Agent was closed, don't keep silently stamping a
        // nonexistent staffId on every job. If the DB isn't reachable right
        // now, keep the cached selection rather than forcing the picker.
        const staffList = await jobStore.listStaff().catch(() => null);
        if (staffList && !staffList.some(s => s.id === _currentStaff.id)) {
            _currentStaff = null;
        } else {
            jobStore.setStaffId(_currentStaff.id);
        }
    }

    // Tell the web dashboard this machine is online (and who as) right away,
    // then keep doing so — see agentPresence.js.
    heartbeat();
    setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

    // Part 9: catch up on expiry as soon as the Agent has a DB connection —
    // before the queue is ever shown or polled, regardless of whether
    // auto-posting is turned on yet.
    await jobStore.migrateLegacyStatuses().catch(() => {});
    await jobStore.expireOverdueJobs().catch(() => {});

    // Start local API
    apiServer.init(jobStore, jobRunner);
    apiServer.start();

    // Start job runner
    jobRunner.init(jobStore, facebookBot, accountStore, (event, data) => {
        if (win && !win.isDestroyed()) win.webContents.send(event, data);
    }, _agentId);

    createWindow();
});

app.on('window-all-closed', async () => {
    jobRunner.stop();
    apiServer.stop();
    await facebookBot.closeAll().catch(() => {});
    if (process.platform !== 'darwin') app.quit();
});

// ── IPC: System ────────────────────────────────────────────────
ipcMain.handle('get-status', () => ({
    running:     jobRunner.isRunning(),
    dbConnected: jobStore.isDbConnected(),
    apiPort:     apiServer.PORT,
    version:     '2.0.0',
    uptime:      Math.floor(process.uptime()),
}));

// ── IPC: Staff ("who is using this install") ───────────────────
ipcMain.handle('staff:list',        ()             => jobStore.listStaff());
ipcMain.handle('staff:get-current', ()             => _currentStaff);
ipcMain.handle('staff:set-current', async (_, id, name) => {
    // Re-check against the DB rather than trusting the renderer's id blindly —
    // it may have gone stale (deleted on the web side) between listing and
    // the click, or the message could be spoofed by anything running in the
    // renderer's JS context.
    const staffList = await jobStore.listStaff();
    const match = staffList.find(s => s.id === id);
    if (!match) return { ok: false, error: 'ไม่พบผู้ใช้งานนี้ในระบบ กรุณาเลือกใหม่' };

    _currentStaff = { id: match.id, displayName: match.displayName };
    saveSelectedStaff(_userDataDir, _currentStaff);
    jobStore.setStaffId(match.id);
    heartbeat(); // reflect the switch immediately instead of waiting up to HEARTBEAT_INTERVAL_MS
    return { ok: true };
});

// ── IPC: Accounts ──────────────────────────────────────────────
ipcMain.handle('accounts:list',   ()          => accountStore.list());
ipcMain.handle('accounts:add',    (_, e, p)   => accountStore.add(e, p));
ipcMain.handle('accounts:remove', (_, id)     => accountStore.remove(id));

ipcMain.handle('accounts:pages', async (_, id) => facebookBot.getAccountPages(id));

ipcMain.handle('accounts:login', async (_, id) => {
    const acc = accountStore.get(id);
    if (!acc) return { ok: false, error: 'ไม่พบ account' };
    const result = await facebookBot.loginAccount(acc, (msg) => {
        const ts = new Date().toLocaleTimeString('th-TH', { hour12: false });
        if (win && !win.isDestroyed()) win.webContents.send('log', `[${ts}] 🔑 ${msg}`);
    });
    accountStore.updateStatus(id, result.ok ? 'logged_in' : 'error');
    if (win && !win.isDestroyed()) win.webContents.send('accounts:updated');
    return result;
});

ipcMain.handle('accounts:logout', (_, id) => {
    accountStore.updateStatus(id, 'logged_out');
    facebookBot.closeContext(id);
    if (win && !win.isDestroyed()) win.webContents.send('accounts:updated');
    return { ok: true };
});

// ── IPC: Jobs ──────────────────────────────────────────────────
ipcMain.handle('jobs:list',         ()            => jobStore.getJobs());
ipcMain.handle('jobs:create',       (_, data)     => jobStore.createJob(data));
ipcMain.handle('jobs:delete',       (_, id)       => jobStore.deleteJob(id));
ipcMain.handle('jobs:delete-all',   ()            => jobStore.deleteAllJobs());
ipcMain.handle('jobs:groups',       ()            => jobStore.getAllGroups());
ipcMain.handle('jobs:recent-posts', ()            => jobStore.getRecentPosts());
ipcMain.handle('jobs:history',      ()            => jobStore.getCompletedJobs());
ipcMain.handle('jobs:reschedule',   (_, id, at)   => jobStore.rescheduleJob(id, at));
ipcMain.handle('jobs:expired',      ()            => jobStore.listExpiredJobs());
ipcMain.handle('jobs:retry',        (_, id)       => jobStore.retryJob(id));
ipcMain.handle('jobs:cancel',       (_, id)       => jobStore.cancelJob(id));

ipcMain.handle('notify:show', (_, title, body) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
    return { ok: true };
});

// ── IPC: Shell / image utilities ───────────────────────────────
ipcMain.handle('shell:open', (_, url) => shell.openExternal(url));

ipcMain.handle('image:get-local', async (_, filePath) => {
    const fs   = require('fs');
    const path = require('path');
    try {
        const ext  = path.extname(filePath).slice(1).toLowerCase();
        const mime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' }[ext] || 'image/jpeg';
        const buf  = await fs.promises.readFile(filePath);
        return `data:${mime};base64,${buf.toString('base64')}`;
    } catch { return null; }
});

// ── IPC: Runner ────────────────────────────────────────────────
ipcMain.handle('runner:start', () => { jobRunner.start(); return { ok: true }; });
ipcMain.handle('runner:stop',  () => { jobRunner.stop();  return { ok: true }; });

// ── IPC: Templates ─────────────────────────────────────────────
ipcMain.handle('templates:list',        ()              => jobTemplateStore.list());
ipcMain.handle('templates:save',        (_, tpl)        => jobTemplateStore.save(tpl));
ipcMain.handle('templates:get',         (_, id)         => jobTemplateStore.getWithImages(id));
ipcMain.handle('templates:delete',      (_, id)         => jobTemplateStore.remove(id));
ipcMain.handle('templates:move-folder', (_, id, folder) => jobTemplateStore.updateFolder(id, folder));

// ── IPC: Upload file from disk path → Supabase (best) → MongoDB (images) → localpath (videos) ──
ipcMain.handle('file:upload', async (_, filePath, contentType) => {
    const fs       = require('fs');
    const nodePath = require('path');
    const supa     = require('./src/supabaseStore');
    const imgStore = require('./src/agentImageStore');
    const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv']);
    const ext  = nodePath.extname(filePath).toLowerCase();
    const buf  = await fs.promises.readFile(filePath);
    const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

    // 1st choice: Supabase (images + videos, accessible everywhere)
    try { return await supa.upload(fname, buf, contentType); } catch {}

    // Videos: too large for MongoDB → local path only
    if (VIDEO_EXTS.has(ext)) {
        console.warn('[file:upload] Supabase unavailable, video stored locally');
        return `localpath::${filePath}`;
    }

    // Images: MongoDB fallback (shared via cloud DB, accessible from every machine)
    try {
        const fname2 = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        const result = await imgStore.save(fname2, buf, contentType || 'image/jpeg');
        return result || fname2; // result = Supabase URL if re-tried ok, else fname2 = MongoDB key
    } catch {
        return `localpath::${filePath}`;
    }
});
