const { chromium } = require('playwright');

const RSI_HOME_URL = 'https://robertsspaceindustries.com';

async function scrapeOrgMembers(orgName) {
  const email = process.env.RSI_EMAIL;
  const password = process.env.RSI_PASSWORD;

  if (!email || !password) {
    throw new Error('RSI_EMAIL and RSI_PASSWORD must be set in .env');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  try {
    // Load homepage
    console.log('[scraper] Navigating to RSI homepage...');
    await page.goto(RSI_HOME_URL, { waitUntil: 'networkidle' });

    // Accept cookies so consent is stored
    try {
      const allowAll = page.locator('button', { hasText: 'Allow all cookies' });
      if (await allowAll.isVisible({ timeout: 5000 })) {
        await allowAll.click();
        await page.waitForLoadState('networkidle');
        console.log('[scraper] Cookie consent accepted.');
      }
    } catch {}

    // Open login modal
    console.log('[scraper] Opening sign-in modal...');
    await page.locator('button.a-navigationButton', { hasText: /sign.?in/i }).first().click();
    await page.waitForSelector('input[type="text"]:visible', { timeout: 10000 });

    // Fill credentials
    console.log('[scraper] Filling in credentials...');
    await page.fill('input[type="text"]:visible', email);
    await page.fill('input[type="password"]:visible', password);

    // Submit
    console.log('[scraper] Submitting login...');
    await page.locator('button', { hasText: /sign.?in/i }).last().click();
    await page.waitForLoadState('networkidle');
    console.log('[scraper] Login submitted. Current URL:', page.url());

    // Navigate to org members page
    const membersUrl = `${RSI_HOME_URL}/orgs/${orgName}/members`;
    console.log(`[scraper] Navigating to ${membersUrl}...`);
    await page.goto(membersUrl, { waitUntil: 'networkidle' });

    // Wait for members to render
    console.log('[scraper] Waiting for member list...');
    await page.waitForSelector('[class*="member"]', { timeout: 15000 }).catch(() => {
      console.warn('[scraper] Member selector not found, attempting extraction anyway...');
    });

    // Extract members
    console.log('[scraper] Extracting members...');
    const members = await page.evaluate(() => {
      const clean = (str) => str.replace(/\s+/g, ' ').trim();

      const seen = new Set();
      const results = [];

      // Target individual member cards only (not parent wrappers)
      const cards = document.querySelectorAll('[class*="member-item"], [class*="memberItem"], [class*="member_item"]');

      // Fallback: use all [class*="member"] but deduplicate by handle
      const targets = cards.length > 0 ? cards : document.querySelectorAll('[class*="member"]');

      targets.forEach((card) => {
        const nameEl = card.querySelector('[class*="name"], [class*="handle"], [class*="nick"]');
        const rankEl = card.querySelector('[class*="rank"], [class*="role"]');

        if (!nameEl) return;

        // Name: first non-empty token (display name)
        const nameParts = nameEl.textContent.split('\n').map(clean).filter(Boolean);
        const name = nameParts[0] || '';
        if (!name || seen.has(name)) return;
        seen.add(name);

        // Rank: filter out "Roles" label, join actual roles
        const rankParts = rankEl
          ? rankEl.textContent.split('\n').map(clean).filter((s) => s && s !== 'Roles')
          : [];
        const rank = rankParts.join(', ') || 'Member';

        results.push({ name, rank });
      });

      return results;
    });

    console.log(`[scraper] Found ${members.length} members.`);
    return members;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeOrgMembers };
