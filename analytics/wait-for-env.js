#!/usr/bin/env node
/**
 * Wait for .env file to be mounted, then start the application
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const envPath = path.join(__dirname, '.env');
const maxRetries = 30;
let retries = 0;

console.log('[Startup] Waiting for .env file to be mounted...');

const checkEnv = () => {
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    if (content.includes('DB_HOST')) {
      console.log('[Startup] ✅ .env file found and configured!');
      startApp();
      return;
    }
  }
  
  retries++;
  if (retries >= maxRetries) {
    console.error('[Startup] ❌ .env file not found after', maxRetries, 'retries');
    process.exit(1);
  }
  
  console.log(`[Startup] Retry ${retries}/${maxRetries}: waiting for .env...`);
  setTimeout(checkEnv, 1000);
};

function startApp() {
  const scriptPath = process.argv[2];
  
  if (!scriptPath) {
    console.error('[Startup] ❌ No script path provided');
    process.exit(1);
  }
  
  console.log(`[Startup] Starting: ${scriptPath}`);
  
  const proc = spawn('node', [scriptPath], {
    stdio: 'inherit',
    env: { ...process.env }
  });
  
  proc.on('exit', (code) => {
    console.log(`[Startup] Process exited with code ${code}`);
    process.exit(code);
  });
  
  proc.on('error', (err) => {
    console.error('[Startup] Error starting process:', err);
    process.exit(1);
  });
}

checkEnv();
