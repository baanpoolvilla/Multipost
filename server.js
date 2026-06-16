const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const IS_VERCEL = !!process.env.VERCEL;

// Ensure writable dirs exist
const dirs = IS_VERCEL
    ? ['/tmp']
    : [path.join(__dirname, 'public/uploads'), path.join(__dirname, 'data'), path.join(__dirname, 'logs')];
dirs.forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

const postsPath = IS_VERCEL ? '/tmp/posts.json' : path.join(__dirname, 'data/posts.json');
if (!fs.existsSync(postsPath)) fs.writeFileSync(postsPath, '[]', 'utf-8');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Routes before static — /uploads/:filename is served from MongoDB (persistent on Vercel)
app.use('/', require('./routes/postRoutes'));
app.use(express.static(path.join(__dirname, 'public')));

// Part 9: catch up on expiry on every Web startup (local) / cold start
// (Vercel) — before anything else gets a chance to read the queue. Fire
// and forget so it never blocks server boot or a cold-start request; the
// same sweep also runs at the top of the schedule-related routes
// themselves, so a slow/failed run here just means it catches up shortly after.
Promise.all([
    require('./services/groupJobStore').migrateLegacyStatuses(),
    require('./services/groupJobStore').expireOverdueJobs(),
    require('./services/postStore').migrateLegacyStatuses(),
    require('./services/postStore').expireOverdueScheduled(),
]).catch(() => {});

module.exports = app;
if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
