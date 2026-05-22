#!/usr/bin/env node
/**
 * AICQ Chat Plugin — Post-install script (v3.0 Channel)
 *
 * Displays setup information after npm install.
 * v3.0 uses Channel architecture - no independent port needed.
 */

console.log('');
console.log('  ╔══════════════════════════════════════════════╗');
console.log('  ║     AICQ Chat Plugin v3.0 Installed!        ║');
console.log('  ╠══════════════════════════════════════════════╣');
console.log('  ║                                              ║');
console.log('  ║   Architecture: Channel (in-process)         ║');
console.log('  ║   No independent port needed!                ║');
console.log('  ║                                              ║');
console.log('  ║   Install via openclaw CLI:                  ║');
console.log('  ║     openclaw plugins uninstall aicq-chat     ║');
console.log('  ║     openclaw plugins install npm:aicq-chat-plugin ║');
console.log('  ║     openclaw gateway restart                 ║');
console.log('  ║                                              ║');
console.log('  ║   UI: /plugins/aicq-chat/ui/                 ║');
console.log('  ║   API: /plugins/aicq-chat/api/*              ║');
console.log('  ║   Docs: https://aicq.online                  ║');
console.log('  ╚══════════════════════════════════════════════╝');
console.log('');
