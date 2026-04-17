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

  // Wait for member cards to appear
  console.log('[scraper] Waiting for member cards...');
  try {
    await page.waitForSelector('[class*="member"]', { timeout: 15000 });
    console.log('[scraper] Member cards found.');
  } catch {
    console.warn('[scraper] Member card selector timed out — proceeding anyway.');
  }

  // Scroll to trigger lazy loading
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);

  const extract = () => page.evaluate(() => {
    const RANK_KEYWORDS = ['officer', 'member', 'affiliate', 'recruit', 'branding', 'role'];
    const cleanText = (str) => (str || '').replace(/\s+/g, ' ').trim();

    const seen = new Set();
    const results = [];

    const cards = document.querySelectorAll('[class*="member"]');
    console.log('[scraper] Card count:', cards.length);

    cards.forEach((card) => {
      // Split card text into non-empty lines
      const lines = card.innerText
        .split('\n')
        .map((t) => cleanText(t))
        .filter(Boolean);

      if (lines.length < 2) return;

      const displayName = lines[0];
      // Handle may have a leading @ — strip it
      const handle = lines[1].replace(/^@/, '');

      if (!handle || handle.length < 2 || handle.length > 60) return;
      if (seen.has(handle.toLowerCase())) return;

      // Try to extract rank from remaining lines
      let rank = 'Member';
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        if (RANK_KEYWORDS.some((k) => line.includes(k)) && lines[i].length <= 50) {
          rank = lines[i];
          break;
        }
      }

      seen.add(handle.toLowerCase());
      // name = handle for backwards compatibility with all existing code
      results.push({ displayName, handle, name: handle, rank });
    });

    if (results.length === 0) {
      console.log('[scraper] Page preview (no results):', document.body.innerText.slice(0, 500));
    }

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

  console.log('[SCRAPER] Members found:', members.map((m) => m.handle));
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
