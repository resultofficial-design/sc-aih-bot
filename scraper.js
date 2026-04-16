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

  console.log(`[scraper] Navigating to org page: ${membersUrl}`);
  await page.goto(membersUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);

  // Confirm we're on the right page
  const currentUrl = page.url();
  console.log('[scraper] Current URL:', currentUrl);
  if (!currentUrl.includes('/members')) {
    console.warn('[scraper] Not on members page — navigating again...');
    await page.goto(membersUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(5000);
  }

  // Log page content size and preview
  const pageText = await page.evaluate(() => document.body.innerText);
  console.log('[scraper] Page text length:', pageText.length);
  console.log('[scraper] Page preview:', pageText.slice(0, 300));

  // Scroll to trigger lazy loading
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);

  // Wait until page has substantial content
  console.log('[scraper] Waiting for page content...');
  try {
    await page.waitForFunction(
      () => document.body.innerText.length > 1000,
      { timeout: SELECTOR_TIMEOUT }
    );
  } catch {
    console.warn('[scraper] Content wait timed out — proceeding anyway.');
  }

  const extract = () => page.evaluate(() => {
    const RANK_KEYWORDS = ['officer', 'member', 'affiliate', 'recruit', 'branding', 'role'];
    const clean = (str) => str.replace(/\s+/g, ' ').trim();
    const seen = new Set();
    const results = [];

    const pageTextLen = document.body.innerText.length;
    console.log('[scraper] Page innerText length:', pageTextLen);

    // Broad sweep — every element in the DOM
    const allEls = Array.from(document.querySelectorAll('*'));

    for (const el of allEls) {
      // Only consider leaf-ish elements with limited children
      if (el.children.length > 20) continue;

      const nameEl = el.querySelector('[class*="name"], [class*="handle"], [class*="nick"]');
      const rankEl = el.querySelector('[class*="rank"], [class*="role"]');

      if (!nameEl || !rankEl) continue;

      const nameParts = nameEl.textContent.split('\n').map(clean).filter(Boolean);
      const name = nameParts[0] || '';
      if (!name || seen.has(name) || name.length > 60) continue;

      const rankParts = rankEl.textContent.split('\n').map(clean).filter((s) => s && s !== 'Roles');
      const rank = rankParts.join(', ') || 'Member';
      const hasRankKeyword = RANK_KEYWORDS.some((k) => rank.toLowerCase().includes(k));
      if (!hasRankKeyword && rank.length > 30) continue;

      seen.add(name);

      results.push({ name, rank });
    }

    if (results.length === 0) {
      console.log('[scraper] Page preview:', document.body.innerText.slice(0, 500));
    }

    return results;
  });

  console.log('[scraper] Starting extraction...');
  let members = await extract();
  console.log(`[scraper] Extracted members: ${members.length}`);

  if (members.length === 0) {
    console.warn('[scraper] No members found after extraction');
    console.warn('[scraper] Retrying after 3s...');
    await page.waitForTimeout(3000);
    members = await extract();
    console.log(`[scraper] Extracted members after retry: ${members.length}`);
  }

  console.log('[SYNC DEBUG] Members length:', members?.length);

  if (!members || members.length === 0) {
    console.warn('[SYNC] No members found after scraping');
    throw new Error('No members found');
  }

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
