const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
    // Facebook login
    loginFacebook: (email, password) => ipcRenderer.invoke('login-facebook', { email, password }),
    checkLogin:     () => ipcRenderer.invoke('check-login'),

    // Groups (read from MongoDB same as web app)
    getGroups:      () => ipcRenderer.invoke('get-groups'),

    // Jobs
    createJob:  (data) => ipcRenderer.invoke('create-job', data),
    getJobs:        () => ipcRenderer.invoke('get-jobs'),
    deleteJob:   (id) => ipcRenderer.invoke('delete-job', id),

    // Runner
    startRunner:    () => ipcRenderer.invoke('start-runner'),
    stopRunner:     () => ipcRenderer.invoke('stop-runner'),
    runnerStatus:   () => ipcRenderer.invoke('runner-status'),

    // Push events from main → renderer
    onLog:       (cb) => ipcRenderer.on('log',        (_, msg)  => cb(msg)),
    onJobUpdate: (cb) => ipcRenderer.on('job-update', (_, job)  => cb(job)),
    onProgress:  (cb) => ipcRenderer.on('progress',   (_, data) => cb(data)),
});
