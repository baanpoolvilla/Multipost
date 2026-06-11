const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const path       = require('path');
const ctrl       = require('../controllers/postController');
const agentCtrl  = require('../controllers/agentController');
const imageStore = require('../services/imageStore');

// Use memory storage — files are saved to MongoDB (and local disk) by saveUploadedFiles
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /\.(jpe?g|png|gif|webp)$/i.test(file.originalname)),
});

// Assign filenames and persist buffers to MongoDB (+ local disk)
async function saveUploadedFiles(req, res, next) {
    if (!req.files || req.files.length === 0) return next();
    try {
        for (const file of req.files) {
            const ext = path.extname(file.originalname).toLowerCase();
            file.filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
            await imageStore.save(file.filename, file.buffer, file.mimetype);
        }
        next();
    } catch (err) {
        next(err);
    }
}

// Serve uploaded images from MongoDB (works on Vercel where /tmp is ephemeral)
router.get('/uploads/:filename', async (req, res) => {
    const result = await imageStore.getBuffer(req.params.filename);
    if (!result) return res.status(404).send('Not found');
    res.set('Content-Type', result.contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(result.buffer);
});

// Upload images — save to MongoDB, verify retrieval, return confirmed filenames
router.post('/api/upload-images', upload.array('images', 10), saveUploadedFiles, async (req, res) => {
    const filenames = (req.files || []).map(f => f.filename);
    if (!filenames.length) return res.json({ ok: true, filenames: [] });
    // Verify at least the first file is retrievable before returning success
    const ok = await imageStore.exists(filenames[0]);
    if (!ok) return res.status(500).json({ ok: false, error: 'บันทึกรูปไม่สำเร็จ — กรุณาตรวจสอบ MongoDB connection' });
    res.json({ ok: true, filenames });
});

// Templates — accept JSON body (images already uploaded via /api/upload-images)
router.get('/api/templates',        ctrl.getTemplates);
router.post('/api/templates',       ctrl.createTemplate);
router.put('/api/templates/:id',    ctrl.updateTemplate);
router.delete('/api/templates/:id', ctrl.deleteTemplate);

// Posts
router.get('/',               ctrl.showDashboard);
router.post('/send',          upload.array('images', 10), saveUploadedFiles, ctrl.sendPost);
router.get('/result/:id',     ctrl.showResult);
router.get('/history',        ctrl.showHistory);
router.delete('/history/:id', ctrl.deletePost);
router.get('/overview',               ctrl.showOverview);
router.get('/api/stats',              ctrl.overviewStats);
router.post('/api/refresh-analytics', ctrl.refreshAnalytics);
router.get('/api/daily-summary',      ctrl.dailySummary);
router.get('/api/check-tokens',       ctrl.checkTokens);
router.post('/api/exchange-token',    ctrl.exchangeToken);
router.get('/api/settings',          ctrl.getSettings);
router.post('/api/settings',         ctrl.saveSettings);

// Group management
router.post('/pages/:pageId/groups/sync',          ctrl.syncGroups);
router.get('/pages/:pageId/groups/lookup',         ctrl.lookupGroup);
router.post('/pages/:pageId/groups',               ctrl.addGroup);
router.delete('/pages/:pageId/groups/:groupId',    ctrl.removeGroup);
router.patch('/pages/:pageId/groups/:groupId',     ctrl.toggleGroup);

// Page management
router.get('/pages/lookup-token', ctrl.lookupToken);
router.get('/pages/from-token',  ctrl.importPagesFromToken);
router.get('/pages',          ctrl.showPages);
router.post('/pages',         ctrl.addPage);
router.put('/pages/:id',      ctrl.updatePage);
router.delete('/pages/:id',   ctrl.deletePage);

// Agent / Groups / Job Queue pages
router.get('/agent',     agentCtrl.showAgent);
router.get('/groups',    agentCtrl.showGroups);
router.get('/job-queue', agentCtrl.showJobQueue);

// Job Queue API
router.get('/api/agent/jobs',         agentCtrl.listJobs);
router.post('/api/agent/jobs',        agentCtrl.createJob);
router.delete('/api/agent/jobs/:id',  agentCtrl.deleteJob);

// Groups API (shared across all users)
router.post('/api/agent/groups',        agentCtrl.addGroup);
router.delete('/api/agent/groups/:id',  agentCtrl.deleteGroup);

module.exports = router;
