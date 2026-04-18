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

  // Navigate to each profile page and extract HRVATSKA org data only
  console.log(`[SCRAPER] Extracting ranks from ${members.length} profile pages...`);
  for (const member of members) {
    try {
      await page.goto(`${RSI_HOME_URL}/citizens/${member.handle}`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

      // Inject shared helpers onto window so both evaluate calls can use them
      await page.evaluate(() => {
        window._isHrvatska = (text) => !!(text && (
          text.includes('interstellar agency hrvatska') || text.includes('hrvatska')
        ));
        window._findHrvatskaCard = () => {
          // Step 1: find elements whose text IS exactly the org name
          const exactMatches = Array.from(document.querySelectorAll('div')).filter(el => {
            const text = el.textContent?.toLowerCase().trim();
            return text === 'interstellar agency hrvatska' || text === 'hrvatska';
          });

          // Step 2: climb up from each match until we reach a proper card container
          for (const match of exactMatches) {
            let current = match;
            while (current && current !== document.body) {
              const text = current.textContent?.toLowerCase();
              // card must contain BOTH the org name AND "organization rank"
              if (text && text.includes('organization rank') && window._isHrvatska(text)) {
                return current;
              }
              current = current.parentElement;
            }
          }
          return null;
        };
        window._extractRankFromCard = (card) => {
          if (!card) return null;

          // 1. Anchor to the exact "Organization Rank" label
          const labelEl = Array.from(card.querySelectorAll('*'))
            .find(el => el.textContent?.trim().toLowerCase() === 'organization rank');
          if (!labelEl) return null;

          // 2. Walk up until we find a block with multiple children (label + value row)
          let container = labelEl.parentElement;
          while (container && container.children.length <= 1) {
            container = container.parentElement;
          }
          if (!container) return null;

          function isValid(value) {
            return value && value.length > 0 && value.length < 25 && /^[A-Za-z\s]+$/.test(value);
          }

          // 3. Value container is the next sibling block after the label's row
          const valueContainer = container.nextElementSibling;

          if (valueContainer) {
            // 4. Extract only leaf nodes (deepest elements — no children)
            const leafNodes = Array.from(valueContainer.querySelectorAll('*'))
              .filter(node => node.children.length === 0);
            for (const node of leafNodes) {
              const value = node.textContent?.trim();
              if (isValid(value)) return value;
            }
            // Fallback: valueContainer's own text
            const fallback = valueContainer.textContent?.trim();
            if (isValid(fallback)) return fallback;
          }

          // 5. Fallback for simpler structures — check siblings of the label inside container
          for (const child of Array.from(container.children)) {
            if (child === labelEl) continue;
            const value = child.textContent?.trim();
            if (isValid(value)) return value;
          }

          return null;
        };
        window._detectOrgType = (block) => {
          let current = block;
          while (current && current !== document.body) {
            const text = current.textContent?.toLowerCase();
            if (text) {
              if (text.includes('affiliation')) return 'affiliate';
              if (text.includes('main organization')) return 'main';
            }
            current = current.parentElement;
          }
          return 'main';
        };
      });

      // ── STEP 1: Overview fast path (no tab click needed) ──────────────────
      let result = await page.evaluate(() => {
        const mainSection = Array.from(document.querySelectorAll('*'))
          .find(el => el.textContent?.toLowerCase().includes('main organization'));
        if (!mainSection) return null;
        if (!window._isHrvatska(mainSection.textContent.toLowerCase())) return null;
        return { orgType: 'main', finalRank: window._extractRankFromCard(mainSection) };
      });

      // ── STEP 2: Click Organizations tab, wait, then extract ────────────────
      if (!result) {
        const tabClicked = await page.evaluate(() => {
          const tab = Array.from(document.querySelectorAll('*'))
            .find(el => el.textContent?.toLowerCase().includes('organizations'));
          if (tab) { tab.click(); return true; }
          return false;
        });
        if (tabClicked) await page.waitForTimeout(800);

        result = await page.evaluate(() => {
          const orgBlock = window._findHrvatskaCard();
          if (!orgBlock) return null;
          console.log('[CARD VALIDATION]', {
            containsRank: orgBlock.textContent.includes('Organization Rank'),
            containsOrg: orgBlock.textContent.toLowerCase().includes('hrvatska'),
          });
          return {
            orgType: window._detectOrgType(orgBlock),
            finalRank: window._extractRankFromCard(orgBlock),
          };
        });
      }

      if (!result) result = { orgType: 'none', finalRank: null };

      console.log('[RANK RESULT]', { handle: member.handle, orgType: result.orgType, extractedRank: result.finalRank });
      if (!result.finalRank) {
        console.log('[NULL RANK DEBUG]', { handle: member.handle, orgType: result.orgType });
      }

      if (result.orgType) member.orgType = result.orgType;
      member.roles = result.finalRank ? [result.finalRank] : [];
      member.rank = result.finalRank || '';
      console.log('[RANK DEBUG]', { handle: member.handle, orgType: member.orgType, finalRank: result.finalRank });
    } catch (err) {
      console.warn(`[PROFILE RANK] ${member.handle} — ${err.message}`);
    }
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
