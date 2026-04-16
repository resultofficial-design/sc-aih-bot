const { chromium } = require('playwright');

const RSI_LOGIN_URL = 'https://robertsspaceindustries.com/account/login';

async function scrapeOrgMembers(orgName) {
  const email = process.env.RSI_EMAIL;
  const password = process.env.RSI_PASSWORD;

  if (!email || !password) {
    throw new Error('RSI_EMAIL and RSI_PASSWORD must be set in .env');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Login
    console.log('[scraper] Navigating to login page...');
    await page.goto(RSI_LOGIN_URL, { waitUntil: 'networkidle' });

    console.log('[scraper] Filling in credentials...');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    console.log('[scraper] Waiting for login to complete...');
    await page.waitForNavigation({ waitUntil: 'networkidle' });

    // Navigate to org members page
    const membersUrl = `https://robertsspaceindustries.com/orgs/${orgName}/members`;
    console.log(`[scraper] Navigating to ${membersUrl}...`);
    await page.goto(membersUrl, { waitUntil: 'networkidle' });

    console.log('[scraper] Waiting for member list to load...');
    await page.waitForSelector('.members-list', { timeout: 15000 }).catch(() => {
      console.warn('[scraper] .members-list selector not found, attempting extraction anyway...');
    });

    // Extract member names and ranks
    console.log('[scraper] Extracting members...');
    const members = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('.member-item, .members-list .member, [class*="member"]');

      cards.forEach((card) => {
        const name =
          card.querySelector('[class*="name"], [class*="handle"], .nick')?.textContent?.trim() || '';
        const rank =
          card.querySelector('[class*="rank"], [class*="role"], .rank')?.textContent?.trim() || '';

        if (name) {
          results.push({ name, rank });
        }
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
