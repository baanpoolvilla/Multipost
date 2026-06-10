const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

let _context = null;

function getBrowserDataDir() {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'fb-browser-data');
}

function getFlagPath() {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'loggedin.flag');
}

async function getContext() {
    if (_context) return _context;
    const dir = getBrowserDataDir();
    fs.mkdirSync(dir, { recursive: true });
    _context = await chromium.launchPersistentContext(dir, {
        headless: false,
        viewport: { width: 1024, height: 768 },
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--foreground',
        ],
    });
    return _context;
}

// ── Auto-login with email + password ────────────────────────
async function loginWithCredentials(email, password, onStatus) {
    const log = (msg) => onStatus?.(msg);
    try {
        log('เปิด Chromium...');
        const ctx  = await getContext();
        const page = await ctx.newPage();
        await page.bringToFront();

        log('เปิด Facebook Login...');
        await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.bringToFront();
        await page.waitForTimeout(1500);

        // Fill credentials
        log('กรอก Email/Password...');
        await page.fill('#email', email);
        await page.fill('#pass',  password);
        await page.waitForTimeout(500);
        await page.click('[name="login"]');

        log('รอผล Login...');

        // Wait for page to move away from /login
        try {
            await page.waitForURL(
                url => !url.toString().includes('/login'),
                { timeout: 25000 }
            );
        } catch {
            await page.close();
            return { ok: false, error: 'Email หรือ Password ไม่ถูกต้อง (timeout)' };
        }

        const url = page.url();

        // Handle 2FA / checkpoint
        if (url.includes('/checkpoint') || url.includes('/two_step') || url.includes('device-based')) {
            log('⚠️ ต้องยืนยันตัวตน — ดูที่หน้าต่าง Chromium ใน taskbar แล้วทำตามขั้นตอน...');
            try {
                await page.waitForFunction(
                    () => !location.href.includes('/checkpoint') &&
                          !location.href.includes('/two_step')   &&
                          !location.href.includes('/login'),
                    { timeout: 180000, polling: 1500 }
                );
            } catch {
                await page.close();
                return { ok: false, error: 'หมดเวลายืนยัน 2FA (3 นาที)' };
            }
        }

        const loggedIn = await _isLoggedIn(page);
        if (loggedIn) {
            fs.writeFileSync(getFlagPath(), '1');
            log('Login สำเร็จ ✓');
        }
        await page.close();
        return { ok: loggedIn, message: loggedIn ? 'Login สำเร็จ ✓' : 'Login ไม่สำเร็จ' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ── Quick status check (no navigation) ──────────────────────
async function checkLoginStatus() {
    return { loggedIn: fs.existsSync(getFlagPath()) };
}

async function _isLoggedIn(page) {
    try {
        const url = page.url();
        return !url.includes('/login') && !url.includes('/checkpoint') &&
               (url.includes('facebook.com') || url.includes('fb.com'));
    } catch { return false; }
}

// ── Post a message to a Facebook group ──────────────────────
async function postToGroup(groupId, groupName, message, log) {
    try {
        const ctx  = await getContext();
        const page = await ctx.newPage();

        log(`🌐 เปิดกลุ่ม ${groupName}...`);
        await page.goto(`https://www.facebook.com/groups/${groupId}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        // Check still logged in
        if (page.url().includes('/login')) {
            await page.close();
            fs.rmSync(getFlagPath(), { force: true });
            return { ok: false, error: 'Session หมดอายุ กรุณา Login ใหม่' };
        }

        await page.waitForTimeout(2500);

        // ── Step 1: Click the composer area ───────────────────
        log(`🖱️ คลิกช่องโพสต์...`);
        const composerClicked = await _clickComposer(page);
        if (!composerClicked) {
            await page.close();
            return { ok: false, error: 'หาช่องโพสต์ไม่เจอ' };
        }

        await page.waitForTimeout(1500);

        // ── Step 2: Find the textbox ───────────────────────────
        log(`⌨️ พิมพ์ข้อความ...`);
        const typed = await _typeMessage(page, message);
        if (!typed) {
            await page.close();
            return { ok: false, error: 'พิมพ์ข้อความไม่ได้' };
        }

        await page.waitForTimeout(1000);

        // ── Step 3: Click Post button ──────────────────────────
        log(`📤 กด Post...`);
        const posted = await _clickPostButton(page);
        if (!posted) {
            await page.close();
            return { ok: false, error: 'กด Post ไม่ได้' };
        }

        // Wait for post to submit
        await page.waitForTimeout(3000);
        await page.close();
        return { ok: true };

    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function _clickComposer(page) {
    const selectors = [
        // Group composer placeholder
        '[data-pagelet="GroupComposer"] [role="button"]',
        // Generic write-something placeholder
        'div[aria-label*="Write something"]',
        'div[aria-label*="เขียน"]',
        'div[aria-label*="บางอย่าง"]',
        // Fallback: any create-post button in main area
        '[role="main"] form [role="button"]:first-child',
    ];

    for (const sel of selectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                await el.click({ timeout: 3000 });
                return true;
            }
        } catch {}
    }

    // Last resort: click by visible text
    try {
        const btn = page.getByText(/write something|เขียนบางอย่าง/i).first();
        if (await btn.count() > 0) { await btn.click(); return true; }
    } catch {}

    return false;
}

async function _typeMessage(page, message) {
    const selectors = [
        '[role="dialog"] [role="textbox"][contenteditable="true"]',
        '[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"][data-lexical-editor]',
        'div[contenteditable="true"]',
    ];

    for (const sel of selectors) {
        try {
            const el = await page.waitForSelector(sel, { timeout: 4000, state: 'visible' });
            if (el) {
                await el.click();
                await page.keyboard.type(message, { delay: 25 });
                return true;
            }
        } catch {}
    }
    return false;
}

async function _clickPostButton(page) {
    const selectors = [
        '[role="dialog"] [aria-label="Post"]',
        '[role="dialog"] [aria-label="โพสต์"]',
        'div[aria-label="Post"][role="button"]',
        'div[aria-label="โพสต์"][role="button"]',
        'button[aria-label="Post"]',
    ];

    for (const sel of selectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                await el.click({ timeout: 3000 });
                return true;
            }
        } catch {}
    }

    // Fallback: button by role + name
    try {
        const btn = page.getByRole('button', { name: /^Post$|^โพสต์$/ }).last();
        if (await btn.count() > 0) { await btn.click(); return true; }
    } catch {}

    return false;
}

async function closeBrowser() {
    if (_context) {
        await _context.close().catch(() => {});
        _context = null;
    }
}

module.exports = { loginWithCredentials, checkLoginStatus, postToGroup, closeBrowser };
