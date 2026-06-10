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

// ── Get Pages managed by an account ──────────────────────────
async function getAccountPages(accountId) {
    try {
        const ctx  = await _getContext(accountId);
        const fb   = await ctx.newPage();

        await fb.goto('https://www.facebook.com/', {
            waitUntil: 'domcontentloaded', timeout: 20000,
        });
        if (fb.url().includes('/login')) { await fb.close(); return []; }
        await fb.waitForTimeout(2500);

        // ── Strategy 1: click profile/identity switcher on home ──
        const clicked = await fb.evaluate(() => {
            const labels = [
                'Switch profiles', 'Switch Profile', 'สลับโปรไฟล์',
                'Your profiles', 'โปรไฟล์ของคุณ', 'Profiles', 'โปรไฟล์',
            ];
            for (const lbl of labels) {
                const el = document.querySelector(`[aria-label="${lbl}"], [title="${lbl}"]`);
                if (el) { el.click(); return lbl; }
            }
            return null;
        });

        if (clicked) {
            await fb.waitForTimeout(2000);
            // Filter out Facebook account-menu items (settings, logout, etc.)
            const menuWords = ['การตั้งค่า','ความเป็นส่วนตัว','ความช่วยเหลือ','รายงาน','การแสดงผล',
                               'ออกจากระบบ','เพิ่มเติม','Settings','Privacy','Help','Support',
                               'Report','Display','Log out','Logout','More','Accessibility'];
            const fromSwitcher = await fb.evaluate((mw) => {
                const res = []; const seen = new Set();
                for (const c of document.querySelectorAll('[role="menu"],[role="dialog"],[role="list"],[role="listbox"]')) {
                    for (const item of c.querySelectorAll('[role="menuitem"],[role="option"],[role="listitem"],li')) {
                        const name = [...item.querySelectorAll('span')]
                            .map(s => s.textContent?.trim())
                            .find(t => t && t.length >= 2 && t.length <= 60);
                        if (!name || seen.has(name)) continue;
                        if (mw.some(w => name.includes(w))) continue; // skip menu actions
                        seen.add(name); res.push({ name });
                    }
                }
                return res;
            }, menuWords);
            await fb.keyboard.press('Escape');
            if (fromSwitcher.length) { await fb.close(); return fromSwitcher; }
        }

        // ── Strategy 2: facebook.com/pages/ with long wait ───────
        await fb.goto('https://www.facebook.com/pages/', {
            waitUntil: 'domcontentloaded', timeout: 20000,
        });
        await fb.waitForTimeout(5000);

        const fromPages = await fb.evaluate(() => {
            const res = []; const seen = new Set();
            const skip = new Set([
                'Pages', 'เพจ', 'Create new Page', 'สร้างเพจใหม่',
                'Your Pages and profiles', 'เพจและโปรไฟล์ของคุณ',
                'Manage Pages', 'All', 'ทั้งหมด', 'More', 'เพิ่มเติม',
                'See all', 'See more',
            ]);

            // role=heading
            for (const el of document.querySelectorAll('[role="heading"], h1, h2, h3')) {
                const name = el.textContent?.trim();
                if (!name || name.length < 2 || name.length > 80 || skip.has(name) || seen.has(name)) continue;
                seen.add(name); res.push({ name });
            }

            // Fallback: page link text (slug-style hrefs = pages)
            if (!res.length) {
                const NON_PAGE = new Set(['login','groups','pages','watch','marketplace','events',
                    'gaming','bookmarks','settings','notifications','friends','feeds','home',
                    'messages','stories','reels','videos','saved','memories','weather']);
                for (const a of document.querySelectorAll('a[href]')) {
                    const m = (a.getAttribute('href') || '').match(/^\/([a-zA-Z0-9._]{3,60})\/?(?:\?.*)?$/);
                    if (!m || NON_PAGE.has(m[1].toLowerCase())) continue;
                    const name = [...a.querySelectorAll('span')]
                        .map(s => s.textContent?.trim())
                        .find(t => t && t.length >= 2 && t.length <= 80);
                    if (name && !skip.has(name) && !seen.has(name)) { seen.add(name); res.push({ name }); }
                }
            }

            return res.slice(0, 20);
        });

        await fb.close();
        return fromPages;
    } catch(e) { return []; }
}

// ── Navbar profile switcher (shared by switchIdentity / getAccountPages) ──
const _MENU_WORDS = ['การตั้งค่า','ความเป็นส่วนตัว','ความช่วยเหลือ','รายงาน','การแสดงผล',
                     'ออกจากระบบ','เพิ่มเติม','Settings','Privacy','Help','Support',
                     'Report','Display','Log out','Logout','More','Accessibility'];

async function _navOpenSwitcher(page) {
    return page.evaluate(() => {
        const labels = ['Switch profiles','Switch Profile','สลับโปรไฟล์',
                        'Your profiles','โปรไฟล์ของคุณ','Profiles','โปรไฟล์'];
        for (const lbl of labels) {
            const el = document.querySelector(`[aria-label="${lbl}"], [title="${lbl}"]`);
            if (el) { el.click(); return lbl; }
        }
        return null;
    });
}

// pickName = string → click that profile/page; null → click first valid item (personal)
async function _navPickIdentity(page, pickName, menuWords) {
    return page.evaluate(({ name, mw }) => {
        const lower = name ? name.toLowerCase() : null;
        const containers = [...document.querySelectorAll('[role="menu"],[role="dialog"],[role="list"],[role="listbox"]')];
        containers.reverse();
        for (const c of containers) {
            const items = [...c.querySelectorAll('[role="menuitem"],[role="option"],[role="listitem"],li')]
                .filter(item => {
                    const t = (item.textContent || '').trim();
                    return t && t.length >= 2 && t.length <= 60 && !mw.some(w => t.includes(w));
                });
            if (!items.length) continue;
            if (!lower) { items[0].click(); return 'first'; }
            const target = items.find(item => (item.textContent || '').toLowerCase().includes(lower));
            if (target) { target.click(); return name; }
        }
        return null;
    }, { name: pickName, mw: menuWords });
}

// ── Public: switch to a page identity via navbar ───────────────
async function switchIdentity(accountId, pageName, onLog) {
    const log = m => onLog?.(m);
    log(`🔄 สลับโปรไฟล์เป็น "${pageName}"...`);
    try {
        const ctx  = await _getContext(accountId);
        const page = await ctx.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);

        const btnFound = await _navOpenSwitcher(page);
        if (!btnFound) {
            await page.screenshot({ path: path.join(_userDataBase, 'debug-switcher.png') }).catch(()=>{});
            log('⚠️ ไม่พบปุ่ม profile switcher — โพสเป็น user ปกติ');
            await page.close(); return false;
        }
        await page.waitForTimeout(1500);

        const picked = await _navPickIdentity(page, pageName, _MENU_WORDS);
        if (!picked) {
            await page.screenshot({ path: path.join(_userDataBase, 'debug-switcher.png') }).catch(()=>{});
            log(`⚠️ ไม่พบ "${pageName}" ใน switcher — โพสเป็น user ปกติ`);
            await page.close(); return false;
        }

        await page.waitForTimeout(3000); // FB needs time to complete identity switch
        await page.close();
        log(`✅ สลับเป็น: ${pageName}`);
        return true;
    } catch(e) { log(`❌ switchIdentity: ${e.message}`); return false; }
}

// ── Public: switch back to personal account (first item in switcher) ─
async function switchIdentityBack(accountId, onLog) {
    const log = m => onLog?.(m);
    try {
        const ctx  = await _getContext(accountId);
        const page = await ctx.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
        const btnFound = await _navOpenSwitcher(page);
        if (btnFound) {
            await page.waitForTimeout(1500);
            await _navPickIdentity(page, null, _MENU_WORDS); // null = first = personal
            await page.waitForTimeout(2000);
        }
        await page.close();
        log('🔄 สลับกลับเป็น personal account');
    } catch(e) { log?.(`⚠️ switchIdentityBack: ${e.message}`); }
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

module.exports = { init, loginAccount, postToGroup, getAccountPages, switchIdentity, switchIdentityBack, closeContext, closeAll };
