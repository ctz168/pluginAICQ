#!/usr/bin/env node
/**
 * AICQ Chat Plugin — Post-install script
 *
 * Displays setup information after npm install.
 */

console.log('');
console.log('  ╔══════════════════════════════════════════════╗');
console.log('  ║       AICQ Chat Plugin Installed!            ║');
console.log('  ╠══════════════════════════════════════════════╣');
console.log('  ║                                              ║');
console.log('  ║   Install via openclaw CLI:                  ║');
console.log('  ║     openclaw plugins uninstall aicq-chat     ║');
console.log('  ║     openclaw plugins install npm:aicq-chat-plugin ║');
console.log('  ║     openclaw gateway restart                 ║');
console.log('  ║                                              ║');
console.log('  ║   Or start standalone:                       ║');
console.log('  ║     aicq-plugin                              ║');
console.log('  ║                                              ║');
console.log('  ║   Options:                                   ║');
console.log('  ║     --port <port>    Server port (6109)       ║');
console.log('  ║     --server <url>   AICQ server URL         ║');
console.log('  ║                                              ║');
console.log('  ║   Chat UI: http://localhost:6109             ║');
console.log('  ║   Docs: https://aicq.online                  ║');
console.log('  ╚══════════════════════════════════════════════╝');
console.log('');
