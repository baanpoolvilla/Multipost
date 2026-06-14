const { createClient } = require('@supabase/supabase-js');

const BUCKET = process.env.SUPABASE_BUCKET || 'multipost-storage';

let _client = null;
function _getClient() {
    if (!_client) {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
            throw new Error('Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY in env');
        _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
        });
    }
    return _client;
}

function publicUrl(filename) {
    if (!filename) return null;
    if (filename.startsWith('http')) return filename;
    return `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
}

function _extractPath(urlOrName) {
    if (!urlOrName.startsWith('http')) return urlOrName;
    const marker = `/object/public/${BUCKET}/`;
    const idx    = urlOrName.indexOf(marker);
    return idx !== -1 ? decodeURIComponent(urlOrName.slice(idx + marker.length)) : urlOrName.split('/').pop();
}

async function upload(filename, buffer, contentType) {
    const supa = _getClient();
    const { error } = await supa.storage.from(BUCKET).upload(filename, buffer, {
        contentType, upsert: true,
    });
    if (error) throw new Error(`Supabase upload failed: ${error.message}`);
    return publicUrl(filename);
}

// Generate a signed upload URL — browser uploads directly to Supabase, no auth needed
async function createSignedUploadUrl(ext) {
    const supa  = _getClient();
    const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext || ''}`;
    const { data, error } = await supa.storage.from(BUCKET).createSignedUploadUrl(fname);
    if (error) throw new Error(`Supabase sign failed: ${error.message}`);
    return { signedUrl: data.signedUrl, publicUrl: publicUrl(fname) };
}

async function remove(urlOrName) {
    if (!urlOrName) return;
    const supa = _getClient();
    const name = _extractPath(urlOrName);
    await supa.storage.from(BUCKET).remove([name]).catch(() => {});
}

module.exports = { upload, publicUrl, createSignedUploadUrl, remove, BUCKET };
