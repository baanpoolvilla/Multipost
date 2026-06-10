const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

let _userDataBase = '';
const _contexts  = {};

function init(userDataDir) {
    _userDataBase = userDataDir;
}

function _ctxDir(accountId) {
    return path.join(_userDataBase, `fb-ctx-${accountId}`);
}

async function _launchContext(accountId) {
    const dir = _ctxDir(accountId);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dir, {
        headless: false,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled', '--foreground', '--no-first-run'],
    });
    _contexts[accountId] = ctx;
    return ctx;
}

// Returns a live context — recreates automatically if the browser process died
async function _getContext(accountId) {
    if (_contexts[accountId]) {
        try {
            // newPage() is the real liveness test — .pages() lies on dead contexts
            const probe = await _contexts[accountId].newPage();
            await probe.close();
            return _contexts[accountId];
        } catch {
            try { await _contexts[accountId].close(); } catch {}
            delete _contexts[accountId];
        }
    }
    return _launchContext(accountId);
}

function _is2FA(url) {
    return url.includes('/two_step') || url.includes('two_factor') ||
           url.includes('/checkpoint') || url.includes('device-based');
}
function _isLoggedIn(url) {
    return !url.includes('/login') && !_is2FA(url);
}

async function _wait2FA(page, log) {
    log('⚠️ ต้องยืนยัน 2FA — ทำในหน้าต่าง Chromium ที่เปิดอยู่...');
    try {
        await page.waitForFunction(
            () => !location.href.includes('/checkpoint') && !location.href.includes('/two_step') &&
                  !location.href.includes('two_factor') && !location.href.includes('/login'),
            { timeout: 300000, polling: 1500 }
        );
        return true;
    } catch { return false; }
}

// ── Login ─────────────────────────────────────────────────────
async function loginAccount(account, onLog) {
    const log = m => onLog?.(m);
    try {
        log('เปิด Browser...');
        await closeContext(account.id);
        const ctx  = await _launchContext(account.id);
        const page = await ctx.newPage();
        await page.bringToFront();

        log('เปิด Facebook...');
        await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.bringToFront();
        await page.waitForTimeout(2000);

        const urlAfterGoto = page.url();

        if (_isLoggedIn(urlAfterGoto)) {
            await page.close();
            log('Login สำเร็จ ✓ (session เดิมยังใช้ได้)');
            return { ok: true, message: 'Login สำเร็จ ✓' };
        }

        if (_is2FA(urlAfterGoto)) {
            const ok = await _wait2FA(page, log);
            await page.close();
            if (ok) log('Login สำเร็จ ✓');
            return ok ? { ok: true, message: 'Login สำเร็จ ✓' } : { ok: false, error: 'หมดเวลายืนยัน 2FA' };
        }

        log('กรอก Email/Password...');
        await page.fill('#email', account.email);
        await page.fill('#pass',  account.password);
        await page.click('[name="login"]');
        log('รอผล Login...');

        try {
            await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 25000 });
        } catch {
            await page.close();
            return { ok: false, error: 'Email หรือ Password ไม่ถูกต้อง' };
        }

        if (_is2FA(page.url())) {
            const ok = await _wait2FA(page, log);
            await page.close();
            if (ok) log('Login สำเร็จ ✓');
            return ok ? { ok: true, message: 'Login สำเร็จ ✓' } : { ok: false, error: 'หมดเวลายืนยัน 2FA' };
        }

        const loggedIn = _isLoggedIn(page.url());
        await page.close();
        if (loggedIn) log('Login สำเร็จ ✓');
        return { ok: loggedIn, message: loggedIn ? 'Login สำเร็จ ✓' : 'Login ไม่สำเร็จ' };
    } catch(e) { return { ok: false, error: e.message }; }
}

// ── Switch "Posting as" identity ──────────────────────────────
async function _switchPostingAs(page, pageName, log) {
    if (!pageName) return;
    log(`🔄 สลับโพสในนาม "${pageName}"...`);

    // Step 1: click the identity switcher inside the composer dialog
    const clicked = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return null;

        // Primary: aria-label contains "Posting as" / "โพสต์ในฐานะ"
        const byAria = dialog.querySelector('[aria-label*="Posting as"], [aria-label*="โพสต์ในฐานะ"]');
        if (byAria) { byAria.click(); return 'aria-label'; }

        // Secondary: button in the lower half of the dialog (below textbox area)
        const dRect  = dialog.getBoundingClientRect();
        const midY   = dRect.top + dRect.height * 0.55;
        const ignore = /photo|video|emoji|feeling|location|tag|gif|poll|event|live|watch|sticker/i;
        for (const btn of dialog.querySelectorAll('[role="button"]')) {
            const br = btn.getBoundingClientRect();
            if (br.top < midY) continue;
            const al = btn.getAttribute('aria-label') || '';
            if (ignore.test(al)) continue;
            if (br.width > 40 && br.height > 20) { btn.click(); return 'lower-button'; }
        }
        return null;
    });

    if (!clicked) { log('⚠️ ไม่พบปุ่มสลับ identity — โพสในนาม user ปกติ'); return; }
    await page.waitForTimeout(1500);

    // Step 2: pick the matching page from the popup list
    const found = await page.evaluate((name) => {
        const lower = name.toLowerCase();
        const containers = [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [role="list"]')];
        containers.reverse(); // newest (topmost) first
        for (const c of containers) {
            for (const item of c.querySelectorAll('[role="menuitem"], [role="option"], [role="button"], [role="listitem"], li')) {
                if ((item.textContent || '').toLowerCase().includes(lower)) { item.click(); return true; }
            }
        }
        // Fallback: scan all visible buttons
        for (const btn of document.querySelectorAll('[role="button"]')) {
            if ((btn.textContent || '').toLowerCase().includes(lower)) { btn.click(); return true; }
        }
        return false;
    }, pageName);

    if (!found) { log(`⚠️ ไม่พบ Page "${pageName}" — โพสในนาม user ปกติ`); return; }
    await page.waitForTimeout(1000);
    log(`✅ สลับเป็น: ${pageName}`);
}

// ── Post to group ─────────────────────────────────────────────
async function postToGroup(accountId, groupId, groupName, message, postAsPage, onLog) {
    const log = m => onLog?.(m);
    try {
        const ctx  = await _getContext(accountId);
        const page = await ctx.newPage();

        log(`🌐 เปิดกลุ่ม ${groupName}...`);
        await page.goto(`https://www.facebook.com/groups/${groupId}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });

        if (page.url().includes('/login')) {
            await page.close();
            return { ok: false, error: 'Session หมดอายุ — Login ใหม่' };
        }

        // Wait for page to fully load
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // Dismiss setup/onboarding panel (the "ตั้งค่ากลุ่ม" side panel)
        try { await page.keyboard.press('Escape'); await page.waitForTimeout(300); } catch {}
        try {
            const closeBtns = await page.$$('[aria-label="ปิด"], [aria-label="Close"], [data-testid="dialog_title_close_button"]');
            for (const btn of closeBtns) { try { await btn.click(); break; } catch {} }
        } catch {}
        // Click "ภายหลัง" / "Not Now" / "ข้าม" buttons on setup panels
        try {
            const allBtns = await page.$$('[role="button"]');
            for (const btn of allBtns) {
                const txt = await btn.textContent().catch(() => '');
                if (/^(ข้าม|ภายหลัง|not now|skip|later)$/i.test(txt.trim())) {
                    await btn.click(); await page.waitForTimeout(400); break;
                }
            }
        } catch {}

        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(1000);
        log('🖱️ คลิกช่องโพสต์...');

        // Use evaluate (runs in browser) — more reliable than CSS selectors for dynamic FB UI
        const clickResult = await page.evaluate(() => {
            // 1. aria-placeholder
            const byPh = document.querySelector('[aria-placeholder*="เขียนอะไร"], [aria-placeholder*="Write something"], [aria-placeholder*="What\'s on your mind"]');
            if (byPh) { byPh.click(); return 'aria-placeholder'; }
            // 2. GroupComposer pagelet
            const pagelet = document.querySelector('[data-pagelet="GroupComposer"]');
            if (pagelet) {
                const inner = pagelet.querySelector('[role="button"], div[tabindex="0"]');
                if (inner) { inner.click(); return 'pagelet-btn'; }
                pagelet.click(); return 'pagelet-direct';
            }
            // 3. aria-label
            for (const lbl of ['สร้างโพสต์สาธารณะ','Create a public post','Write something on this group']) {
                const el = document.querySelector(`[aria-label="${lbl}"]`);
                if (el) { el.click(); return 'aria-label'; }
            }
            // 4. Text content scan (last resort)
            for (const div of document.querySelectorAll('div[role="button"]')) {
                if (div.textContent.includes('เขียนอะไรสักหน่อย') || div.textContent.includes('Write something')) {
                    div.click(); return 'text-scan';
                }
            }
            return null;
        });

        log(`   composer: ${clickResult||'ไม่เจอ'}`);
        if (!clickResult) {
            await page.screenshot({ path: path.join(_userDataBase, `debug-${groupId}.png`), fullPage: false });
            await page.close();
            return { ok: false, error: `หาช่องโพสต์ไม่เจอ (debug-${groupId}.png บันทึกแล้ว)` };
        }

        await page.waitForTimeout(2000);
        log('⌨️ พิมพ์ข้อความ...');

        // Must be inside a dialog (opened by clicking composer) — avoid comment textboxes
        const tbSels = [
            '[role="dialog"] [role="textbox"][contenteditable="true"]',
            '[role="dialog"] div[contenteditable="true"][data-lexical-editor]',
            '[role="dialog"] div[contenteditable="true"]',
        ];
        let textbox = null;
        for (const s of tbSels) {
            try {
                textbox = await page.waitForSelector(s, { timeout: 6000, state: 'visible' });
                if (textbox) break;
            } catch {}
        }
        if (!textbox) { await page.close(); return { ok: false, error: 'Dialog โพสต์ไม่เปิด — ลองใหม่' }; }

        await textbox.click();
        await page.waitForTimeout(500);

        // Switch "Posting as" identity if specified
        await _switchPostingAs(page, postAsPage, log);

        // Support "text|||url" or "|||url" (text-only preview, no link shown)
        if (message.includes('|||')) {
            const sep  = message.indexOf('|||');
            const text = message.slice(0, sep).trim();
            const url  = message.slice(sep + 3).trim();

            log('🔗 สร้าง Link Preview...');
            await page.keyboard.type(url, { delay: 15 });
            await page.waitForTimeout(5000); // wait for Facebook to load link preview card
            // Ctrl+A selects only text content — preview card (attachment node) stays
            await page.keyboard.press('Control+a');
            await page.waitForTimeout(400);
            if (text) {
                log('⌨️ พิมพ์ข้อความ...');
                // Typing replaces the selection (URL) — preview card remains as attachment
                await page.keyboard.type(text, { delay: 25 });
            } else {
                // No text — delete selected URL, preview card stays
                await page.keyboard.press('Delete');
            }
        } else {
            await page.keyboard.type(message, { delay: 30 });
        }

        await page.waitForTimeout(1500);

        log('📤 กด Post...');

        // Post button inside the dialog only
        const postSels = [
            '[role="dialog"] div[aria-label="Post"][role="button"]:not([aria-disabled="true"])',
            '[role="dialog"] div[aria-label="โพสต์"][role="button"]:not([aria-disabled="true"])',
            '[role="dialog"] div[aria-label="Post"][role="button"]',
            '[role="dialog"] div[aria-label="โพสต์"][role="button"]',
        ];
        let posted = false;
        for (const s of postSels) {
            try {
                const el = await page.waitForSelector(s, { timeout: 5000, state: 'visible' });
                if (el) { await el.click(); posted = true; break; }
            } catch {}
        }
        if (!posted) {
            // Last resort: find Post/โพสต์ button inside any open dialog
            try {
                const btn = page.locator('[role="dialog"]').getByRole('button', { name: /^Post$|^โพสต์$/ }).last();
                if (await btn.count() > 0) { await btn.click(); posted = true; }
            } catch {}
        }
        if (!posted) { await page.close(); return { ok: false, error: 'กด Post ไม่ได้' }; }

        await page.waitForTimeout(4000);
        await page.close();
        return { ok: true };
    } catch(e) { return { ok: false, error: e.message }; }
}

async function closeContext(accountId) {
    const ctx = _contexts[accountId];
    if (ctx) { try { await ctx.close(); } catch {} delete _contexts[accountId]; }
}

async function closeAll() {
    for (const id of Object.keys(_contexts)) await closeContext(id);
}

module.exports = { init, loginAccount, postToGroup, closeContext, closeAll };
