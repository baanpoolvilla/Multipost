const fs   = require('fs');
const path = require('path');

let _file = '';

function init(userDataDir) {
    _file = path.join(userDataDir, 'local-groups.json');
}

function list() {
    try { return JSON.parse(fs.readFileSync(_file, 'utf-8')); } catch { return []; }
}

function add(groupId, groupName) {
    const groups = list();
    if (groups.find(g => g.groupId === groupId)) return { error: 'Group ID ซ้ำ' };
    const entry = { id: Date.now().toString(), groupId, groupName };
    groups.push(entry);
    fs.writeFileSync(_file, JSON.stringify(groups, null, 2));
    return groups;
}

function remove(id) {
    const groups = list().filter(g => g.id !== id);
    fs.writeFileSync(_file, JSON.stringify(groups, null, 2));
    return groups;
}

module.exports = { init, list, add, remove };
