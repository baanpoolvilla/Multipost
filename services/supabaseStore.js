const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const BUCKET       = process.env.SUPABASE_BUCKET || 'multipost-storage';

function publicUrl(filename) {
    if (!filename) return null;
    if (filename.startsWith('http')) return filename;
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
}

// Extract relative path from a Supabase public URL
function _extractPath(urlOrName) {
    if (!urlOrName.startsWith('http')) return urlOrName;
    const marker = `/object/public/${BUCKET}/`;
    const idx    = urlOrName.indexOf(marker);
    return idx !== -1 ? decodeURIComponent(urlOrName.slice(idx + marker.length)) : urlOrName.split('/').pop();
}

async function upload(filename, buffer, contentType) {
    if (!SUPABASE_URL || !SERVICE_KEY)
        throw new Error('Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY in env');
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filename}`, {
        method:  'POST',
        headers: {
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type':  contentType || 'application/octet-stream',
            'x-upsert':      'true',
        },
        body: buffer,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Supabase upload failed (${res.status}): ${text}`);
    }
    return publicUrl(filename);
}

async function remove(urlOrName) {
    if (!SUPABASE_URL || !SERVICE_KEY) return;
    try {
        const name = _extractPath(urlOrName);
        await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
            method:  'DELETE',
            headers: {
                'Authorization': `Bearer ${SERVICE_KEY}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({ prefixes: [name] }),
        });
    } catch {}
}

module.exports = { upload, publicUrl, remove, BUCKET, SUPABASE_URL };
