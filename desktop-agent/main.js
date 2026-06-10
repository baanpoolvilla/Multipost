require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let win;

function createWindow() {
    win = new BrowserWindow({
        width: 1000,
        height: 720,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'MultiPost – Desktop Agent',
        backgroundColor: '#1a1b1e',
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
    try { await require('./src/facebookBot').closeBrowser(); } catch {}
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
    try { require('./src/jobRunner').stop(); } catch {}
});

// ── IPC: Facebook ──────────────────────────────────────────
ipcMain.handle('login-facebook', async (_, { email, password }) => {
    return require('./src/facebookBot').loginWithCredentials(email, password);
});

ipcMain.handle('check-login', async () => {
    return require('./src/facebookBot').checkLoginStatus();
});

// ── IPC: Groups ────────────────────────────────────────────
ipcMain.handle('get-groups', async () => {
    return require('./src/jobStore').getAllGroups();
});

// ── IPC: Recent posts ──────────────────────────────────────
ipcMain.handle('get-recent-posts', async () => {
    return require('./src/jobStore').getRecentPosts();
});

// ── IPC: Jobs ──────────────────────────────────────────────
ipcMain.handle('create-job', async (_, jobData) => {
    return require('./src/jobStore').createJob(jobData);
});

ipcMain.handle('get-jobs', async () => {
    return require('./src/jobStore').getJobs();
});

ipcMain.handle('delete-job', async (_, jobId) => {
    return require('./src/jobStore').deleteJob(jobId);
});

// ── IPC: Runner ────────────────────────────────────────────
ipcMain.handle('start-runner', async () => {
    const runner = require('./src/jobRunner');
    runner.start((event, data) => {
        if (win && !win.isDestroyed()) win.webContents.send(event, data);
    });
    return { running: true };
});

ipcMain.handle('stop-runner', async () => {
    require('./src/jobRunner').stop();
    return { running: false };
});

ipcMain.handle('runner-status', async () => {
    return { running: require('./src/jobRunner').isRunning() };
});
