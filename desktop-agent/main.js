require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const apiServer        = require('./api/server');
const accountStore     = require('./src/accountStore');
const jobStore         = require('./src/jobStore');
const jobRunner        = require('./src/jobRunner');
const facebookBot      = require('./src/facebookBot');
const jobTemplateStore = require('./src/jobTemplateStore');

let win;

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
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
    const userDataDir = app.getPath('userData');

    // Init stores
    accountStore.init(userDataDir);
    facebookBot.init(userDataDir);
    jobTemplateStore.init(userDataDir);
    await jobStore.connect().catch(() => {});

    // Start local API
    apiServer.init(jobStore, jobRunner);
    apiServer.start();

    // Start job runner
    jobRunner.init(jobStore, facebookBot, accountStore, (event, data) => {
        if (win && !win.isDestroyed()) win.webContents.send(event, data);
    });

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
ipcMain.handle('jobs:list',         ()        => jobStore.getJobs());
ipcMain.handle('jobs:create',       (_, data) => jobStore.createJob(data));
ipcMain.handle('jobs:delete',       (_, id)   => jobStore.deleteJob(id));
ipcMain.handle('jobs:delete-all',   ()        => jobStore.deleteAllJobs());
ipcMain.handle('jobs:groups',       ()        => jobStore.getAllGroups());
ipcMain.handle('jobs:recent-posts', ()        => jobStore.getRecentPosts());

// ── IPC: Runner ────────────────────────────────────────────────
ipcMain.handle('runner:start', () => { jobRunner.start(); return { ok: true }; });
ipcMain.handle('runner:stop',  () => { jobRunner.stop();  return { ok: true }; });

// ── IPC: Templates ─────────────────────────────────────────────
ipcMain.handle('templates:list',   ()         => jobTemplateStore.list());
ipcMain.handle('templates:save',   (_, tpl)   => jobTemplateStore.save(tpl));
ipcMain.handle('templates:get',    (_, id)    => jobTemplateStore.getWithImages(id));
ipcMain.handle('templates:delete', (_, id)    => jobTemplateStore.remove(id));
