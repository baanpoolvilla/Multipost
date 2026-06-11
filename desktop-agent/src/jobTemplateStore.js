const fs   = require('fs');
const path = require('path');

let _file = '';

function init(userDataDir) {
    _file = path.join(userDataDir, 'job-templates.json');
}

function list() {
    try { return JSON.parse(fs.readFileSync(_file, 'utf-8')); } catch { return []; }
}

function save({ id, name, message, groups, delaySeconds, images, postAsPage }) {
    const templates = list();
    const tpl = { id: id || Date.now().toString(), name, message, groups, delaySeconds, images: images || [], postAsPage: postAsPage || null };
    const idx = templates.findIndex(t => t.id === tpl.id);
    if (idx !== -1) templates[idx] = tpl; else templates.push(tpl);
    fs.writeFileSync(_file, JSON.stringify(templates, null, 2));
    return templates;
}

function remove(id) {
    const templates = list().filter(t => t.id !== id);
    fs.writeFileSync(_file, JSON.stringify(templates, null, 2));
    return templates;
}

module.exports = { init, list, save, remove };
