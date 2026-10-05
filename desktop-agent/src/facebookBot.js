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
        // No --foreground: it makes Chrome request focus on essentially
        // every action (new page, navigation), which is what un-minimizes
        // this window on its own mid-job even when nobody touched it --
        // Windows' foreground-lock inconsistently allows/blocks that
        // request depending on machine state, which is why only some
        // machines showed the popping-up behavior with the same code.
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
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
    log('⚠️ ต้องยืนยัน 2FA — ทำในหน้าต่าง Chromium ที่เปิดอยู่ (รอสูงสุด 10 นาที)...');
    try {
        await page.waitForFunction(
            () => !location.href.includes('/checkpoint') && !location.href.includes('/two_step') &&
                  !location.href.includes('two_factor') && !location.href.includes('/login'),
            { timeout: 600000, polling: 1500 }
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
            const loggedInNow = ok || _isLoggedIn(page.url());
            await page.close();
            if (loggedInNow) log('Login สำเร็จ ✓');
            return loggedInNow ? { ok: true, message: 'Login สำเร็จ ✓' } : { ok: false, error: 'หมดเวลายืนยัน 2FA' };
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
                const loggedInNow = ok || _isLoggedIn(page.url());
                await page.close();
                if (loggedInNow) log('Login สำเร็จ ✓');
                return loggedInNow ? { ok: true, message: 'Login สำเร็จ ✓' } : { ok: false, error: 'หมดเวลายืนยัน 2FA' };
            }
            await page.close();
            return { ok: false, error: 'Email หรือ Password ไม่ถูกต้อง' };
        }

        if (_is2FA(page.url())) {
            const ok = await _wait2FA(page, log);
            const loggedInNow = ok || _isLoggedIn(page.url());
            await page.close();
            if (loggedInNow) log('Login สำเร็จ ✓');
            return loggedInNow ? { ok: true, message: 'Login สำเร็จ ✓' } : { ok: false, error: 'หมดเวลายืนยัน 2FA' };
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
                               'Report','Display','Log out','Logout','More','Accessibility'];
            // Chat/notification popups on facebook.com match the same dialog/list/menu
            // selectors as the profile switcher, so anything reading like a notification
            // ("X sent you a message: ...", "X started following you") must be excluded —
            // otherwise it gets scraped as a "page" name (seen with unread-message toasts).
            const notifMarkers = ['ยังไม่ได้อ่าน','ส่งข้อความถึงคุณ','ติดตามคุณ','แสดงความคิดเห็น',
                               'ถูกใจ','ได้เชิญคุณ','กำลังรอการตอบกลับ','เข้าร่วมกลุ่ม',
                               'sent you a message','started following you','commented on','liked your'];
            const viewAllLabels = ['ดูโปรไฟล์ทั้งหมด','View all profiles','View all','ดูทั้งหมด','See all profiles'];

            // Try clicking "View all profiles" to get the full list
            const clickedViewAll = await fb.evaluate((labels) => {
                for (const lbl of labels) {
                    for (const el of document.querySelectorAll('span,a,button,[role="menuitem"],[role="listitem"]')) {
                        if (el.textContent?.trim() === lbl) {
                            el.click();
                            return lbl;
                        }
                    }
                }
                return null;
            }, viewAllLabels);

            if (clickedViewAll) {
                await fb.waitForTimeout(2500);
                // Scan the full profile selector modal/dialog
                const fromViewAll = await fb.evaluate(({ mw, nm }) => {
                    const res = []; const seen = new Set();
                    const isNotif = (name) => name.includes(':') || nm.some(w => name.includes(w));
                    // Target the specific "เลือกโปรไฟล์" / "Select profile" modal first
                    let targetContainer = [...document.querySelectorAll('[role="dialog"],[role="listbox"]')]
                        .find(el => el.textContent?.includes('เลือกโปรไฟล์') || el.textContent?.includes('Select profile') || el.textContent?.includes('Choose a profile'));
                    const containers = targetContainer
                        ? [targetContainer]
                        : [...document.querySelectorAll('[role="dialog"],[role="list"],[role="listbox"],[role="menu"]')];
                    for (const c of containers) {
                        for (const item of c.querySelectorAll('[role="menuitem"],[role="option"],[role="listitem"],li')) {
                            const hasAvatar = !!item.querySelector('img,image,[role="img"]');
                            if (!hasAvatar) continue;
                            const name = [...item.querySelectorAll('span')]
                                .map(s => s.textContent?.trim())
                                .find(t => t && t.length >= 2 && t.length <= 100 && !/^\d+$/.test(t));
                            if (!name || seen.has(name)) continue;
                            if (mw.some(w => name.toLowerCase().includes(w.toLowerCase()))) continue;
                            if (isNotif(name)) continue;
                            // Detect active/personal account by blue checkmark SVG fill color
                            const isPersonal = [...item.querySelectorAll('svg circle,svg path')]
                                .some(el => { const f = el.getAttribute('fill') || ''; return /^#(0866[Ff][Ff]|1877[Ff]2)$/i.test(f); });
                            seen.add(name); res.push({ name, isPersonal });
                        }
                    }
                    return res;
                }, { mw: menuWords, nm: notifMarkers });
                // Fallback: if blue-checkmark detection missed, treat first item as personal
                if (fromViewAll.length && !fromViewAll.some(p => p.isPersonal)) fromViewAll[0].isPersonal = true;
                await fb.keyboard.press('Escape');
                if (fromViewAll.length) { await fb.close(); return fromViewAll; }
            }

            // Fallback: scan the partial dropdown (no "View all" button found)
            const fromSwitcher = await fb.evaluate(({ mw, nm }) => {
                const res = []; const seen = new Set();
                const isNotif = (name) => name.includes(':') || nm.some(w => name.includes(w));
                const W = window.innerWidth;
                const containers = [...document.querySelectorAll('[role="menu"],[role="dialog"],[role="list"],[role="listbox"]')]
                    .filter(c => {
                        const br = c.getBoundingClientRect();
                        return br.x > W * 0.35 && br.y < 400 && br.height < 700 && br.width > 50;
                    });
                for (const c of containers) {
                    for (const item of c.querySelectorAll('[role="menuitem"],[role="option"],[role="listitem"],li')) {
                        const hasAvatar = !!item.querySelector('img,image,svg[role="img"],svg[aria-label],[role="img"]');
                        if (!hasAvatar) continue;
                        const name = [...item.querySelectorAll('span')]
                            .map(s => s.textContent?.trim())
                            .find(t => t && t.length >= 2 && t.length <= 100);
                        if (!name || seen.has(name)) continue;
                        if (mw.some(w => name.toLowerCase().includes(w.toLowerCase()))) continue;
                        if (isNotif(name)) continue;
                        seen.add(name); res.push({ name });
                    }
                }
                return res;
            }, { mw: menuWords, nm: notifMarkers });
            await fb.keyboard.press('Escape');
            if (fromSwitcher.length) {
                fromSwitcher[0].isPersonal = true; // first item in switcher dropdown is the personal account
                await fb.close(); return fromSwitcher;
            }
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
        return { page, pageId, switched: true };
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
// Text of the identity area at the top of the create-post dialog (name next
// to the avatar, plus avatar alt/aria-labels) — who the post would go out as.
async function _dialogIdentityText(page) {
    return page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(d => d.querySelector('[contenteditable="true"]'));
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return '';
        const top = dialog.getBoundingClientRect().y;
        const parts = [];
        for (const el of dialog.querySelectorAll('span, strong, h2, h3, a, img, image, [aria-label]')) {
            const r = el.getBoundingClientRect();
            if (r.height === 0 || r.y < top || r.y > top + 170) continue;
            if (el.matches('[contenteditable], [contenteditable] *')) continue;
            const t = el.getAttribute('aria-label') || el.getAttribute('alt') || (el.children.length ? '' : el.textContent);
            if (t && t.trim()) parts.push(t.trim());
        }
        return parts.join(' | ');
    }).catch(() => '');
}

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

        // Step 3: try Playwright locator — more reliable than evaluate for dynamic popups.
        // Prefer an item whose name IS the page (exact, ignoring spacing/emoji)
        // over one that merely contains it, so a similarly named Page is never
        // picked; read all texts first, then click by index.
        const want = _normText(pageName);
        const allMenuItems = page.locator('[role="menu"] [role="menuitem"], [role="listbox"] [role="option"], [role="menu"] [role="button"], [role="list"] li');
        const count = await allMenuItems.count().catch(() => 0);
        const texts = [];
        for (let i = 0; i < count; i++) texts.push((await allMenuItems.nth(i).textContent({ timeout: 500 }).catch(() => '')) || '');
        const usable = i => !_MENU_WORDS.some(w => texts[i].toLowerCase().includes(w.toLowerCase()));
        let idx = texts.findIndex((t, i) => usable(i) && _normText(t) === want);
        if (idx < 0) idx = texts.findIndex((t, i) => usable(i) && _normText(t).includes(want));
        if (idx >= 0) {
            try {
                await allMenuItems.nth(idx).click({ timeout: 3000 });
                await page.waitForTimeout(1000);
                return 'locator:' + pageName;
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

// Facebook can bounce any page to a security check (approve-on-phone 2FA,
// checkpoint) even with a valid session. Waits for the user to approve, then
// reopens retryUrl. Returns null when usable, or an error message to stop on.
const AUTH_REQUIRED_PREFIX = 'Facebook ขอยืนยันตัวตน';
async function _ensureAuthed(page, retryUrl, log) {
    const url = page.url();
    if (url.includes('/login')) return 'Session หมดอายุ — Login ใหม่';
    if (!_is2FA(url)) return null;

    _onAuthNeeded?.(true);
    const ok = await _wait2FA(page, log);
    _onAuthNeeded?.(false);
    if (!ok) return `${AUTH_REQUIRED_PREFIX} — ไม่ได้อนุมัติภายใน 10 นาที กรุณาอนุมัติบนมือถือแล้วสั่งโพสใหม่`;
    if (page.url().includes('/login')) return 'Session หมดอายุ — Login ใหม่';

    log('✅ ยืนยันตัวตนแล้ว ทำต่อ...');
    await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    if (_is2FA(page.url()) || page.url().includes('/login')) return `${AUTH_REQUIRED_PREFIX} — ยืนยันแล้วแต่ยังเข้าไม่ได้ กรุณา Login ใหม่`;
    return null;
}

let _onAuthNeeded = null;
function onAuthNeeded(cb) { _onAuthNeeded = cb; }

// Groups are saved as a numeric id, a vanity name ("pattayapoolvilla"), or —
// for some — a full link (".../share/g/…", ".../groups/…"). Pasting a link
// after /groups/ produced a broken address, so use links as they are and
// encode anything else.
function groupUrlFor(groupId, pageId) {
    const raw = String(groupId || '').trim();
    let url;
    if (/^https?:\/\//i.test(raw)) url = new URL(raw);
    else url = new URL(`https://www.facebook.com/groups/${encodeURIComponent(raw)}`);
    if (pageId) url.searchParams.set('profile_id', pageId);
    return url.toString();
}

// Group ids can be links ("https://…/share/g/…"); "/" and ":" in a file name
// made the debug screenshot itself fail and hide the real error.
function _fileSafe(s) { return String(s || '').replace(/[^\w.-]+/g, '_').slice(-80) || 'group'; }

// The browser page/window went away mid-job (closed by hand, crashed).
function isClosedError(msg) { return /Target page, context or browser has been closed|Target closed|browser has disconnected|Browser closed/i.test(String(msg || '')); }

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

        const groupUrl = groupUrlFor(groupId, pageId);
        log(`🌐 เปิดกลุ่ม ${groupName}...${pageId ? ` [as Page ${pageId}]` : ''}`);
        await page.goto(groupUrl, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });

        // Wait for page to fully load
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);

        const authErr = await _ensureAuthed(page, groupUrl, log);
        if (authErr) {
            if (ownPage) await page.close().catch(() => {});
            return { ok: false, error: authErr, authRequired: true };
        }

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
            await page.screenshot({ path: path.join(_userDataBase, `debug-${_fileSafe(groupId)}.png`), fullPage: false }).catch(() => {});
            if (ownPage) await page.close();
            return { ok: false, error: `หาช่องโพสต์ไม่เจอ (debug-${_fileSafe(groupId)}.png บันทึกแล้ว)` };
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
            // The typed link is about to be replaced by the text, so Facebook's
            // link card is the only place the link survives. Count what the
            // dialog shows for this site before typing, so the card can be
            // recognised as something new.
            const cardsBefore = await _linkCardCount(page, url);
            await page.keyboard.type(url, { delay: 15 });
            await page.keyboard.press('Space'); // a link is picked up once it is finished off
            // Facebook can take a while to build the card (short links that
            // redirect, e.g. vt.tiktok.com) or not build one at all — wait for
            // it to really be there instead of a fixed pause.
            const preview = await _waitLinkPreview(page, url, cardsBefore);
            const hasPreview = !!preview;
            log(hasPreview ? '   ✅ การ์ดลิงก์ขึ้นแล้ว' : '   ⚠️ Facebook ไม่สร้างการ์ดลิงก์ให้ — จะใส่ลิงก์ไว้ท้ายข้อความแทน');
            let linkInText = false;
            if (hasPreview) {
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
            } else if (text) {
                log('⌨️ พิมพ์ข้อความ...');
                await page.keyboard.press('Control+a');
                await page.waitForTimeout(400);
                await page.keyboard.type(text, { delay: 25 });
                await page.keyboard.press('Enter');
                await page.keyboard.press('Enter');
                await page.keyboard.type(url, { delay: 15 });
                linkInText = true;
            } else {
                linkInText = true; // no card and no text: the URL already typed stays as the post
            }
            // The card must still be there once the text is in: if it went
            // away with the typed link, or the text's own links took its
            // place, the post would go out without the link.
            if (!linkInText) {
                await page.waitForTimeout(1500);
                // `preview` says how the card was recognised; look for it the same way.
                if ((await _linkCardCount(page, url))[preview] <= cardsBefore[preview]) {
                    log('   ⚠️ การ์ดลิงก์หายไปหลังพิมพ์ข้อความ — ใส่ลิงก์ไว้ท้ายข้อความแทน');
                    await page.keyboard.press('Control+End');
                    if (text) { await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); }
                    await page.keyboard.type(url, { delay: 15 });
                }
            }
        } else {
            await page.keyboard.type(message, { delay: 30 });
        }

        await page.waitForTimeout(1500);

        // Last check before anything is published: the create-post dialog must
        // show the identity that was chosen. Menus can shift between reading
        // and clicking, so never trust that the switch above landed right.
        if (postAsPage) {
            const who = await _dialogIdentityText(page);
            if (!_normText(who).includes(_normText(postAsPage))) {
                log(`   ⛔ ผู้โพสในหน้าต่างไม่ใช่ "${postAsPage}" — ไม่กดโพส`);
                await page.screenshot({ path: path.join(_userDataBase, `debug-identity-${_fileSafe(groupId)}.png`) }).catch(() => {});
                await page.keyboard.press('Escape').catch(() => {});
                if (ownPage) await page.close().catch(() => {});
                return { ok: false, error: `ตัวตนที่จะโพสไม่ใช่ "${postAsPage}" — ยกเลิก ไม่ได้โพส (กันโพสผิดเพจ)` };
            }
            log(`   ✅ ยืนยันผู้โพส: ${postAsPage}`);
        }

        log('📤 กด Post...');

        // Post button inside the dialog only
        const postSels = [
            '[role="dialog"] div[aria-label="Post"][role="button"]:not([aria-disabled="true"])',
            '[role="dialog"] div[aria-label="โพสต์"][role="button"]:not([aria-disabled="true"])',
            '[role="dialog"] div[aria-label="Post"][role="button"]',
            '[role="dialog"] div[aria-label="โพสต์"][role="button"]',
        ];
        // Snapshot existing post URLs before clicking Post (for diff after)
        let existingPostUrls = new Set();
        try {
            const urls = await page.evaluate(() =>
                [...document.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"]')]
                    .map(a => a.href).filter(Boolean)
            );
            existingPostUrls = new Set(urls);
        } catch {}

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

        // Try to capture the URL of the new post (best-effort)
        let postUrl = null;
        try {
            const allUrls = await page.evaluate(() =>
                [...document.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"]')]
                    .map(a => a.href).filter(h => h && h.includes('facebook.com'))
            );
            // Prefer a URL that didn't exist before (= our new post)
            for (const url of allUrls) {
                if (!existingPostUrls.has(url)) { postUrl = url; break; }
            }
            // Fallback: first visible post URL
            if (!postUrl && allUrls.length > 0) postUrl = allUrls[0];
        } catch {}

        if (ownPage) await page.close();
        return { ok: true, postUrl };
    } catch(e) { return { ok: false, error: e.message }; }
}

// Counts, in the open create-post dialog and outside the text box:
//   site   – things that point at `url`'s site (a link card's title/site line)
//   remove – link-card remove (x) buttons, whatever site the card is for
// A link card for `url` showing up raises one or both.
async function _linkCardCount(page, url) {
    let host = '';
    try { host = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.toLowerCase(); } catch {}
    const domain = host.split('.').slice(-2).join('.');
    return page.evaluate(({ domain }) => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        const dlg = dialogs[dialogs.length - 1];
        if (!dlg) return { site: 0, remove: 0 };
        const boxes = [...dlg.querySelectorAll('[contenteditable="true"]')];
        const outside = el => !boxes.some(b => b.contains(el));
        const removeBtn = /ลบตัวอย่างลิงก์|ลบไฟล์แนบ|Remove link preview|Remove post attachment|Remove attachment/i;
        const remove = [...dlg.querySelectorAll('[aria-label]')].filter(el => outside(el) && removeBtn.test(el.getAttribute('aria-label'))).length;
        const site = !domain ? 0 : [...dlg.querySelectorAll('a[href], [role="link"]')].filter(el => {
            if (!outside(el)) return false;
            const t = ((el.getAttribute('href') || '') + ' ' + (el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
            return t.includes(domain);
        }).length;
        return { site, remove };
    }, { domain }).catch(() => ({ site: 0, remove: 0 }));
}

// Waits for a link card for `url` to appear (see _linkCardCount). Never
// returns sooner than the pause this replaced, so a card that is still
// loading its picture is not cut short. Returns how it was recognised —
// 'site' (it names the link's site) or 'remove' (only its x button was found)
// — or null if none appears in time.
async function _waitLinkPreview(page, url, countBefore, { minMs = 5000, timeoutMs = 20000 } = {}) {
    const start = Date.now();
    let seen = null;
    while (Date.now() - start < timeoutMs) {
        if (seen !== 'site') {
            const now = await _linkCardCount(page, url);
            if (now.site > countBefore.site) seen = 'site';
            else if (now.remove > countBefore.remove) seen = 'remove';
        }
        if (seen && Date.now() - start >= minMs) return seen;
        await page.waitForTimeout(500);
    }
    return seen;
}

// ── Delete a post we made ─────────────────────────────────────
// Letters/digits only, so emoji/spacing/line-break differences between the
// job's message and what Facebook renders don't break the comparison.
function _normText(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }

const _UNAVAILABLE_RE = /เนื้อหานี้ไม่พร้อมใช้งาน|ไม่พบเนื้อหา|This content isn't available|content isn't available|Page Not Found|ไม่พบหน้านี้/i;

// Deletes the post at postUrl ONLY IF its text matches expectMessage — the
// stored postUrl is a best-effort guess (see postToGroup) and can point at
// someone else's post, which a group admin account would be allowed to
// delete. Returns { ok, status: 'deleted'|'gone'|'skipped'|'failed', error }.
async function deletePostByUrl(accountId, postUrl, expectMessage, onLog) {
    const log = m => onLog?.(m);
    let page = null;
    try {
        const key = _normText(expectMessage).slice(0, 30);
        if (key.length < 8) return { ok: false, status: 'skipped', error: 'ข้อความสั้นเกินไปที่จะยืนยันว่าเป็นโพสของเรา — ข้ามเพื่อความปลอดภัย' };

        const ctx = await _getContext(accountId);
        page = await ctx.newPage();
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const authErr = await _ensureAuthed(page, postUrl, log);
        if (authErr) return { ok: false, status: 'failed', error: authErr, authRequired: true };

        const article = page.locator('[role="article"]').first();
        if (!(await article.count())) {
            const body = await page.evaluate(() => document.body.innerText).catch(() => '');
            if (_UNAVAILABLE_RE.test(body)) return { ok: true, status: 'gone' };
            return { ok: false, status: 'failed', error: 'ไม่พบโพสต์ในหน้านี้' };
        }

        const artText = await article.innerText().catch(() => '');
        if (!_normText(artText).includes(key)) {
            return { ok: false, status: 'skipped', error: 'ข้อความในโพสไม่ตรงกับงานนี้ — ข้ามเพื่อไม่ให้ลบโพสผิดอัน' };
        }

        log('   🔎 ยืนยันแล้วว่าเป็นโพสของงานนี้ — เปิดเมนูลบ...');
        const menuBtn = article.locator('[aria-label="การดำเนินการสำหรับโพสต์นี้"], [aria-label="Actions for this post"], [aria-label="แสดงตัวเลือกเพิ่มเติม"], [aria-label="More options"]').first();
        if (!(await menuBtn.count())) return { ok: false, status: 'failed', error: 'ไม่พบปุ่มเมนู "..." ของโพสต์' };
        await menuBtn.click();
        await page.waitForTimeout(900);

        const delItem = page.getByRole('menuitem', { name: /^(ลบโพสต์|Delete post|ย้ายไปที่ถังขยะ|ย้ายไปยังถังขยะ|Move to trash|Move to Recycle bin)/i }).first();
        if (!(await delItem.count())) {
            await page.keyboard.press('Escape').catch(() => {});
            return { ok: false, status: 'failed', error: 'ไม่มีเมนูลบโพสต์ (บัญชีนี้ไม่ใช่เจ้าของโพสหรือไม่มีสิทธิ์)' };
        }
        await delItem.click();
        await page.waitForTimeout(1200);

        const confirmBtn = page.locator('[role="dialog"]').last()
            .getByRole('button', { name: /^(ลบ|Delete|ย้าย|Move)/i }).last();
        if (!(await confirmBtn.count())) return { ok: false, status: 'failed', error: 'ไม่พบปุ่มยืนยันการลบ' };
        await confirmBtn.click();
        await page.waitForTimeout(3500);

        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const still = page.locator('[role="article"]');
        const n = await still.count();
        for (let i = 0; i < n; i++) {
            const t = await still.nth(i).innerText().catch(() => '');
            if (_normText(t).includes(key)) return { ok: false, status: 'failed', error: 'กดลบแล้วแต่โพสยังอยู่บน Facebook' };
        }
        return { ok: true, status: 'deleted' };
    } catch (e) {
        return { ok: false, status: 'failed', error: e.message };
    } finally {
        if (page) { try { await page.close(); } catch {} }
    }
}

async function closeContext(accountId) {
    const ctx = _contexts[accountId];
    if (ctx) { try { await ctx.close(); } catch {} delete _contexts[accountId]; }
}

async function closeAll() {
    for (const id of Object.keys(_contexts)) await closeContext(id);
}

module.exports = { init, onAuthNeeded, isClosedError, groupUrlFor, loginAccount, postToGroup, deletePostByUrl, getAccountPages, openSwitchedPage, switchBackOnPage, closeContext, closeAll };
