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
    listJobs:        ()         => ipcRenderer.invoke('jobs:list'),
    createJob:       (data)     => ipcRenderer.invoke('jobs:create', data),
    deleteJob:       (id)       => ipcRenderer.invoke('jobs:delete', id),
    getGroups:       ()         => ipcRenderer.invoke('jobs:groups'),
    getRecentPosts:  ()         => ipcRenderer.invoke('jobs:recent-posts'),

    // Runner
    startRunner:     ()         => ipcRenderer.invoke('runner:start'),
    stopRunner:      ()         => ipcRenderer.invoke('runner:stop'),

    // Templates
    listTemplates:   ()         => ipcRenderer.invoke('templates:list'),
    saveTemplate:    (tpl)      => ipcRenderer.invoke('templates:save', tpl),
    deleteTemplate:  (id)       => ipcRenderer.invoke('templates:delete', id),

    // Push events → renderer
    on: (channel, cb) => ipcRenderer.on(channel, (_, data) => cb(data)),
});
