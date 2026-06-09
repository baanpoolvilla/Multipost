const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const ctrl    = require('../controllers/postController');

const UPLOADS_DIR = process.env.VERCEL ? '/tmp/uploads' : path.join(__dirname, '../public/uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try { require('fs').mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /\.(jpe?g|png|gif|webp)$/i.test(file.originalname)),
});

// Posts
router.get('/',               ctrl.showDashboard);
router.post('/send',          upload.array('images', 10), ctrl.sendPost);
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

module.exports = router;
