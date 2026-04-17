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

  // ── Step 1: Load the org members page ──────────────────────────────────────
  console.log(`[SCRAPER] Navigating to org members page: ${membersUrl}`);
  await page.goto(membersUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  console.log('[SCRAPER] Current URL:', currentUrl);
  if (!currentUrl.includes('/members')) {
    console.warn('[SCRAPER] Warning: not confirmed on /members URL — continuing anyway');
  }

  // ── Step 2: Scroll to load all lazy-rendered profile links ────────────────
  console.log('[scraper] Scrolling to load all profile links...');
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        window.scrollBy(0, 400);
        if (window.scrollY + window.innerHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
  await page.waitForTimeout(2000);

  // ── Step 3: Collect all unique /citizens/ profile URLs ─────────────────────
  const rawLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/citizens/"]'))
      .map((a) => a.href)
  );

  const uniqueLinks = [...new Set(rawLinks)];
  console.log('[PROFILE LINKS FOUND]', uniqueLinks.length);

  if (uniqueLinks.length === 0) {
    throw new Error('Scraper failed: no /citizens/ profile links found on org page');
  }

  // ── Step 4: Visit each profile and extract the handle ──────────────────────
  const results = [];

  for (let i = 0; i < uniqueLinks.length; i++) {
    const url = uniqueLinks[i];
    console.log(`[PROFILE] ${i + 1}/${uniqueLinks.length} — ${url}`);

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

      const data = await page.evaluate(() => {
        const text = document.body.innerText;

        // RSI profile pages show "Handle name" followed by the handle on the next line
        // Try multiple patterns to be robust against minor layout changes
        const patterns = [
          /Handle\s+name\s*[\n:]\s*([^\n]+)/i,
          /Handle\s*[\n:]\s*([^\n]+)/i,
        ];

        let handle = null;
        for (const pattern of patterns) {
          const m = text.match(pattern);
          if (m && m[1] && m[1].trim().length >= 2) {
            handle = m[1].trim();
            break;
          }
        }

        return { handle };
      });

      if (!data.handle || data.handle.length < 2) {
        console.log('[SKIP INVALID HANDLE]', url);
        continue;
      }

      results.push({
        name: data.handle,
        displayName: data.handle,
        handle: data.handle,
        role: 'Member',
        rank: 'Member',
        profileUrl: url,
      });

    } catch (err) {
      console.warn(`[PROFILE ERROR] ${url} — ${err.message}`);
    }

    // Rate limit — avoid hammering RSI servers
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('[FINAL MEMBERS]', results.length);
  console.log('[SAMPLE]', results.slice(0, 5));

  if (results.length === 0) {
    throw new Error('Scraper failed: visited profiles but extracted 0 valid handles');
  }

  if (results.length < uniqueLinks.length * 0.5) {
    console.warn(`[SCRAPER WARNING] Only got ${results.length} handles from ${uniqueLinks.length} profile links`);
  }

  console.log('[SCRAPER] Members found:', results.map((m) => m.handle));
  console.log('[SYNC] Proceeding with sync using', results.length, 'members');
  return results;
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
