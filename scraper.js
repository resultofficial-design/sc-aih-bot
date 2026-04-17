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

const CONCURRENCY = 5;

// Opens a fresh page on the existing browser, fetches a profile, returns handle or null
async function scrapeProfile(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

    const handle = await page.evaluate(() => {
      const text = document.body.innerText;
      const patterns = [
        /Handle\s+name\s*[\n:]\s*([^\n]+)/i,
        /Handle\s*[\n:]\s*([^\n]+)/i,
      ];
      for (const pattern of patterns) {
        const m = text.match(pattern);
        if (m && m[1] && m[1].trim().length >= 2) return m[1].trim();
      }
      return null;
    });

    return handle ? { url, handle } : null;
  } catch (err) {
    console.warn(`[ERROR] ${url} — ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function extractMembers(page, orgName, browser) {
  const membersUrl = `${RSI_HOME_URL}/orgs/${orgName}/members`;

  // ── Step 1: Intercept API responses before navigating ──────────────────────
  // Playwright fires 'response' for every network response — no setup needed.
  // We listen broadly and filter down to JSON payloads that look like member data.
  let membersData = [];

  page.on('response', async (response) => {
    const url = response.url();

    // Target RSI's known member/organization API endpoints
    const relevant = url.includes('/members') || url.includes('/organization');
    if (!relevant) return;

    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;

    try {
      const data = await response.json();
      console.log('[API RESPONSE]', url, '→ top-level keys:', Object.keys(data || {}).join(', '));

      // Try every common RSI API response envelope shape
      const candidates = [
        data?.data,
        data?.members,
        data?.result,
        data?.hits,
        Array.isArray(data) ? data : null,
      ].filter(Array.isArray);

      for (const arr of candidates) {
        if (arr.length === 0) continue;
        const first = arr[0];
        // Must look like a member object
        if (!first.handle && !first.nickname && !first.name) continue;

        const extracted = arr
          .map((m) => ({
            handle: (m.handle || m.nickname || m.name || '').trim(),
            displayName: (m.displayName || m.display_name || m.name || m.handle || '').trim(),
            role: (m.rank || m.role || 'Member').trim(),
          }))
          .filter((m) => m.handle.length >= 2);

        if (extracted.length > membersData.length) {
          membersData = extracted;
          console.log('[API MEMBERS FOUND]', membersData.length, 'members from', url);
        }
      }
    } catch (e) {
      // Not JSON or body already consumed — skip silently
    }
  });

  // ── Step 2: Navigate and let the page trigger its own API calls ────────────
  console.log('[SCRAPER] Loading org page — waiting for API responses...');
  await page.goto(membersUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(2000);

  // Scroll to trigger any lazy-loaded API calls
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        window.scrollBy(0, 400);
        if (window.scrollY + window.innerHeight >= document.body.scrollHeight) {
          clearInterval(timer); resolve();
        }
      }, 200);
    });
  });
  await page.waitForTimeout(2000);

  // ── Step 3: Wait up to 15s for API data ───────────────────────────────────
  const deadline = Date.now() + 15000;
  while (membersData.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }

  if (membersData.length > 0) {
    const results = membersData.map((m) => ({
      name: m.handle,
      displayName: m.displayName || m.handle,
      handle: m.handle,
      role: m.role,
      rank: m.role,  // rank alias for backwards compat
    }));
    console.log('[FINAL MEMBERS COUNT]', results.length);
    console.log('[SAMPLE]', results.slice(0, 5));
    console.log('[SCRAPER] Members found:', results.map((m) => m.handle));
    console.log('[SYNC] Proceeding with sync using', results.length, 'members');
    return results;
  }

  // ── Step 4: Fallback — parallel profile page scraping ─────────────────────
  console.warn('[SCRAPER] No API data captured — falling back to profile page scraping');

  const rawLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/citizens/"]')).map((a) => a.href)
  );
  const uniqueLinks = [...new Set(rawLinks)];
  console.log('[PROFILE LINKS FOUND]', uniqueLinks.length);

  if (uniqueLinks.length === 0) {
    throw new Error('Scraper failed: no API data and no /citizens/ profile links found');
  }

  const results = [];
  const totalBatches = Math.ceil(uniqueLinks.length / CONCURRENCY);

  for (let i = 0; i < uniqueLinks.length; i += CONCURRENCY) {
    const batch = uniqueLinks.slice(i, i + CONCURRENCY);
    const batchNum = Math.floor(i / CONCURRENCY) + 1;
    console.log(`[BATCH ${batchNum}/${totalBatches}] profiles ${i + 1}–${Math.min(i + CONCURRENCY, uniqueLinks.length)} of ${uniqueLinks.length}`);

    const batchResults = await Promise.all(batch.map((url) => scrapeProfile(browser, url)));

    for (const r of batchResults) {
      if (r?.handle?.length >= 2) {
        results.push({
          name: r.handle, displayName: r.handle, handle: r.handle,
          role: 'Member', rank: 'Member', profileUrl: r.url,
        });
      }
    }
    console.log('[PROGRESS]', results.length, '/', uniqueLinks.length);
  }

  console.log('[FINAL COUNT]', results.length);
  console.log('[SAMPLE]', results.slice(0, 5));

  if (results.length === 0) {
    throw new Error('Scraper failed: both API interception and profile scraping returned 0 members');
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
      const members = await extractMembers(page, orgName, browser);
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
