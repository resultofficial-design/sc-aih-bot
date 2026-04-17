const { chromium } = require('playwright');

const RSI_HOME_URL = 'https://robertsspaceindustries.com';
const NAV_TIMEOUT = 60000;
const SELECTOR_TIMEOUT = 60000;
const MAX_RETRIES = 2;

async function isLoggedIn(page) {
  try {
    // RSI shows account-related elements when logged in
    const accountEl = await page.$('[class*="account"], [class*="logout"], [aria-label*="account" i]');
    return !!accountEl;
  } catch {
    return false;
  }
}

async function login(page) {
  console.log('[scraper] Navigating to RSI homepage...');
  await page.goto(RSI_HOME_URL, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

  // Accept cookies
  try {
    const allowAll = page.locator('button', { hasText: 'Allow all cookies' });
    if (await allowAll.isVisible({ timeout: 5000 })) {
      await allowAll.click();
      await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT });
      console.log('[scraper] Cookie consent accepted.');
    }
  } catch {}

  // Check if already logged in
  if (await isLoggedIn(page)) {
    console.log('[scraper] Already logged in, skipping login.');
    return;
  }

  console.log('[scraper] Opening sign-in modal...');
  await page.locator('button.a-navigationButton', { hasText: /sign.?in/i }).first().click();
  await page.waitForSelector('input[type="text"]:visible', { timeout: 10000 });

  console.log('[scraper] Filling in credentials...');
  await page.fill('input[type="text"]:visible', process.env.RSI_EMAIL);
  await page.fill('input[type="password"]:visible', process.env.RSI_PASSWORD);

  console.log('[scraper] Submitting login...');
  await page.locator('button', { hasText: /sign.?in/i }).last().click();
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT });
  console.log('[scraper] Login complete. URL:', page.url());
}

async function extractMembers(page, orgName) {
  const membersUrl = `${RSI_HOME_URL}/orgs/${orgName}/members`;
  const MAX_NAV_RETRIES = 3;
  let onMembersPage = false;

  for (let navAttempt = 1; navAttempt <= MAX_NAV_RETRIES; navAttempt++) {
    console.log(`[SCRAPER] Navigation attempt ${navAttempt} to: ${membersUrl}`);
    await page.goto(membersUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log('[SCRAPER] Current URL:', currentUrl);

    if (!currentUrl.includes('/members')) {
      console.warn(`[SCRAPER] Not on members page (attempt ${navAttempt}) — retrying...`);
      if (navAttempt < MAX_NAV_RETRIES) {
        await page.waitForTimeout(2000);
        continue;
      }
      console.warn('[SCRAPER] Could not reach members page after all retries.');
      break;
    }

    onMembersPage = true;

    // Wait for members content to appear
    try {
      await page.waitForSelector('.member-list, .members, [data-members]', { timeout: 10000 });
      console.log('[SCRAPER] Members selector found.');
    } catch {
      console.warn('[SCRAPER] Members selector not found — proceeding anyway.');
    }

    break;
  }

  // Log page content size and preview
  const pageText = await page.evaluate(() => document.body.innerText);
  console.log('[scraper] Page text length:', pageText.length);
  console.log('[scraper] Page preview:', pageText.slice(0, 300));

  if (!onMembersPage) {
    console.warn('[SCRAPER] Proceeding despite not confirming members page URL.');
  }

  // Scroll slowly through the full page to trigger all lazy-loaded cards
  console.log('[scraper] Scrolling page to load all members...');
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const distance = 400;
      const delay = 200;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        if (window.scrollY + window.innerHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, delay);
    });
  });
  await page.waitForTimeout(2000);

  const extract = () => page.evaluate(() => {
    const cleanText = (str) => (str || '').replace(/\s+/g, ' ').trim();

    // UI text that should never be treated as a member name
    const UI_JUNK = [
      'search', 'reset', 'display users', 'filter', 'sort',
      'prev', 'next', 'load more', 'showing', 'members',
      'employee', 'officer', 'affiliate', 'recruit', 'admiral',
      'director', 'manager', 'founder', 'veteran',
    ];

    const seen = new Set();
    const results = [];

    // ── Step 1: log what every [class*="member"] selector finds ──────────────
    const selectors = [
      'li[class*="member"]',
      '[class*="member-item"]',
      '[class*="memberItem"]',
      '[class*="member_item"]',
      '[class*="org-member"]',
      '[class*="orgMember"]',
    ];
    for (const sel of selectors) {
      const n = document.querySelectorAll(sel).length;
      if (n > 0) console.log(`[SEL HIT] ${sel} → ${n} elements`);
    }

    // ── Step 2: find individual cards ────────────────────────────────────────
    // Try specific selectors in order; fall back to the generic one filtered
    // by line count so we skip containers.
    let cards = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) { cards = Array.from(found); break; }
    }

    if (cards.length === 0) {
      // Generic fallback: any [class*="member"] element with ≤ 8 text lines
      cards = Array.from(document.querySelectorAll('[class*="member"]')).filter((el) => {
        const lines = el.innerText.split('\n').map(t => t.trim()).filter(Boolean);
        return lines.length >= 1 && lines.length <= 8;
      });
      console.log(`[SEL FALLBACK] filtered [class*="member"]: ${cards.length} elements`);
    }

    console.log('[scraper] Cards to process:', cards.length);

    // Log the first card's raw lines so we can verify structure
    if (cards.length > 0) {
      const sample = cards[0].innerText.split('\n').map(t => t.trim()).filter(Boolean);
      console.log('[CARD SAMPLE lines]', sample);
    }

    // ── Step 3: extract name from line 0 of each card ────────────────────────
    cards.forEach((card) => {
      const lines = card.innerText
        .split('\n')
        .map((t) => cleanText(t))
        .filter(Boolean);

      if (lines.length === 0) return;

      const name = lines[0];

      if (!name || name.length < 2 || name.length > 60) return;
      if (seen.has(name.toLowerCase())) return;
      if (UI_JUNK.some((w) => name.toLowerCase().includes(w))) return;

      seen.add(name.toLowerCase());
      // role/rank default to 'Member' for now — will be re-added once names work
      results.push({ name, displayName: name, handle: name, role: 'Member', rank: 'Member' });
    });

    console.log('[EXTRACTED NAMES]', results.map((r) => r.name));
    return results;
  });

  console.log('[scraper] Starting extraction...');
  let members = await extract();
  console.log('[SCRAPER] Members extracted:', members.length);
  if (members.length > 0) console.log('[SCRAPER SAMPLE]', members.slice(0, 5));

  if (members.length === 0) {
    console.warn('[scraper] No members found — retrying after 3s...');
    await page.waitForTimeout(3000);
    members = await extract();
    console.log('[SCRAPER] Members extracted after retry:', members.length);
    if (members.length > 0) console.log('[SCRAPER SAMPLE]', members.slice(0, 5));
  }

  if (!members || members.length === 0) {
    throw new Error('Scraper failed: No members found in card layout');
  }

  if (members.length < 2) {
    console.warn('[SCRAPER WARNING] Possibly incomplete member list — only', members.length, 'member(s) returned');
  }

  console.log('[SCRAPER] Members found:', members.map((m) => m.name));
  console.log('[SYNC] Proceeding with sync using', members.length, 'members');
  return members;
}

async function scrapeOrgMembers(orgName) {
  if (!process.env.RSI_EMAIL || !process.env.RSI_PASSWORD) {
    throw new Error('RSI_EMAIL and RSI_PASSWORD must be set in .env');
  }

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (attempt > 1) {
      console.log(`[scraper] Retry ${attempt - 1} of ${MAX_RETRIES}...`);
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    try {
      await login(page);
      const members = await extractMembers(page, orgName);
      console.log(`[scraper] Found ${members.length} members.`);
      if (members && members.length > 0) {
        return members;
      }
      throw new Error(`extractMembers returned empty on attempt ${attempt}`);
    } catch (err) {
      lastError = err;
      console.error(`[scraper] Attempt ${attempt} failed: ${err.message}`);
    } finally {
      await browser.close();
    }
  }

  throw new Error(`Scraping failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`);
}

module.exports = { scrapeOrgMembers };
