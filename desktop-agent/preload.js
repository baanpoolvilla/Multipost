const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
    // System
    getStatus:       ()         => ipcRenderer.invoke('get-status'),

    // Accounts
    listAccounts:    ()         => ipcRenderer.invoke('accounts:list'),
    addAccount:      (e, p)     => ipcRenderer.invoke('accounts:add', e, p),
    removeAccount:   (id)       => ipcRenderer.invoke('accounts:remove', id),
    loginAccount:    (id)       => ipcRenderer.invoke('accounts:login', id),
    logoutAccount:   (id)       => ipcRenderer.invoke('accounts:logout', id),
    getAccountPages: (id)       => ipcRenderer.invoke('accounts:pages', id),

    // Jobs
    listJobs:        ()               => ipcRenderer.invoke('jobs:list'),
    createJob:       (data)           => ipcRenderer.invoke('jobs:create', data),
    deleteJob:       (id)             => ipcRenderer.invoke('jobs:delete', id),
    deleteAllJobs:   ()               => ipcRenderer.invoke('jobs:delete-all'),
    getGroups:       ()               => ipcRenderer.invoke('jobs:groups'),
    getRecentPosts:  ()               => ipcRenderer.invoke('jobs:recent-posts'),
    getJobHistory:   ()               => ipcRenderer.invoke('jobs:history'),
    rescheduleJob:   (id, schedAt)    => ipcRenderer.invoke('jobs:reschedule', id, schedAt),

    // Runner
    startRunner:     ()         => ipcRenderer.invoke('runner:start'),
    stopRunner:      ()         => ipcRenderer.invoke('runner:stop'),

    // Templates
    listTemplates:   ()         => ipcRenderer.invoke('templates:list'),
    saveTemplate:    (tpl)      => ipcRenderer.invoke('templates:save', tpl),
    getTemplate:     (id)       => ipcRenderer.invoke('templates:get', id),
    deleteTemplate:  (id)       => ipcRenderer.invoke('templates:delete', id),

    // Supabase — upload file from disk path (main process reads file, uploads with service key)
    uploadFile: (filePath, contentType) => ipcRenderer.invoke('file:upload', filePath, contentType),

    // Shell — open URL in default browser
    openUrl:       (url)      => ipcRenderer.invoke('shell:open', url),

    // Local image — read local file as base64 data URL (for localpath:: images)
    getLocalImage: (filePath) => ipcRenderer.invoke('image:get-local', filePath),

    // Web URL — set in .env on download, fallback to localStorage
    webUrl: process.env.WEB_URL || null,

    // Push events → renderer
    on: (channel, cb) => ipcRenderer.on(channel, (_, data) => cb(data)),
});
