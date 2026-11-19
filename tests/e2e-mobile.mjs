// Mobile flows for כספית. Run with:
//   node tests/e2e-mobile.mjs
// Uses the system Chrome. Household cases also need the Auth and Firestore
// emulators on 127.0.0.1:9099 and :8080 (firebase emulators:start).
import { chromium, devices } from 'playwright-core';
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('..', import.meta.url));
const phone = devices['iPhone 13'];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

function startServer() {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root) || !existsSync(file)) {
        res.writeHead(404); res.end('missing'); return;
      }
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function track(page, bucket) {
  page.on('pageerror', err => bucket.push('pageerror: ' + err.message));
  page.on('response', res => {
    if (res.status() >= 400) bucket.push('http ' + res.status() + ' ' + res.url());
  });
  page.on('console', msg => { if (msg.type() === 'error') bucket.push('console: ' + msg.text()); });
}

async function boot(browser, extra) {
  const context = await browser.newContext({ ...phone, locale: 'he-IL', serviceWorkers: 'allow' });
  if (extra) await context.addInitScript(extra);
  const page = await context.newPage();
  const errors = [];
  track(page, errors);
  return { context, page, errors };
}

async function openApp(page, origin) {
  await page.goto(origin + '/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('#statTotal');
}

async function go(page, name) {
  const menu = page.locator('#mobileMenuBtn');
  if (await menu.isVisible()) {
    await menu.click();
    await page.locator('#sidebar.mobile-open').waitFor({ timeout: 5000 });
  }
  await page.locator(`.nav-item[data-page="${name}"]`).click();
  await page.locator(`#page-${name}.active`).waitFor();
}

async function waitText(page, selector, snippet) {
  await page.waitForFunction(([sel, text]) => {
    const el = document.querySelector(sel);
    return !!el && (el.textContent || '').includes(text);
  }, [selector, snippet], { timeout: 8000 });
}

async function liveBalance(page) {
  return page.evaluate(() => computeCurrentBalanceEstimate('all').amount);
}

function assertClean(errors, label) {
  const relevant = errors.filter(line => !/favicon|manifest|Download the React DevTools|ERR_INTERNET_DISCONNECTED/i.test(line));
  if (relevant.length) throw new Error(label + '\n' + relevant.join('\n'));
}

async function localFlows(browser, origin) {
  const { context, page, errors } = await boot(browser);
  await openApp(page, origin);
  await go(page, 'settings');
  await page.waitForSelector('[data-cloud-action="signin"]');
  await page.fill('#balanceCheckinAmount', '2,500.50');
  await page.click('#balanceCheckinSaveBtn');
  await waitText(page, '#balanceCheckinSummary', '2,500.50');
  await go(page, 'dashboard');
  await waitText(page, '#statTotal', '2,500.50');
  if (await liveBalance(page) !== 2500.5) throw new Error('dashboard memory balance is not 2500.50');

  await page.click('#mobileAddBtn');
  await page.fill('#txAmount', '20,40');
  await page.fill('#txNote', 'סופר');
  await page.locator('#txForm button[type="submit"]').click();
  await waitText(page, '#statTotal', '2,480.10');

  await go(page, 'transactions');
  await page.locator('.tx-card [aria-label="עריכה"]').first().click();
  await page.fill('#txAmount', '45.25');
  await page.locator('#txForm button[type="submit"]').click();
  await go(page, 'dashboard');
  await waitText(page, '#statTotal', '2,455.25');

  await go(page, 'transactions');
  await page.locator('.tx-card [aria-label="מחיקה"]').first().click();
  await go(page, 'dashboard');
  await waitText(page, '#statTotal', '2,500.50');

  await page.click('#mobileAddBtn');
  await page.locator('#txModalOverlay .type-btn.income').click();
  await page.fill('#txAmount', '10');
  await page.fill('#txNote', 'החזר');
  await page.locator('#txForm button[type="submit"]').click();
  await waitText(page, '#statTotal', '2,510.50');

  const beforeMonth = await page.locator('#statTotal').textContent();
  await page.selectOption('#monthFilter', 'all');
  await page.waitForTimeout(700);
  const afterMonth = await page.locator('#statTotal').textContent();
  if (beforeMonth !== afterMonth) throw new Error('month filter changed the current balance: ' + beforeMonth + ' -> ' + afterMonth);

  await go(page, 'settings');
  await page.fill('#newExpenseCat', 'קפה');
  await page.click('#addExpenseCatBtn');
  await waitText(page, '#expenseCatList', 'קפה');

  await go(page, 'budget');
  await page.click('#addBudgetBtn');
  await page.selectOption('#budgetCategory', { label: 'מזון' });
  await page.fill('#budgetAmount', '500');
  await page.locator('#budgetForm button[type="submit"]').click();
  await waitText(page, '#page-budget', 'מזון');

  await go(page, 'recurring');
  await page.click('#addRecurringBtn');
  await page.fill('#recurringName', 'מנוי');
  await page.fill('#recurringAmount', '30');
  await page.locator('#recurringForm button[type="submit"]').click();
  await go(page, 'dashboard');
  await waitText(page, '#statTotal', '2,480.50');

  await go(page, 'settings');
  await page.fill('#newAccountName', 'מזומן');
  await page.click('#addAccountBtn');
  await page.waitForSelector('#balanceCheckinAccount:not([hidden])');
  await page.selectOption('#balanceCheckinAccount', { label: 'מזומן' });
  await page.fill('#balanceCheckinAmount', '100.50');
  await page.click('#balanceCheckinSaveBtn');
  await go(page, 'dashboard');
  await page.selectOption('#accountFilter', { label: 'מזומן' });
  await waitText(page, '#statTotal', '100.50');
  await page.selectOption('#accountFilter', { label: 'כל החשבונות' });
  await waitText(page, '#statTotal', '2,480.50');

  await go(page, 'insights');
  await page.waitForSelector('#page-insights .card');
  await go(page, 'assistant');
  await page.waitForSelector('#assistantSetupCard');

  const chartOk = await page.evaluate(() => {
    const canvas = document.getElementById('netWorthChart');
    const chart = window.Chart && window.Chart.getChart(canvas);
    return !!(canvas && canvas.width > 0 && chart && chart.data.datasets[0].data.length > 0);
  });
  if (!chartOk) throw new Error('net-worth chart did not draw');

  await go(page, 'settings');
  const [xlsx] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportExcelBtn')
  ]);
  const xlsxPath = '/tmp/kaspit-e2e.xlsx';
  await xlsx.saveAs(xlsxPath);
  if (statSync(xlsxPath).size < 100) throw new Error('excel export was empty');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportJsonBtn')
  ]);
  const backup = '/tmp/kaspit-e2e-backup.json';
  await download.saveAs(backup);
  page.on('dialog', dialog => dialog.accept());
  await page.click('#resetAllBtn');
  await page.waitForFunction(() => (state.transactions || []).length === 0);
  await page.setInputFiles('#importJsonInput', backup);
  await page.waitForFunction(() => (state.balanceCheckins || []).some(c => !c.deleted && c.amount === 2500.5));
  await go(page, 'dashboard');
  await page.selectOption('#accountFilter', { label: 'כל החשבונות' });
  await waitText(page, '#statTotal', '2,480.50');

  await page.click('#mobileAddBtn');
  await page.fill('#txAmount', '5');
  await page.fill('#txNote', 'קבלה');
  await page.setInputFiles('#txReceiptInput', { name: 'receipt.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('#txReceiptPreview:not([hidden])');
  await page.locator('#txForm button[type="submit"]').click();
  await go(page, 'transactions');
  await page.locator('.tx-card [aria-label="הצגת קבלה"]').first().click();
  await page.waitForSelector('#receiptLightboxOverlay.active');
  await page.locator('#receiptLightboxOverlay [data-close]').click();
  await page.waitForFunction(() => !document.getElementById('receiptLightboxOverlay').classList.contains('active'));

  await go(page, 'settings');
  await page.click('#pinEnableBtn');
  await page.fill('#pinNewInput', '1234');
  await page.fill('#pinConfirmInput', '1234');
  await page.click('#pinManageSubmitBtn');
  await page.waitForFunction(() => localStorage.getItem('kaspit_pin_enabled') === '1');

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#lockScreenOverlay:not([hidden])');
  await page.fill('#lockScreenPinInput', '1234');
  await page.locator('#lockScreenForm button[type="submit"]').click();
  await page.waitForSelector('#page-dashboard.active');
  await waitText(page, '#statTotal', '2,475.50');
  assertClean(errors, 'local mobile flow');
  await context.close();
}

async function householdFlows(browser, origin) {
  const probe = await fetch('http://127.0.0.1:9099/').then(r => r.ok || r.status < 500).catch(() => false);
  if (!probe) {
    console.log('skip household: auth emulator is not running');
    return;
  }
  const stamp = Date.now();
  async function ensureUser(email) {
    const res = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', returnSecureToken: true })
    });
    if (!res.ok && res.status !== 400) throw new Error('could not create emulator user ' + email);
  }
  await ensureUser(`alice-${stamp}@test.dev`);
  await ensureUser(`bob-${stamp}@test.dev`);
  const script = () => { window.KASPIT_FIREBASE_EMULATORS = { auth: 'http://127.0.0.1:9099', firestoreHost: '127.0.0.1', firestorePort: 8080 }; };
  const a = await boot(browser, script);
  const b = await boot(browser, script);
  await openApp(a.page, origin);
  await openApp(b.page, origin);
  await a.page.waitForFunction(() => window.kaspitCloud && typeof window.kaspitCloud.e2eSignIn === 'function');
  await b.page.waitForFunction(() => window.kaspitCloud && typeof window.kaspitCloud.e2eSignIn === 'function');
  await a.page.evaluate(email => window.kaspitCloud.e2eSignIn(email, 'password123'), `alice-${stamp}@test.dev`);
  await b.page.evaluate(email => window.kaspitCloud.e2eSignIn(email, 'password123'), `bob-${stamp}@test.dev`);
  await go(a.page, 'settings');
  await a.page.waitForSelector('[data-cloud-action="create"]');
  await a.page.click('[data-cloud-action="create"]');
  await a.page.waitForSelector('.invite-code');
  const code = (await a.page.locator('.invite-code').textContent()).trim();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('bad invite code ' + code);

  await go(b.page, 'settings');
  await b.page.fill('#cloudJoinCode', code);
  await b.page.click('[data-cloud-action="join"]');
  await b.page.click('#cloudChoicePrimary');
  await b.page.waitForSelector('.invite-code');

  await a.page.fill('#balanceCheckinAmount', '1000.50');
  await a.page.click('#balanceCheckinSaveBtn');
  await go(a.page, 'dashboard');
  await waitText(a.page, '#statTotal', '1,000.50');
  await go(b.page, 'dashboard');
  await waitText(b.page, '#statTotal', '1,000.50');

  await b.page.click('#mobileAddBtn');
  await b.page.fill('#txAmount', '20.40');
  await b.page.fill('#txNote', 'קפה');
  await b.page.locator('#txForm button[type="submit"]').click();
  await waitText(b.page, '#statTotal', '980.10');
  await waitText(a.page, '#statTotal', '980.10');
  const both = await Promise.all([liveBalance(a.page), liveBalance(b.page)]);
  if (both[0] !== 980.1 || both[1] !== 980.1) throw new Error('household balances diverged ' + both.join(' / '));
  assertClean(a.errors, 'household alice');
  assertClean(b.errors, 'household bob');
  await a.context.close();
  await b.context.close();
}

const server = await startServer();
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  await localFlows(browser, origin);
  console.log('ok local mobile flows');
  await householdFlows(browser, origin);
  console.log('ok household flows');
} finally {
  await browser.close();
  server.close();
}
