#!/usr/bin/env node
/**
 * AICQ Chat Plugin — CLI Entry Point
 *
 * Usage:
 *   aicq-plugin           Start the plugin server (default port 6109)
 *   aicq-plugin start     Start the plugin server
 *   aicq-plugin status    Check plugin status
 *   aicq-plugin --port    Specify port (default 6109)
 *   aicq-plugin --help    Show help
 */
const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0] || 'start';

// Parse options
let port = process.env.AICQ_PORT || '6109';
let serverUrl = process.env.AICQ_SERVER_URL || 'https://aicq.online';

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
    port = args[i + 1];
    i++;
  }
  if ((args[i] === '--server' || args[i] === '-s') && args[i + 1]) {
    serverUrl = args[i + 1];
    i++;
  }
}

if (command === '--help' || command === '-h') {
  console.log(`
AICQ Chat Plugin — End-to-End Encrypted Chat for OpenClaw

Usage:
  aicq-plugin [command] [options]

Commands:
  start     Start the plugin server (default)
  status    Check if the plugin is running

Options:
  --port, -p <port>       Plugin server port (default: 6109)
  --server, -s <url>      AICQ server URL (default: https://aicq.online)
  --help, -h              Show this help message

Environment Variables:
  AICQ_PORT               Plugin server port
  AICQ_SERVER_URL         AICQ server URL
  AICQ_DATA_DIR           Data directory (default: ~/.aicq-plugin)

Examples:
  aicq-plugin                        # Start on default port
  aicq-plugin --port 8080            # Start on port 8080
  aicq-plugin -s http://localhost    # Connect to local server
`);
  process.exit(0);
}

if (command === 'status') {
  const http = require('http');
  const req = http.get(`http://localhost:${port}/api/status`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const status = JSON.parse(data);
        console.log('AICQ Plugin Status:');
        console.log(`  Version:    ${status.version}`);
        console.log(`  Status:     ${status.status}`);
        console.log(`  Connected:  ${status.connected ? 'Yes' : 'No'}`);
        console.log(`  Agent:      ${status.currentAgent || 'None'}`);
        console.log(`  Server:     ${status.serverUrl}`);
      } catch (e) {
        console.log('Plugin is running but returned invalid status.');
      }
    });
  });
  req.on('error', () => {
    console.log(`AICQ Plugin is not running on port ${port}.`);
    console.log(`Start it with: aicq-plugin --port ${port}`);
  });
  req.setTimeout(3000, () => {
    req.destroy();
    console.log(`AICQ Plugin is not responding on port ${port}.`);
  });
  process.exit(0);
}

// Start the plugin server
console.log(`[AICQ] Starting plugin on port ${port}`);
console.log(`[AICQ] Server: ${serverUrl}`);

const env = { ...process.env, AICQ_PORT: port, AICQ_SERVER_URL: serverUrl };
const child = spawn('node', [path.join(__dirname, '..', 'index.js')], {
  env,
  stdio: 'inherit',
  detached: false
});

child.on('error', (err) => {
  console.error('[AICQ] Failed to start:', err.message);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});
