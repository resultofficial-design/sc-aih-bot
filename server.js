const http = require('http');
const fs = require('fs');
const path = require('path');
const { load, getUser, setUser, removeUser } = require('./users');
const { syncMemberRoles, isManagedRole } = require('./roles');
const { updateNickname } = require('./nicknames');

const PORT = process.env.DASHBOARD_PORT || 3000;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function buildUserRows(client, membersRef) {
  const verifiedUsers = load();
  const rsiMembers = membersRef.members;
  const guild = client.guilds.cache.first();

  return Object.entries(verifiedUsers).map(([discordId, rsiHandle]) => {
    const orgMember = rsiMembers.find(m =>
      (m.handle || m.name).toLowerCase() === rsiHandle.toLowerCase()
    );
    const discordMember = guild?.members.cache.get(discordId);

    const expectedRoles = orgMember ? [
      orgMember.orgType === 'affiliate' ? 'Affiliate' : 'Main Member',
      ...(orgMember.roles || []),
    ] : [];

    const currentRoles = discordMember
      ? [...discordMember.roles.cache.values()]
          .map(r => r.name)
          .filter(n => n !== '@everyone')
      : [];

    const synced = expectedRoles.length > 0 &&
      expectedRoles.every(r => currentRoles.includes(r));

    return {
      discordId,
      discordTag: discordMember?.user?.tag || 'Not in server',
      rsiHandle,
      orgType: orgMember?.orgType || 'none',
      rank: orgMember?.rank || '',
      expectedRoles,
      currentRoles,
      synced,
    };
  });
}

function startDashboard(client, membersRef, runSyncFn) {
  let syncRunning = false;

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    try {
      // ── GET /api/users ─────────────────────────────────────────────────────
      if (pathname === '/api/users' && req.method === 'GET') {
        return json(res, buildUserRows(client, membersRef));
      }

      // ── GET /api/members ───────────────────────────────────────────────────
      if (pathname === '/api/members' && req.method === 'GET') {
        return json(res, membersRef.members);
      }

      // ── GET /api/status ────────────────────────────────────────────────────
      if (pathname === '/api/status' && req.method === 'GET') {
        const guild = client.guilds.cache.first();
        return json(res, {
          botOnline: client.isReady(),
          guildName: guild?.name || 'unknown',
          rsiMemberCount: membersRef.members.length,
          verifiedCount: Object.keys(load()).length,
          syncRunning,
        });
      }

      // ── POST /api/sync ─────────────────────────────────────────────────────
      if (pathname === '/api/sync' && req.method === 'POST') {
        if (syncRunning) return json(res, { error: 'Sync already running' }, 409);
        const guild = client.guilds.cache.first();
        if (!guild) return json(res, { error: 'Guild not available' }, 500);
        syncRunning = true;
        runSyncFn(guild, membersRef, new Map())
          .catch(err => console.error('[DASHBOARD SYNC]', err.message))
          .finally(() => { syncRunning = false; });
        return json(res, { ok: true, message: 'Sync started' });
      }

      // ── POST /api/user/fix ────────────────────────────────────────────────
      if (pathname === '/api/user/fix' && req.method === 'POST') {
        const { discordId } = await readBody(req);
        const guild = client.guilds.cache.first();
        if (!guild || !discordId) return json(res, { error: 'Invalid request' }, 400);
        const rsiHandle = getUser(discordId);
        if (!rsiHandle) return json(res, { error: 'User not verified' }, 404);
        const orgMember = membersRef.members.find(m =>
          (m.handle || m.name).toLowerCase() === rsiHandle.toLowerCase()
        );
        if (!orgMember) return json(res, { error: 'RSI member not found' }, 404);
        const discordMember = await guild.members.fetch(discordId).catch(() => null);
        if (!discordMember) return json(res, { error: 'Discord member not found' }, 404);
        await syncMemberRoles(guild, discordMember, { orgType: orgMember.orgType || 'main', roles: orgMember.roles || [] });
        await updateNickname(guild, discordMember, rsiHandle);
        return json(res, { ok: true });
      }

      // ── POST /api/user/unlink ─────────────────────────────────────────────
      if (pathname === '/api/user/unlink' && req.method === 'POST') {
        const { discordId } = await readBody(req);
        if (!discordId) return json(res, { error: 'Invalid request' }, 400);
        removeUser(discordId);
        return json(res, { ok: true });
      }

      // ── GET /api/role-colors ──────────────────────────────────────────────
      if (pathname === '/api/role-colors' && req.method === 'GET') {
        const filePath = path.join(__dirname, 'role-colors.json');
        const colors = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
        return json(res, colors);
      }

      // ── POST /api/role-colors ─────────────────────────────────────────────
      if (pathname === '/api/role-colors' && req.method === 'POST') {
        const body = await readBody(req);
        fs.writeFileSync(path.join(__dirname, 'role-colors.json'), JSON.stringify(body, null, 2));
        return json(res, { ok: true });
      }

      // ── Serve dashboard HTML ──────────────────────────────────────────────
      if (pathname === '/' || pathname === '/dashboard') {
        const htmlPath = path.join(__dirname, 'public', 'dashboard.html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(htmlPath));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      console.error('[DASHBOARD ERROR]', err.message);
      json(res, { error: err.message }, 500);
    }
  });

  server.listen(PORT, () => {
    console.log(`[DASHBOARD] Admin UI → http://localhost:${PORT}`);
  });

  return server;
}

module.exports = { startDashboard };
