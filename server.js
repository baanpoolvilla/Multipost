const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

// Ensure required directories and files exist
const ensure = [
    path.join(__dirname, 'public/uploads'),
    path.join(__dirname, 'data'),
    path.join(__dirname, 'logs'),
];
ensure.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const postsPath = path.join(__dirname, 'data/posts.json');
if (!fs.existsSync(postsPath)) fs.writeFileSync(postsPath, '[]', 'utf-8');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', require('./routes/postRoutes'));

const PORT = 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
