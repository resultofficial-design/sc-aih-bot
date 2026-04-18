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
const PROFILE_CONCURRENCY = 5;

// Scrape a single member's org data on a fresh page, returns { orgType, finalRank }
async function scrapeOneMemberProfile(browser, member) {
  const page = await browser.newPage();
  try {
    await page.goto(`${RSI_HOME_URL}/citizens/${member.handle}`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

    // Click Organizations tab and verify it responded
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll('*'))
        .find(el => el.textContent?.trim().toLowerCase() === 'organizations');
      if (tab) tab.click();
    });

    // Confirm tab click triggered org content to begin loading
    await page.waitForFunction(
      () => document.body.innerText.toLowerCase().includes('organization'),
      { timeout: 3000 }
    ).catch(() => {});

    // Wait for "Organization Rank" label to appear in a DOM element (not just innerText)
    try {
      await page.waitForFunction(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        return elements.some(el => {
          const t = el.textContent?.toLowerCase();
          return t && t.includes('organization rank');
        });
      }, { timeout: 5000 });
    } catch {
      // Fallback: give dynamic content extra time if waitForFunction timed out
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log('[PAGE READY CHECK]', await page.evaluate(() =>
      document.body.innerText.includes('Organization Rank')
    ));

    const result = await page.evaluate(() => {
      function findHrvatskaCard() {
        const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
          const t = el.textContent?.toLowerCase();
          return t && t.includes('hrvatska') && t.includes('organization rank');
        });
        if (candidates.length === 0) return null;
        return candidates.reduce((a, b) =>
          a.textContent.length < b.textContent.length ? a : b
        );
      }

      function extractRankFromCard(card) {
        const elements = Array.from(card.querySelectorAll('*'));
        for (let i = 0; i < elements.length; i++) {
          const label = elements[i].textContent?.trim().toLowerCase();
          if (label === 'organization rank') {
            const valueEl = elements[i + 1];
            if (valueEl) {
              const value = valueEl.textContent?.trim();
              if (value && value.length < 30 && /^[A-Za-z\s]+$/.test(value)) return value;
            }
          }
        }
        return null;
      }

      const hrvatskaCard = findHrvatskaCard();
      if (!hrvatskaCard) return { orgType: 'none', finalRank: null };

      let parent = hrvatskaCard;
      let orgType = 'main';
      while (parent) {
        const t = parent.textContent?.toLowerCase();
        if (t?.includes('affiliation')) { orgType = 'affiliate'; break; }
        if (t?.includes('main organization')) { orgType = 'main'; break; }
        parent = parent.parentElement;
      }

      const finalRank = extractRankFromCard(hrvatskaCard);
      return { orgType, finalRank };
    });

    console.log('[FINAL RESULT]', { handle: member.handle, ...(result || {}) });
    return result || { orgType: 'none', finalRank: null };
  } catch (err) {
    console.warn(`[PROFILE RANK] ${member.handle} — ${err.message}`);
    return { orgType: 'none', finalRank: null };
  } finally {
    await page.close();
  }
}

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

  // Navigate first so the page session/cookies are active for fetch calls
  console.log('[SCRAPER] Loading org page...');
  await page.goto(membersUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

  // ── Fetch all member pages directly via RSI's internal API ────────────────
  console.log('[SCRAPER] Fetching members via API...');
  const result = await page.evaluate(async (symbol) => {
    const allMembers = [];
    let pageNum = 1;
    let total = 0;

    while (true) {
      const res = await fetch('/api/orgs/getOrgMembers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, search: '', pagesize: 32, page: pageNum }),
      });
      const data = await res.json();
      if (!data?.data) break;

      const html = data.data.html;
      total = data.data.totalrows || total;
      if (!html || html.length === 0) break;

      // Parse HTML using DOM structure — no innerText guesswork
      const container = document.createElement('div');
      container.innerHTML = html;
      const items = container.querySelectorAll('li');
      items.forEach((item) => {
        const link = item.querySelector('a[href*="/citizens/"]');
        if (!link) return; // skip non-members

        // Handle is always the last segment of the profile URL
        const profileUrl = link.getAttribute('href');
        const handle = profileUrl.split('/').pop();
        if (!handle || handle.length < 2) return;

        const displayName = link.textContent.trim() || handle;

        // Role from dedicated element, avoiding name/handle repetition
        let role = 'Member';
        const roleEl =
          item.querySelector('[class*="rank"]') ||
          item.querySelector('[class*="role"]') ||
          item.querySelector('p') ||
          item.querySelector('span');
        if (roleEl) {
          const text = roleEl.textContent.trim();
          if (text && text !== displayName && text !== handle) role = text;
        }

        const isAffiliate = role.toLowerCase().includes('affiliate');
        const orgType = isAffiliate ? 'affiliate' : 'main';

        // roles populated later via profile page scraping
        allMembers.push({ displayName, handle, orgType, roles: [] });
      });

      console.log('[PAGE LOADED]', pageNum, '— members so far:', allMembers.length);
      pageNum++;
      // stop if we've likely reached all pages
      if (allMembers.length >= total) break;
    }

    // Deduplicate by handle
    const unique = new Map();
    allMembers.forEach(m => unique.set(m.handle.toLowerCase(), m));
    const finalMembers = Array.from(unique.values());

    if (finalMembers.length !== total) {
      console.warn('[MISMATCH]', finalMembers.length, 'parsed vs', total, 'expected');
    }
    console.log('[FINAL CLEAN MEMBERS]', finalMembers.length);

    return { total, members: finalMembers };
  }, orgName.toUpperCase());

  console.log('[TOTAL MEMBERS]', result.total);
  console.log('[PARSED MEMBERS]', result.members.length);

  if (result.members.length === 0) {
    throw new Error('API returned 0 members — check session or org symbol');
  }

  const members = result.members.map((m) => ({
    name: m.handle,
    displayName: m.displayName || m.handle,
    handle: m.handle,
    orgType: m.orgType || 'main',
    roles: [],
    rank: '',
  }));

  // Scrape profiles in parallel batches — 5x faster than sequential
  console.log(`[SCRAPER] Extracting ranks from ${members.length} profile pages (${PROFILE_CONCURRENCY} at a time)...`);
  for (let i = 0; i < members.length; i += PROFILE_CONCURRENCY) {
    const batch = members.slice(i, i + PROFILE_CONCURRENCY);
    const results = await Promise.all(batch.map(m => scrapeOneMemberProfile(browser, m)));
    results.forEach((result, idx) => {
      const member = batch[idx];
      if (result.orgType) member.orgType = result.orgType;
      member.roles = result.finalRank ? [result.finalRank] : [];
      member.rank = result.finalRank || '';
    });
    console.log(`[SCRAPER] Batch ${Math.floor(i / PROFILE_CONCURRENCY) + 1} done — ${Math.min(i + PROFILE_CONCURRENCY, members.length)}/${members.length} profiles processed`);
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
