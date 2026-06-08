const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const ctrl    = require('../controllers/postController');

const storage = multer.diskStorage({
    destination: path.join(__dirname, '../public/uploads'),
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
router.get('/overview',       ctrl.showOverview);

// Page management
router.get('/pages',          ctrl.showPages);
router.post('/pages',         ctrl.addPage);
router.put('/pages/:id',      ctrl.updatePage);
router.delete('/pages/:id',   ctrl.deletePage);

module.exports = router;
