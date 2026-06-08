const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const IS_VERCEL = !!process.env.VERCEL;

// Ensure writable dirs exist (use /tmp on Vercel, local paths otherwise)
const dirs = IS_VERCEL
    ? ['/tmp/uploads', '/tmp']
    : [path.join(__dirname, 'public/uploads'), path.join(__dirname, 'data'), path.join(__dirname, 'logs')];
dirs.forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

const postsPath = IS_VERCEL ? '/tmp/posts.json' : path.join(__dirname, 'data/posts.json');
if (!fs.existsSync(postsPath)) fs.writeFileSync(postsPath, '[]', 'utf-8');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// On Vercel, serve uploaded images from /tmp/uploads
if (IS_VERCEL) {
    app.use('/uploads', express.static('/tmp/uploads'));
}

app.use('/', require('./routes/postRoutes'));

module.exports = app;
if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
