const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const AdmZip     = require('adm-zip');
const ctrl       = require('../controllers/postController');
const agentCtrl  = require('../controllers/agentController');
const authCtrl   = require('../controllers/authController');
const staffCtrl  = require('../controllers/staffController');
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

// Serve uploaded images — redirect to Supabase URL when available
router.get('/uploads/:filename', async (req, res) => {
    const { filename } = req.params;
    const publicUrl = await imageStore.getPublicUrl(filename);
    if (publicUrl?.startsWith('http')) {
        return res.redirect(301, publicUrl);
    }
    // Legacy fallback: serve binary from MongoDB/disk
    const result = await imageStore.getBuffer(filename);
    if (!result) return res.status(404).send('Not found');
    res.set('Content-Type', result.contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(result.buffer);
});

// Upload images — save to MongoDB, return confirmed filenames (legacy fallback)
router.post('/api/upload-images', upload.array('images', 30), multerErrorHandler, saveUploadedFiles, async (req, res) => {
    const filenames = (req.files || []).map(f => f.filename);
    if (!filenames.length) return res.json({ ok: true, filenames: [] });
    res.json({ ok: true, filenames });
});

// Generate Supabase signed upload URL — browser uploads directly to Supabase
router.get('/api/sign-upload', async (req, res) => {
    const supa = require('../services/supabaseStore');
    try {
        const { ext } = req.query;
        const result  = await supa.createSignedUploadUrl(ext || '');
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Auth
router.get('/login',   authCtrl.showLogin);
router.post('/login',  authCtrl.login);
router.post('/logout', authCtrl.logout);

// Staff (ผู้ดำเนินการ) management + "ใครทำอะไร" activity reports
router.get('/manage-staff',                staffCtrl.requireAdmin, staffCtrl.showManageStaff);
router.post('/api/staff',                  staffCtrl.requireAdmin, staffCtrl.createStaffAccount);
router.delete('/api/staff/:id',            staffCtrl.requireAdmin, staffCtrl.deleteStaffAccount);
router.patch('/api/staff/:id',             staffCtrl.requireAdmin, staffCtrl.editStaffAccount);
router.patch('/api/staff/:id/password',    staffCtrl.requireAdmin, staffCtrl.changeStaffPassword);
router.patch('/api/staff/:id/role',        staffCtrl.requireAdmin, staffCtrl.changeStaffRole);
router.get('/user-activity',                staffCtrl.showUserActivity);
router.get('/user-activity/:staffId',       staffCtrl.showUserActivityDetail);

// Templates — accept JSON body (images already uploaded via /api/upload-images)
router.get('/api/templates',        ctrl.getTemplates);
router.post('/api/templates',       ctrl.createTemplate);
router.put('/api/templates/:id',    ctrl.updateTemplate);
router.delete('/api/templates/:id', ctrl.deleteTemplate);
router.post('/api/templates/bulk-move',   ctrl.bulkMoveTemplates);
router.post('/api/templates/bulk-delete', ctrl.bulkDeleteTemplates);
router.post('/api/templates/reorder',     ctrl.reorderTemplates);

// Cron / Scheduler
router.post('/api/cron/run-scheduled', ctrl.runAllScheduled);

// Posts
router.get('/',               ctrl.showDashboard);
router.post('/send',          upload.array('images', 30), multerErrorHandler, saveUploadedFiles, ctrl.sendPost);
router.get('/result/:id',     ctrl.showResult);
router.get('/api/post/:id/status', ctrl.getPostStatus);
router.get('/history',        ctrl.showHistory);
router.get('/post-queue',     ctrl.showPostQueue);
router.get('/schedule-post',  ctrl.showSchedulePost);
router.get('/page-summary',   ctrl.showPageSummary);
router.get('/group-summary',  agentCtrl.showGroupSummary);
router.delete('/history/:id', ctrl.deletePost);
router.get('/overview',               ctrl.showOverview);
router.get('/group-overview',         agentCtrl.showGroupOverview);
router.get('/api/stats',              ctrl.overviewStats);
router.post('/api/refresh-analytics', ctrl.refreshAnalytics);
router.patch('/posts/:id/reschedule', ctrl.reschedulePost);
router.patch('/api/posts/:id/edit',     ctrl.editPost);
router.post('/api/posts/:id/post-now',  ctrl.postNowPost);
router.post('/api/posts/:id/cancel',    ctrl.cancelPost);
router.get('/api/posts/expired',        ctrl.listExpiredPosts);
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
        const mongoUri   = process.env.MONGODB_URI        || '';
        const supaUrl    = process.env.SUPABASE_URL       || '';
        const supaSvc    = process.env.SUPABASE_SERVICE_KEY || '';
        const supaAnon   = process.env.SUPABASE_ANON_KEY  || '';
        const supaBucket = process.env.SUPABASE_BUCKET    || 'multipost-storage';
        const webUrl     = `${req.protocol}://${req.get('host')}`;
        const envContent = [
            `MONGODB_URI=${mongoUri}`,
            `WEB_URL=${webUrl}`,
            `SUPABASE_URL=${supaUrl}`,
            `SUPABASE_SERVICE_KEY=${supaSvc}`,
            `SUPABASE_ANON_KEY=${supaAnon}`,
            `SUPABASE_BUCKET=${supaBucket}`,
        ].join('\n') + '\n';
        const zipPath  = path.join(__dirname, '../public/downloads/agent.zip');
        const zip      = new AdmZip(zipPath);
        zip.addFile('desktop-agent/.env', Buffer.from(envContent));
        const buf = zip.toBuffer();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="multipost-agent.zip"');
        res.setHeader('Content-Length', buf.length);
        res.send(buf);
    } catch (e) {
        res.status(500).send('ไม่สามารถสร้างไฟล์ดาวน์โหลดได้');
    }
});

// ── Auto-update endpoints ───────────────────────────────────────────────────

// Returns current version of the desktop-agent so clients can compare
router.get('/api/agent-version', (req, res) => {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../desktop-agent/package.json'), 'utf8'));
        res.json({ version: pkg.version });
    } catch {
        res.status(500).json({ version: '0.0.0' });
    }
});

// Returns source-only zip (no node_modules, no electron binary) for auto-update
// Files have NO prefix — extracted directly into the desktop-agent folder
router.get('/api/agent/source', (req, res) => {
    try {
        const agentDir = path.join(__dirname, '../desktop-agent');
        const sourceFiles = [
            'main.js', 'preload.js', 'package.json',
            'api/server.js',
            'src/accountStore.js', 'src/agentImageStore.js',
            'src/facebookBot.js',  'src/jobRunner.js',
            'src/jobStore.js',     'src/jobTemplateStore.js',
            'src/localGroupStore.js', 'src/supabaseStore.js',
            'src/scheduler/schedulerService.js', 'src/scheduler/statuses.js',
            'renderer/app.js', 'renderer/index.html', 'renderer/style.css',
        ];
        const zip = new AdmZip();
        for (const rel of sourceFiles) {
            const full = path.join(agentDir, rel);
            if (!fs.existsSync(full)) continue;
            const dir = path.dirname(rel);
            zip.addLocalFile(full, dir === '.' ? '' : dir);
        }
        const buf = zip.toBuffer();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="agent-source.zip"');
        res.setHeader('Content-Length', buf.length);
        res.send(buf);
    } catch {
        res.status(500).send('Cannot create source zip');
    }
});

// Page activity (page posts + group shares for one page)
router.get('/page-activity/:pageId', agentCtrl.showPageActivity);

// Agent / Groups / Job Queue / Guide pages
router.get('/guide',         (req, res) => res.render('guide'));
router.get('/agent',         agentCtrl.showAgent);
router.get('/groups',        agentCtrl.showGroups);
router.get('/job-queue',     agentCtrl.showJobQueue);
router.get('/group-history',        agentCtrl.showGroupHistory);
router.get('/group-result/:id',     agentCtrl.showGroupResult);
router.delete('/api/agent/history/:id', agentCtrl.deleteGroupHistoryJob);

// Combined stats API
router.get('/api/stats/combined', agentCtrl.getCombinedStats);

// Group analytics refresh
router.post('/api/agent/refresh-group-analytics', agentCtrl.refreshGroupAnalytics);

// Job Queue API
router.get('/api/agent/jobs',                   agentCtrl.listJobs);
router.post('/api/agent/jobs',                  agentCtrl.createJob);
router.delete('/api/agent/jobs/:id',            agentCtrl.deleteJob);
router.patch('/api/agent/jobs/:id/schedule',    agentCtrl.rescheduleJob);
router.get('/api/agent/jobs/scheduled',         agentCtrl.listScheduledJobs);
router.get('/api/agent/jobs/expired',           agentCtrl.listExpiredJobs);
router.post('/api/agent/jobs/:id/retry',        agentCtrl.retryJob);
router.post('/api/agent/jobs/:id/cancel',       agentCtrl.cancelJob);
router.patch('/api/agent/jobs/:id/edit',        agentCtrl.editJob);
router.post('/api/agent/jobs/:id/post-now',     agentCtrl.postNowJob);

// Schedule Center (unified calendar — page posts + group jobs)
router.get('/schedule-center',          ctrl.showScheduleCenter);
router.get('/api/schedule-center/items', ctrl.scheduleCenterItems);

// Category API
router.post('/api/agent/categories',              agentCtrl.addCategory);
router.delete('/api/agent/categories/:id',        agentCtrl.deleteCategory);
router.patch('/api/agent/categories/:id/color',   agentCtrl.updateCategoryColor);

// Groups API (shared across all users)
router.post('/api/agent/groups',                        agentCtrl.addGroup);
router.delete('/api/agent/groups/:id',                  agentCtrl.deleteGroup);
router.patch('/api/agent/groups/:id/category',          agentCtrl.updateGroupCategory);     // add to category
router.delete('/api/agent/groups/:id/category',         agentCtrl.removeGroupFromCategory); // remove from category
router.post('/api/agent/groups/rename-category',        agentCtrl.bulkRenameCategory);
router.patch('/api/agent/groups/:id/privacy',           agentCtrl.setGroupPrivacy);

module.exports = router;
