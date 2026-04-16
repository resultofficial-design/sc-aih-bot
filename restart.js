const { execSync } = require('child_process');
const os = require('os');

console.log('[SYSTEM] Killing old bot instances...');

try {
  if (os.platform() === 'win32') {
    execSync(
      `taskkill /F /FI "IMAGENAME eq node.exe" /FI "PID ne ${process.pid}"`,
      { stdio: 'ignore' }
    );
  } else {
    execSync('pkill -f "node index.js" || true', { stdio: 'ignore' });
  }
} catch {
  // No existing processes to kill — that's fine
}

console.log('[SYSTEM] Starting fresh bot instance...');

// Run in foreground — blocks until the bot exits
execSync('node index.js', { stdio: 'inherit' });
