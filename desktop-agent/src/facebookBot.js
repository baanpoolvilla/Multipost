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

async function _getContext(accountId) {
    if (_contexts[accountId]?.browser?.isConnected?.()) return _contexts[accountId];
    const dir = _ctxDir(accountId);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dir, {
        headless: false,
        viewport: { width: 1024, height: 768 },
        args: ['--disable-blink-features=AutomationControlled','--foreground','--no-first-run'],
    });
    _contexts[accountId] = ctx;
    return ctx;
}

// ── Login ─────────────────────────────────────────────────────
async function loginAccount(account, onLog) {
    const log = m => onLog?.(m);
    try {
        log('เปิด Browser...');
        const ctx  = await _getContext(account.id);
        const page = await ctx.newPage();
        await page.bringToFront();

        log('เปิด Facebook Login...');
        await page.goto('https://www.facebook.com/login', { waitUntil:'domcontentloaded', timeout:30000 });
        await page.bringToFront();
        await page.waitForTimeout(1500);

        log('กรอก Email/Password...');
        await page.fill('#email', account.email);
        await page.fill('#pass',  account.password);
        await page.click('[name="login"]');
        log('รอผล Login...');

        try {
            await page.waitForURL(url=>!url.toString().includes('/login'), { timeout:25000 });
        } catch {
            await page.close();
            return { ok:false, error:'Email หรือ Password ไม่ถูกต้อง' };
        }

        const url = page.url();
        if (url.includes('/checkpoint') || url.includes('/two_step') || url.includes('device-based')) {
            log('⚠️ ต้องยืนยัน 2FA — ทำในหน้าต่าง Chromium...');
            try {
                await page.waitForFunction(
                    ()=>!location.href.includes('/checkpoint')&&!location.href.includes('/two_step')&&!location.href.includes('/login'),
                    { timeout:180000, polling:1500 }
                );
            } catch {
                await page.close();
                return { ok:false, error:'หมดเวลายืนยัน 2FA' };
            }
        }

        const loggedIn = !page.url().includes('/login');
        await page.close();
        if (loggedIn) log('Login สำเร็จ ✓');
        return { ok:loggedIn, message: loggedIn ? 'Login สำเร็จ ✓' : 'Login ไม่สำเร็จ' };
    } catch(e) { return { ok:false, error:e.message }; }
}

// ── Post to group ─────────────────────────────────────────────
async function postToGroup(accountId, groupId, groupName, message, onLog) {
    const log = m => onLog?.(m);
    try {
        const ctx  = await _getContext(accountId);
        const page = await ctx.newPage();

        log(`🌐 เปิดกลุ่ม ${groupName}...`);
        await page.goto(`https://www.facebook.com/groups/${groupId}`, { waitUntil:'domcontentloaded', timeout:30000 });

        if (page.url().includes('/login')) {
            await page.close();
            return { ok:false, error:'Session หมดอายุ — Login ใหม่' };
        }

        await page.waitForTimeout(2500);
        log('🖱️ คลิกช่องโพสต์...');

        const composerSels = [
            '[data-pagelet="GroupComposer"] [role="button"]',
            'div[aria-label*="Write something"]','div[aria-label*="เขียน"]',
            '[role="main"] form [role="button"]:first-child',
        ];
        let clicked = false;
        for (const s of composerSels) {
            try { const el=await page.$(s); if(el){ await el.click({timeout:3000}); clicked=true; break; } } catch{}
        }
        if (!clicked) {
            try { const b=page.getByText(/write something|เขียนบางอย่าง/i).first(); if(await b.count()>0){await b.click();clicked=true;} } catch{}
        }
        if (!clicked) { await page.close(); return { ok:false, error:'หาช่องโพสต์ไม่เจอ' }; }

        await page.waitForTimeout(1500);
        log('⌨️ พิมพ์ข้อความ...');

        const tbSels = [
            '[role="dialog"] [role="textbox"][contenteditable="true"]',
            '[role="textbox"][contenteditable="true"]',
            'div[contenteditable="true"][data-lexical-editor]',
            'div[contenteditable="true"]',
        ];
        let typed = false;
        for (const s of tbSels) {
            try {
                const el=await page.waitForSelector(s,{timeout:4000,state:'visible'});
                if(el){ await el.click(); await page.keyboard.type(message,{delay:25}); typed=true; break; }
            } catch{}
        }
        if (!typed) { await page.close(); return { ok:false, error:'พิมพ์ข้อความไม่ได้' }; }

        await page.waitForTimeout(1000);
        log('📤 กด Post...');

        const postSels = [
            '[role="dialog"] [aria-label="Post"]','[role="dialog"] [aria-label="โพสต์"]',
            'div[aria-label="Post"][role="button"]','div[aria-label="โพสต์"][role="button"]',
        ];
        let posted = false;
        for (const s of postSels) {
            try { const el=await page.$(s); if(el){await el.click({timeout:3000});posted=true;break;} } catch{}
        }
        if (!posted) {
            try { const b=page.getByRole('button',{name:/^Post$|^โพสต์$/}).last(); if(await b.count()>0){await b.click();posted=true;} } catch{}
        }
        if (!posted) { await page.close(); return { ok:false, error:'กด Post ไม่ได้' }; }

        await page.waitForTimeout(3000);
        await page.close();
        return { ok:true };
    } catch(e) { return { ok:false, error:e.message }; }
}

function closeContext(accountId) {
    const ctx = _contexts[accountId];
    if (ctx) { ctx.close().catch(()=>{}); delete _contexts[accountId]; }
}

async function closeAll() {
    for (const id of Object.keys(_contexts)) closeContext(id);
}

module.exports = { init, loginAccount, postToGroup, closeContext, closeAll };
