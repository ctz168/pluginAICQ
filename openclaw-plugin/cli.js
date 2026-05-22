#!/usr/bin/env node
/**
 * AICQ Chat Plugin — CLI Entry Point
 *
 * Usage:
 *   openclaw plugins install npm:aicq-chat-plugin   Install via openclaw CLI
 *   openclaw plugins uninstall aicq-chat            Uninstall old version
 *   openclaw gateway restart                        Restart gateway
 *   aicq-plugin                    Start plugin server
 *   aicq-plugin start              Start the plugin server
 *   aicq-plugin install            Install plugin to OpenClaw only
 *   aicq-plugin uninstall          Remove plugin from OpenClaw
 *   aicq-plugin status             Check plugin status
 *   aicq-plugin --port <port>      Specify port (default 6109)
 *   aicq-plugin --help             Show help
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const command = args[0] || 'start';

// Parse options
let port = process.env.AICQ_PORT || '6109';
let serverUrl = process.env.AICQ_SERVER_URL || 'http://aicq.online:61018';

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

// ── SKILL.md template ─────────────────────────────────────────────
const SKILL_MD_TEMPLATE = `---
name: aicq-chat
description: AICQ End-to-end Encrypted Chat Plugin for OpenClaw — Full UI with friend management, group chat, file transfer, and AI agent communication
license: MIT
metadata:
  author: AICQ
  version: "{VERSION}"
---

# AICQ Encrypted Chat

AICQ 是一个端到端加密聊天插件，适用于 OpenClaw 的完整聊天 UI。支持好友管理、群组聊天、文件传输和 AI Agent 通信。

## 功能特性

- **端到端加密 (E2EE)** — 基于 NaCl (libsodium) 的加密体系，消息仅通信双方可读
- **Agent 管理** — 支持多 Agent 切换、创建和删除
- **好友管理** — 好友码添加、QR 码扫描、好友列表同步
- **群组聊天** — 创建群组、邀请成员、静默模式
- **消息功能** — Markdown/LaTeX 渲染、图片/文件上传、@提及
- **密钥管理** — 公钥/私钥显示、密钥轮换、指纹验证
- **P2P 通信** — 握手、文本传输、文件传输

## 一键启动

\`\`\`bash
# 1. 卸载旧版
openclaw plugins uninstall aicq-chat

# 2. 安装新版
openclaw plugins install npm:aicq-chat-plugin

# 3. 重启 gateway
openclaw gateway restart

# 4. 浏览器访问聊天界面
open http://localhost:6109
\`\`\`

## OpenClaw 集成

插件会自动注册为 OpenClaw sidecar，提供以下工具和网关：

### 工具
- \`chat-friend\` — 好友管理
- \`chat-send\` — 发送消息
- \`chat-export-key\` — 导出密钥

### 网关方法
- \`aicq.status\` — 插件状态
- \`aicq.friends.list/add/remove\` — 好友操作
- \`aicq.chat.send/history/delete\` — 聊天操作
- \`aicq.groups.list/create/join\` — 群组操作
- \`aicq.identity.info\` — 身份信息

## 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| \`AICQ_PORT\` | 6109 | 插件服务端口 |
| \`AICQ_SERVER_URL\` | http://aicq.online:61018 | AICQ 服务器地址 |
| \`AICQ_DATA_DIR\` | ~/.aicq-plugin | 数据存储目录 |

## Chat UI

启动后访问 http://localhost:6109 即可使用完整的聊天界面。
`;

// ── Find OpenClaw installation ──────────────────────────────────────
function findOpenClawDir() {
  const candidates = [
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), 'openclaw'),
    path.join(os.homedir(), '.config', 'openclaw'),
  ];
  if (process.env.OPENCLAW_HOME) {
    candidates.unshift(process.env.OPENCLAW_HOME);
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// ── Find OpenClaw workspace (for skills/ directory) ────────────────
function findOpenClawWorkspace() {
  // Check OPENCLAW_WORKSPACE env var first
  if (process.env.OPENCLAW_WORKSPACE) {
    return process.env.OPENCLAW_WORKSPACE;
  }

  // Try to find workspace from clawhub or common locations
  // Prefer directories that already have a skills/ directory
  const home = os.homedir();
  const candidates = [
    // Current working directory (most common for clawhub)
    process.cwd(),
    // Common workspace locations
    path.join(home, 'my-project'),
    path.join(home, 'openclaw'),
    path.join(home, '.openclaw'),
  ];

  // Check if any candidate has a skills/ directory (existing)
  for (const dir of candidates) {
    const skillsDir = path.join(dir, 'skills');
    if (fs.existsSync(skillsDir)) {
      return dir;
    }
  }

  // Also check parent directories of the current working dir
  let current = process.cwd();
  for (let i = 0; i < 3; i++) {
    const skillsDir = path.join(current, 'skills');
    if (fs.existsSync(skillsDir)) {
      return current;
    }
    current = path.dirname(current);
  }

  // If no existing skills/ found, fall back to the OpenClaw directory itself.
  // This handles the case where ~/.openclaw/ exists but has no skills/ yet.
  // We'll auto-create skills/ inside it during installation.
  const openclawDir = findOpenClawDir();
  if (openclawDir) {
    return openclawDir;
  }

  return null;
}

// ── Recursively copy a directory ────────────────────────────────────
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Install plugin files to a target directory ─────────────────────
function installToDir(sourceDir, targetDir, version) {
  // Files and dirs to copy
  const filesToCopy = [
    'index.js', 'cli.js', 'postinstall.js',
    'openclaw.plugin.json', 'package.json', 'README.md',
  ];
  const dirsToCopy = ['lib', 'public'];

  // Create target directory if needed
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Copy files
  for (const file of filesToCopy) {
    const src = path.join(sourceDir, file);
    const dest = path.join(targetDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  // Copy directories
  for (const dir of dirsToCopy) {
    const src = path.join(sourceDir, dir);
    const dest = path.join(targetDir, dir);
    if (fs.existsSync(src)) {
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      copyDirRecursive(src, dest);
    }
  }

  // Generate SKILL.md with current version
  const skillMd = SKILL_MD_TEMPLATE.replace('{VERSION}', version);
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), skillMd, 'utf8');
}

// ── Copy plugin files to OpenClaw (skills + plugins) ──────────────
function installToOpenClaw() {
  const PLUGIN_ID = 'aicq-chat';
  const sourceDir = path.resolve(__dirname);
  let version = '2.5.5';

  // Read version from package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
    version = pkg.version;
  } catch (e) {}

  // ── Step 1: Install to OpenClaw skills/ directory ──────────────
  // This is the primary install location — OpenClaw dashboard discovers
  // skills by scanning skills/ directories for SKILL.md marker files.
  let skillsInstalled = false;
  const workspace = findOpenClawWorkspace();
  if (workspace) {
    const skillsDir = path.join(workspace, 'skills');
    const skillTargetDir = path.join(skillsDir, PLUGIN_ID);

    // Check if already installed and up-to-date
    const targetSkillJson = path.join(skillTargetDir, 'openclaw.plugin.json');
    if (fs.existsSync(targetSkillJson)) {
      try {
        const existing = JSON.parse(fs.readFileSync(targetSkillJson, 'utf8'));
        if (existing.version === version) {
          console.log(`[AICQ] Skill already installed at ${skillTargetDir} (v${version})`);
          skillsInstalled = true;
        }
      } catch (e) {}
    }

    if (!skillsInstalled) {
      console.log(`[AICQ] Found workspace at: ${workspace}`);
      console.log(`[AICQ] Installing skill to ${skillTargetDir}...`);

      if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
      }

      installToDir(sourceDir, skillTargetDir, version);

      // Install npm dependencies in target
      console.log('[AICQ] Installing skill dependencies...');
      try {
        execSync('npm install --omit=dev', {
          cwd: skillTargetDir,
          stdio: 'pipe',
          timeout: 120000,
        });
        console.log('[AICQ] Skill dependencies installed.');
      } catch (e) {
        console.log('[AICQ] Warning: npm install failed. You may need to run manually:');
        console.log(`  cd ${skillTargetDir} && npm install`);
      }

      console.log(`[AICQ] Skill installed to: ${skillTargetDir}`);
      skillsInstalled = true;
    }
  }

  // ── Step 2: Install to OpenClaw plugins/ directory ─────────────
  // This is the secondary install location for sidecar startup.
  // OpenClaw reads openclaw.plugin.json from plugins/ to launch sidecar.
  let pluginInstalled = false;
  const openclawDir = findOpenClawDir();
  if (openclawDir) {
    const pluginsDir = path.join(openclawDir, 'plugins');
    const pluginTargetDir = path.join(pluginsDir, PLUGIN_ID);

    // Check if already installed and up-to-date
    const targetPluginJson = path.join(pluginTargetDir, 'openclaw.plugin.json');
    if (fs.existsSync(targetPluginJson)) {
      try {
        const existing = JSON.parse(fs.readFileSync(targetPluginJson, 'utf8'));
        if (existing.version === version) {
          console.log(`[AICQ] Plugin already installed at ${pluginTargetDir} (v${version})`);
          pluginInstalled = true;
        }
      } catch (e) {}
    }

    if (!pluginInstalled) {
      console.log(`[AICQ] Found OpenClaw at: ${openclawDir}`);
      console.log(`[AICQ] Installing plugin to ${pluginTargetDir}...`);

      if (!fs.existsSync(pluginsDir)) {
        fs.mkdirSync(pluginsDir, { recursive: true });
      }

      installToDir(sourceDir, pluginTargetDir, version);

      // Install npm dependencies in target
      console.log('[AICQ] Installing plugin dependencies...');
      try {
        execSync('npm install --omit=dev', {
          cwd: pluginTargetDir,
          stdio: 'pipe',
          timeout: 120000,
        });
        console.log('[AICQ] Plugin dependencies installed.');
      } catch (e) {
        console.log('[AICQ] Warning: npm install failed. You may need to run manually:');
        console.log(`  cd ${pluginTargetDir} && npm install`);
      }

      console.log(`[AICQ] Plugin installed to: ${pluginTargetDir}`);
      pluginInstalled = true;
    }
  }

  // ── Summary ────────────────────────────────────────────────────
  if (!skillsInstalled && !pluginInstalled) {
    console.log('[AICQ] OpenClaw not found, skipping auto-install.');
    console.log('[AICQ] If you have OpenClaw installed, set OPENCLAW_HOME or OPENCLAW_WORKSPACE environment variable.');
    console.log('[AICQ]   OPENCLAW_HOME=<openclaw-root-dir>       (for plugins/ directory)');
    console.log('[AICQ]   OPENCLAW_WORKSPACE=<workspace-dir>      (for skills/ directory)');
    return false;
  }

  console.log('[AICQ] Restart OpenClaw to activate the plugin.');
  return true;
}

// ── Uninstall from OpenClaw ─────────────────────────────────────────
function uninstallFromOpenClaw() {
  const PLUGIN_ID = 'aicq-chat';
  let removed = false;

  // Remove from skills/ directory
  const workspace = findOpenClawWorkspace();
  if (workspace) {
    const skillDir = path.join(workspace, 'skills', PLUGIN_ID);
    if (fs.existsSync(skillDir)) {
      console.log(`[AICQ] Removing skill from ${skillDir}...`);
      fs.rmSync(skillDir, { recursive: true, force: true });
      console.log('[AICQ] Skill removed.');
      removed = true;
    }
  }

  // Remove from plugins/ directory
  const openclawDir = findOpenClawDir();
  if (openclawDir) {
    const pluginDir = path.join(openclawDir, 'plugins', PLUGIN_ID);
    if (fs.existsSync(pluginDir)) {
      console.log(`[AICQ] Removing plugin from ${pluginDir}...`);
      fs.rmSync(pluginDir, { recursive: true, force: true });
      console.log('[AICQ] Plugin removed.');
      removed = true;
    }
  }

  if (!removed) {
    console.log('[AICQ] AICQ plugin not found in any OpenClaw directory.');
    console.log('[AICQ] Nothing to uninstall.');
  } else {
    console.log('[AICQ] Restart OpenClaw to complete the uninstall.');
  }

  return removed;
}

// ── Help ────────────────────────────────────────────────────────────
if (command === '--help' || command === '-h') {
  console.log(`
AICQ Chat Plugin — End-to-End Encrypted Chat for OpenClaw

Usage:
  openclaw plugins install npm:aicq-chat-plugin   Install plugin via openclaw CLI
  openclaw plugins uninstall aicq-chat            Uninstall old version
  openclaw gateway restart                        Restart gateway after install
  aicq-plugin [command] [options]                 Advanced usage

Commands:
  start       Install to OpenClaw (if needed) and start plugin server (default)
  install     Install plugin to OpenClaw only (don't start server)
  uninstall   Remove plugin from OpenClaw (skills/ and plugins/)
  status      Check if the plugin is running

Options:
  --port, -p <port>       Plugin server port (default: 6109)
  --server, -s <url>      AICQ server URL (default: http://aicq.online:61018)
  --help, -h              Show this help message

Environment Variables:
  AICQ_PORT               Plugin server port
  AICQ_SERVER_URL         AICQ server URL
  AICQ_DATA_DIR           Data directory (default: ~/.aicq-plugin)
  OPENCLAW_HOME           OpenClaw installation directory (for plugins/)
  OPENCLAW_WORKSPACE      OpenClaw workspace directory (for skills/)

Examples:
  openclaw plugins install npm:aicq-chat-plugin   # Install via openclaw CLI
  openclaw gateway restart                         # Restart gateway
  aicq-plugin                                      # Start on default port
  aicq-plugin install                              # Install to OpenClaw only
  aicq-plugin uninstall                            # Remove from OpenClaw
  aicq-plugin --port 8080                          # Start on port 8080
  aicq-plugin -s http://localhost                  # Connect to local server
`);
  process.exit(0);
}

// ── Status ──────────────────────────────────────────────────────────
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
    console.log(`Start it with: openclaw plugins install npm:aicq-chat-plugin`);
  });
  req.setTimeout(3000, () => {
    req.destroy();
    console.log(`AICQ Plugin is not responding on port ${port}.`);
  });
  process.exit(0);
}

// ── Install only ────────────────────────────────────────────────────
if (command === 'install') {
  installToOpenClaw();
  process.exit(0);
}

// ── Uninstall ───────────────────────────────────────────────────────
if (command === 'uninstall' || command === 'remove') {
  uninstallFromOpenClaw();
  process.exit(0);
}

// ── Start (default) — auto-install then run ─────────────────────────
installToOpenClaw();

console.log(`[AICQ] Starting plugin on port ${port}`);
console.log(`[AICQ] Server: ${serverUrl}`);

const env = { ...process.env, AICQ_PORT: port, AICQ_SERVER_URL: serverUrl };
const child = spawn('node', [path.join(__dirname, 'index.js')], {
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
