const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const path       = require('path');
const AdmZip     = require('adm-zip');
const ctrl       = require('../controllers/postController');
const agentCtrl  = require('../controllers/agentController');
const imageStore = require('../services/imageStore');

// Use memory storage — files are saved to MongoDB (and local disk) by saveUploadedFiles
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024, files: 30 },
    fileFilter: (req, file, cb) => cb(null, /\.(jpe?g|png|gif|webp|mp4|mov|avi|webm)$/i.test(file.originalname)),
});

// Return JSON error instead of HTML for multer errors (and any other upload-route errors)
function multerErrorHandler(err, req, res, next) {
    if (!err) return next();
    const msg = {
        LIMIT_FILE_SIZE:       'ไฟล์มีขนาดใหญ่เกินไป — รูปภาพ Facebook รับสูงสุด 4 MB/ไฟล์ · วิดีโอสูงสุด 1 GB/ไฟล์ (เซิร์ฟเวอร์จำกัดที่ 100 MB/ไฟล์)',
        LIMIT_FILE_COUNT:      'จำนวนไฟล์มากเกินไป (สูงสุด 30 ไฟล์ต่อครั้ง)',
        LIMIT_UNEXPECTED_FILE: 'ชื่อ field ไม่ถูกต้อง กรุณาลองใหม่',
    }[err.code] || err.message || 'อัปโหลดไม่สำเร็จ กรุณาลองใหม่';
    res.status(400).json({ ok: false, error: msg });
}

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

// Upload images — save to MongoDB, return confirmed filenames
router.post('/api/upload-images', upload.array('images', 30), multerErrorHandler, saveUploadedFiles, async (req, res) => {
    const filenames = (req.files || []).map(f => f.filename);
    if (!filenames.length) return res.json({ ok: true, filenames: [] });
    res.json({ ok: true, filenames });
});

// Templates — accept JSON body (images already uploaded via /api/upload-images)
router.get('/api/templates',        ctrl.getTemplates);
router.post('/api/templates',       ctrl.createTemplate);
router.put('/api/templates/:id',    ctrl.updateTemplate);
router.delete('/api/templates/:id', ctrl.deleteTemplate);

// Cron / Scheduler
router.post('/api/cron/run-scheduled', ctrl.runAllScheduled);

// Posts
router.get('/',               ctrl.showDashboard);
router.post('/send',          upload.array('images', 30), multerErrorHandler, saveUploadedFiles, ctrl.sendPost);
router.get('/result/:id',     ctrl.showResult);
router.get('/api/post/:id/status', ctrl.getPostStatus);
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

// Agent download — injects .env with MONGODB_URI so DB connects on first run
router.get('/download/agent', (req, res) => {
    try {
        const mongoUri = process.env.MONGODB_URI || '';
        const zipPath  = path.join(__dirname, '../public/downloads/agent.zip');
        const zip      = new AdmZip(zipPath);
        zip.addFile('multipost-agent/.env', Buffer.from(`MONGODB_URI=${mongoUri}\n`));
        const buf = zip.toBuffer();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="multipost-agent.zip"');
        res.setHeader('Content-Length', buf.length);
        res.send(buf);
    } catch (e) {
        res.status(500).send('ไม่สามารถสร้างไฟล์ดาวน์โหลดได้');
    }
});

// Agent / Groups / Job Queue / Guide pages
router.get('/guide',     (req, res) => res.render('guide'));
router.get('/agent',     agentCtrl.showAgent);
router.get('/groups',    agentCtrl.showGroups);
router.get('/job-queue', agentCtrl.showJobQueue);

// Job Queue API
router.get('/api/agent/jobs',         agentCtrl.listJobs);
router.post('/api/agent/jobs',        agentCtrl.createJob);
router.delete('/api/agent/jobs/:id',  agentCtrl.deleteJob);

// Category API
router.post('/api/agent/categories',         agentCtrl.addCategory);
router.delete('/api/agent/categories/:id',   agentCtrl.deleteCategory);

// Groups API (shared across all users)
router.post('/api/agent/groups',                        agentCtrl.addGroup);
router.delete('/api/agent/groups/:id',                  agentCtrl.deleteGroup);
router.patch('/api/agent/groups/:id/category',          agentCtrl.updateGroupCategory);     // add to category
router.delete('/api/agent/groups/:id/category',         agentCtrl.removeGroupFromCategory); // remove from category
router.post('/api/agent/groups/rename-category',        agentCtrl.bulkRenameCategory);

module.exports = router;
