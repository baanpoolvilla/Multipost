const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../data/posts.json');

function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); }
    catch { return []; }
}

function save(posts) {
    fs.writeFileSync(FILE, JSON.stringify(posts, null, 2), 'utf-8');
}

function create(data) {
    const posts = load();
    const post = {
        id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
        ...data,
    };
    posts.unshift(post);
    save(posts);
    return post;
}

function getById(id) {
    return load().find(p => p.id === id) || null;
}

function remove(id) {
    const posts = load();
    const post = posts.find(p => p.id === id);
    if (!post) return null;
    save(posts.filter(p => p.id !== id));
    return post;
}

module.exports = { load, create, getById, remove };
