require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.json({ limit: '10mb' }));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/', require('./routes/postRoutes'));

// Global error handler — always returns JSON so clients don't get HTML/plain-text errors
app.use((err, req, res, next) => {
    console.error('[server error]', err.status || 500, err.message);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' });
});

const PORT = 3001;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});