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
        await page.waitForTimeout(1500);

        // Dismiss cookie/consent popup before attempting to fill the form
        try {
            const consent = page.locator('[data-cookiebanner="accept_button"], [title="Allow all cookies"], [aria-label="Allow all cookies"], button:has-text("Allow all cookies"), button:has-text("ยอมรับ"), button:has-text("ยืนยัน")').first();
            if (await consent.isVisible({ timeout: 3000 })) {
                await consent.click();
                await page.waitForTimeout(700);
            }
        } catch {}

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

        // Wait for form fields to be ready before filling
        try {
            await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
        } catch {
            await page.close();
            return { ok: false, error: 'หน้า Login ไม่โหลด (Facebook ตอบช้า) — ลองกดเข้าสู่ระบบอีกครั้ง' };
        }

        log('กรอก Email/Password...');
        await page.click('#email');
        await page.fill('#email', account.email);
        await page.click('#pass');
        await page.fill('#pass',  account.password);
        await page.click('[name="login"]');
        log('รอผล Login...');

        // Increased timeout to 90s — handles slow connections + security checks
        try {
            await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 90000 });
        } catch {
            // Timeout — check current URL before declaring failure
            const cur = page.url();
            if (_isLoggedIn(cur)) {
                await page.close();
                log('Login สำเร็จ ✓');
                return { ok: true, message: 'Login สำเร็จ ✓' };
            }
            if (_is2FA(cur)) {
                const ok = await _wait2FA(page, log);
                await page.close();
                if (ok) log('Login สำเร็จ ✓');
                return ok ? { ok: true, message: 'Login สำเร็จ ✓' } : { ok: false, error: 'หมดเวลายืนยัน 2FA' };
            }
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
            const menuWords = ['การตั้งค่า','ความเป็นส่วนตัว','ความช่วยเหลือ','รายงาน','การแสดงผล',
                               'ออกจากระบบ','เพิ่มเติม','Settings','Privacy','Help','Support',
                               'Report','Display','Log out','Logout','More','Accessibility',
                               'ดูโปรไฟล์ทั้งหมด','View all profiles','View all'];
            const fromSwitcher = await fb.evaluate((mw) => {
                const res = []; const seen = new Set();
                // Only look in the TOP-RIGHT area where the account menu popup appears
                const W = window.innerWidth;
                const containers = [...document.querySelectorAll('[role="menu"],[role="dialog"],[role="list"],[role="listbox"]')]
                    .filter(c => {
                        const br = c.getBoundingClientRect();
                        // Must be in top-right portion of screen (account menu location)
                        return br.x > W * 0.35 && br.y < 400 && br.height < 700 && br.width > 50;
                    });
                for (const c of containers) {
                    for (const item of c.querySelectorAll('[role="menuitem"],[role="option"],[role="listitem"],li')) {
                        // Must have an avatar image — Pages/profiles have icons, notifications don't
                        const hasAvatar = !!item.querySelector('img,image,svg[role="img"],svg[aria-label],[role="img"]');
                        if (!hasAvatar) continue;
                        const name = [...item.querySelectorAll('span')]
                            .map(s => s.textContent?.trim())
                            .find(t => t && t.length >= 2 && t.length <= 60);
                        if (!name || seen.has(name)) continue;
                        if (mw.some(w => name.toLowerCase().includes(w.toLowerCase()))) continue;
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
        // 1. Exact aria-label match
        const exact = ['Switch profiles','Switch Profile','สลับโปรไฟล์',
                       'Your profiles','โปรไฟล์ของคุณ','Profiles','โปรไฟล์'];
        for (const lbl of exact) {
            const el = document.querySelector(`[aria-label="${lbl}"], [title="${lbl}"]`);
            if (el) { el.click(); return 'exact:' + lbl; }
        }

        // 2. Partial / contains match
        const kws = ['switch','สลับ','profile','โปรไฟล์','your profile'];
        for (const kw of kws) {
            const el = document.querySelector(`[aria-label*="${kw}" i], [title*="${kw}" i]`);
            if (el) { el.click(); return 'partial:' + kw; }
        }

        // 3. Button in top-right of page that has an <img> (profile picture)
        const rightImgBtns = [...document.querySelectorAll('[role="button"]')].filter(btn => {
            const br = btn.getBoundingClientRect();
            return br.x > window.innerWidth * 0.6 && br.y < 80 && btn.querySelector('img');
        });
        rightImgBtns.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
        if (rightImgBtns.length) { rightImgBtns[0].click(); return 'img-btn'; }

        // 4. Any small button in top-right area (last resort)
        const topRight = [...document.querySelectorAll('[role="button"]')].filter(btn => {
            const br = btn.getBoundingClientRect();
            return br.x > window.innerWidth * 0.75 && br.y < 80 && br.width < 80 && br.height < 80;
        });
        topRight.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
        if (topRight.length) { topRight[0].click(); return 'top-right'; }

        // Return all found aria-labels for debugging
        const allLabels = [...document.querySelectorAll('[aria-label]')]
            .map(el => el.getAttribute('aria-label')).filter(Boolean).slice(0, 30);
        return '__notfound__:' + allLabels.join('|');
    });
}

// pickName = string → click that profile/page; null → click first valid item (personal)
async function _navPickIdentity(page, pickName, menuWords) {
    return page.evaluate(({ name, mw }) => {
        const lower = name ? name.toLowerCase() : null;

        function getCleanText(el) {
            // Get shortest non-empty span text inside (less likely to contain menu garbage)
            const spans = [...el.querySelectorAll('span')].map(s => (s.textContent||'').trim()).filter(Boolean);
            spans.sort((a,b) => a.length - b.length);
            return spans[0] || (el.textContent||'').trim();
        }

        const containers = [...document.querySelectorAll('[role="menu"],[role="dialog"],[role="list"],[role="listbox"]')];
        containers.reverse();
        for (const c of containers) {
            // try menuitem/option/listitem first, then role=button inside container
            let items = [...c.querySelectorAll('[role="menuitem"],[role="option"],[role="listitem"],li,[role="button"]')]
                .filter(item => {
                    const t = getCleanText(item);
                    return t && t.length >= 2 && t.length <= 80 && !mw.some(w => t.toLowerCase().includes(w.toLowerCase()));
                });
            if (!items.length) continue;
            if (!lower) { items[0].click(); return 'first:' + getCleanText(items[0]); }
            const target = items.find(item => getCleanText(item).toLowerCase().includes(lower));
            if (target) { target.click(); return 'found:' + name; }
        }
        // last resort: any button anywhere on page whose shortest span matches
        const allBtns = [...document.querySelectorAll('[role="button"]')].filter(btn => {
            const br = btn.getBoundingClientRect();
            return br.width > 0 && br.height > 0;
        });
        if (lower) {
            const target = allBtns.find(btn => {
                const t = getCleanText(btn);
                return t && t.toLowerCase().includes(lower) && !mw.some(w => t.toLowerCase().includes(w.toLowerCase()));
            });
            if (target) { target.click(); return 'global:' + name; }
        }
        return null;
    }, { name: pickName, mw: menuWords });
}

// ── Open a page and switch to Page identity on it ────────────────
// Returns { page, pageId } — pageId is used to navigate group as the Page
async function openSwitchedPage(accountId, pageName, onLog) {
    const log = m => onLog?.(m);
    log(`🔄 สลับโปรไฟล์เป็น "${pageName}"...`);
    try {
        const ctx  = await _getContext(accountId);
        const page = await ctx.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);

        // Open account menu
        const btnFound = await _navOpenSwitcher(page);
        log(`   🔍 menu: ${btnFound || 'null'}`);
        if (!btnFound || btnFound.startsWith('__notfound__')) {
            log('⚠️ ไม่พบปุ่ม menu');
            return { page, pageId: null, personalName: null };
        }
        await page.waitForTimeout(1500);

        // Use Playwright native click (fires real mouse events, not JS click)
        let clicked = false;
        try {
            // Prefer clicking the menuitem/button ancestor that CONTAINS the text
            // getByText finds the deepest span which is often "not visible" to Playwright
            const roleLoc = page.locator('[role="menuitem"],[role="option"],[role="button"],li')
                .filter({ hasText: new RegExp(`^${pageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
                .first();
            if (await roleLoc.count() > 0) {
                await roleLoc.click({ timeout: 3000 });
                clicked = true;
                log(`   ✅ role click: ${pageName}`);
            }
        } catch(e) { log(`   ⚠️ role click err: ${e.message}`); }

        if (!clicked) {
            // Fallback: force-click the text locator (bypasses visibility check)
            try {
                const loc = page.getByText(pageName, { exact: true }).first();
                if (await loc.count() > 0) {
                    await loc.click({ timeout: 3000, force: true });
                    clicked = true;
                    log(`   ✅ force click: ${pageName}`);
                }
            } catch(e) { log(`   ⚠️ force click err: ${e.message}`); }
        }

        if (!clicked) {
            // Last resort: JS evaluate click
            const picked = await _navPickIdentity(page, pageName, _MENU_WORDS);
            clicked = !!picked;
            log(`   evaluate: ${picked || 'failed'}`);
        }

        if (!clicked) { return { page, pageId: null }; }

        // Wait for navigation to wherever Facebook takes us after clicking the Page
        try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }); } catch {}
        await page.waitForTimeout(2000);
        const landedUrl = page.url();
        log(`   🔍 landed: ${landedUrl.slice(0, 80)}`);

        // Extract Page ID from the URL (numeric id or entity_id in URL)
        let pageId = null;
        const idMatch = landedUrl.match(/\/(\d{10,20})\/?/) || landedUrl.match(/[?&]id=(\d{10,20})/);
        if (idMatch) { pageId = idMatch[1]; log(`   🔍 pageId: ${pageId}`); }

        // Also try og:url / page meta for numeric ID
        if (!pageId) {
            pageId = await page.evaluate(() => {
                const og = document.querySelector('meta[property="al:android:url"]')?.content
                        || document.querySelector('meta[property="fb:page_id"]')?.content;
                if (og) { const m = og.match(/\d{10,20}/); return m ? m[0] : null; }
                // Check URL params in any link that has page_id
                for (const a of document.querySelectorAll('a[href*="page_id="]')) {
                    const m = (a.href||'').match(/page_id=(\d+)/);
                    if (m) return m[1];
                }
                return null;
            }).catch(()=>null);
            if (pageId) log(`   🔍 pageId (meta): ${pageId}`);
        }

        // Try to click "Use Facebook as [Page]" button if present
        const switchTerms = ['use facebook as','สลับเป็น','ใช้ facebook','switch to','switch profile'];
        for (const term of switchTerms) {
            try {
                const btn = page.getByText(term, { exact: false }).first();
                if (await btn.count() > 0) {
                    await btn.click({ timeout: 2000 });
                    log(`   ✅ switch btn: "${term}"`);
                    try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }); } catch {}
                    await page.waitForTimeout(1500);
                    break;
                }
            } catch {}
        }

        log(`✅ สลับเป็น: ${pageName}${pageId ? ` (id:${pageId})` : ''}`);
        return { page, pageId };
    } catch(e) {
        log(`❌ openSwitchedPage: ${e.message}`);
        return { page: null, pageId: null };
    }
}

// ── Switch back to personal on an existing page, then close it ────
// currentPageName: the Page we're currently browsing as — skip it in the switcher
async function switchBackOnPage(page, onLog, currentPageName = null) {
    const log = m => onLog?.(m);
    try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
        const btnFound = await _navOpenSwitcher(page);
        if (btnFound && !btnFound.startsWith('__notfound__')) {
            await page.waitForTimeout(1500);
            // Pick the first item that does NOT match the current Page name
            const switched = await page.evaluate(({ skipName, mw }) => {
                function getCleanText(el) {
                    const spans = [...el.querySelectorAll('span')].map(s=>(s.textContent||'').trim()).filter(Boolean);
                    spans.sort((a,b)=>a.length-b.length);
                    return spans[0]||(el.textContent||'').trim();
                }
                const skipLower = skipName ? skipName.toLowerCase() : null;
                const containers = [...document.querySelectorAll('[role="menu"],[role="dialog"],[role="list"],[role="listbox"]')];
                containers.reverse();
                for (const c of containers) {
                    const items = [...c.querySelectorAll('[role="menuitem"],[role="option"],[role="listitem"],li,[role="button"]')]
                        .filter(i => {
                            const t = getCleanText(i);
                            return t && t.length >= 2 && t.length <= 80
                                && !mw.some(w => t.toLowerCase().includes(w.toLowerCase()));
                        });
                    if (!items.length) continue;
                    // Skip the current page, pick the first OTHER item
                    const target = skipLower
                        ? items.find(i => !getCleanText(i).toLowerCase().includes(skipLower))
                        : items[0];
                    if (target) { target.click(); return getCleanText(target); }
                }
                return null;
            }, { skipName: currentPageName, mw: _MENU_WORDS });
            log(`   switched to: ${switched || 'unknown'}`);
            try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }); } catch {}
            await page.waitForTimeout(1500);
        }
        await page.close();
        log('🔄 สลับกลับเป็น personal account');
    } catch(e) {
        log?.(`⚠️ switchBack: ${e.message}`);
        try { await page.close(); } catch {}
    }
}

// ── Try to switch identity inside the group composer dialog ──────
async function _tryDialogIdentitySwitch(page, pageName) {
    try {
        // Step 1: click the profile/identity area in dialog top (opens switcher popup)
        const clickResult = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return null;
            const dRect = dialog.getBoundingClientRect();
            const topBtns = [...dialog.querySelectorAll('[role="button"]')].filter(btn => {
                const br = btn.getBoundingClientRect();
                return br.width > 40 && br.height > 20
                    && br.y > dRect.y && br.y < dRect.y + 130;
            });
            if (!topBtns.length) return null;
            const candidate = topBtns.find(b => b.querySelector('img,image,[role="img"]'))
                           || topBtns.find(b => b.offsetWidth > 60)
                           || topBtns[0];
            candidate.click();
            return (candidate.textContent || '').trim().slice(0, 40) || 'clicked';
        });
        if (!clickResult) return null;

        // Step 2: wait for switcher popup to appear
        await page.waitForTimeout(2500);

        // Step 3: try Playwright locator — more reliable than evaluate for dynamic popups
        const lower = pageName.toLowerCase();
        // Scan all visible popup/menu/list containers for the page name
        const allMenuItems = page.locator('[role="menu"] [role="menuitem"], [role="listbox"] [role="option"], [role="menu"] [role="button"], [role="list"] li');
        const count = await allMenuItems.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
            try {
                const item = allMenuItems.nth(i);
                const txt = (await item.textContent({ timeout: 500 }).catch(() => '')) || '';
                if (txt.toLowerCase().includes(lower) && !_MENU_WORDS.some(w => txt.toLowerCase().includes(w.toLowerCase()))) {
                    await item.click({ timeout: 3000 });
                    await page.waitForTimeout(1000);
                    return 'locator:' + pageName;
                }
            } catch {}
        }

        // Step 4: fallback — evaluate global scan
        const picked = await _navPickIdentity(page, pageName, _MENU_WORDS);
        if (picked) { await page.waitForTimeout(1000); return picked; }

        // Save debug screenshot if nothing worked
        await page.screenshot({ path: path.join(_userDataBase, 'debug-dialog-switch.png') }).catch(()=>{});
        return null;
    } catch { return null; }
}

// ── Post to group ─────────────────────────────────────────────
// sharedPage: if provided, use this already-switched page (don't open a new one, don't close it)
// pageId: if provided, append ?profile_id=PAGE_ID to group URL to force Page context
// images: array of absolute file paths to attach as photos
async function postToGroup(accountId, groupId, groupName, message, postAsPage, onLog, sharedPage = null, pageId = null, images = []) {
    const log = m => onLog?.(m);
    try {
        const ctx  = await _getContext(accountId);
        const page = sharedPage || await ctx.newPage();
        const ownPage = !sharedPage;

        const groupUrl = pageId
            ? `https://www.facebook.com/groups/${groupId}?profile_id=${pageId}`
            : `https://www.facebook.com/groups/${groupId}`;
        log(`🌐 เปิดกลุ่ม ${groupName}...${pageId ? ` [as Page ${pageId}]` : ''}`);
        await page.goto(groupUrl, {
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
            if (ownPage) await page.close();
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
        if (!textbox) { if (ownPage) await page.close(); return { ok: false, error: 'Dialog โพสต์ไม่เปิด — ลองใหม่' }; }

        await textbox.click();
        await page.waitForTimeout(500);

        // Attach photos/videos if any
        if (images && images.length > 0) {
            log(`📷 แนบรูปภาพ ${images.length} รูป...`);
            try {
                // Facebook's file input is usually hidden; setInputFiles works on hidden inputs
                let fileInput = await page.$('[role="dialog"] input[type="file"]');
                if (!fileInput) {
                    // Click Photo/Video button to expose the file input
                    const photoBtn = await page.$('[role="dialog"] [aria-label*="Photo"],[role="dialog"] [aria-label*="รูปภาพ"],[role="dialog"] [aria-label*="photo"]');
                    if (photoBtn) { await photoBtn.click(); await page.waitForTimeout(1200); }
                    fileInput = await page.$('input[type="file"]');
                }
                if (fileInput) {
                    await fileInput.setInputFiles(images);
                    log(`   ✅ แนบรูปสำเร็จ`);
                    await page.waitForTimeout(4000);
                } else {
                    log('   ⚠️ ไม่พบ file input — ข้ามการแนบรูป');
                }
            } catch(imgErr) { log(`   ⚠️ แนบรูปล้มเหลว: ${imgErr.message}`); }
        }

        // If postAsPage, try to switch identity inside the dialog (before typing)
        if (postAsPage) {
            log(`   🏢 สลับ identity ใน dialog → "${postAsPage}"...`);
            const ds = await _tryDialogIdentitySwitch(page, postAsPage);
            log(`   dialog switch: ${ds || 'ไม่มีตัวเลือก — โพสเป็น user ปกติ'}`);
            if (ds) {
                // Re-find textbox after identity switch (dialog may have re-rendered)
                let newTb = null;
                for (const s of tbSels) {
                    try { newTb = await page.waitForSelector(s, { timeout: 4000, state:'visible' }); if (newTb) break; } catch {}
                }
                if (newTb) { textbox = newTb; await textbox.click(); await page.waitForTimeout(500); }
            }
        }

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
        if (!posted) { if (ownPage) await page.close(); return { ok: false, error: 'กด Post ไม่ได้' }; }

        await page.waitForTimeout(4000);
        if (ownPage) await page.close();
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

module.exports = { init, loginAccount, postToGroup, getAccountPages, openSwitchedPage, switchBackOnPage, closeContext, closeAll };
