#!/usr/bin/env node
/**
 * AICQ Chat Plugin — Post-install script
 *
 * Automatically installs the plugin into OpenClaw's skills/ and plugins/ directories.
 * OpenClaw discovers skills by scanning skills/ directories for SKILL.md marker files.
 * OpenClaw reads openclaw.plugin.json from plugins/ to launch sidecar processes.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PLUGIN_ID = 'aicq-chat';
const PLUGIN_DIR = path.resolve(__dirname);

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
| \`AICQ_SERVER_URL\` | https://aicq.online | AICQ 服务器地址 |
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
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

// ── Find OpenClaw workspace (for skills/ directory) ────────────────
function findOpenClawWorkspace() {
  if (process.env.OPENCLAW_WORKSPACE) {
    return process.env.OPENCLAW_WORKSPACE;
  }

  const home = os.homedir();
  const candidates = [
    process.cwd(),
    path.join(home, 'my-project'),
    path.join(home, 'openclaw'),
    path.join(home, '.openclaw'),
  ];

  for (const dir of candidates) {
    const skillsDir = path.join(dir, 'skills');
    if (fs.existsSync(skillsDir)) {
      return dir;
    }
  }

  // Check parent directories
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
  const filesToCopy = [
    'extension.js',
    'index.js',
    'cli.js',
    'postinstall.js',
    'openclaw.plugin.json',
    'package.json',
    'README.md',
  ];

  const dirsToCopy = [
    'lib',
    'public',
  ];

  // Create target directory if needed
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Copy individual files
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

// ── Install to skills/ directory ────────────────────────────────────
function installToSkillsDir(workspace, version) {
  const skillsDir = path.join(workspace, 'skills');
  const targetDir = path.join(skillsDir, PLUGIN_ID);

  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  console.log(`[AICQ] Installing skill to ${targetDir}`);

  installToDir(PLUGIN_DIR, targetDir, version);

  // Install npm dependencies
  console.log('[AICQ] Installing skill dependencies...');
  try {
    execSync('npm install --omit=dev', {
      cwd: targetDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log('[AICQ] Skill dependencies installed.');
  } catch (e) {
    console.log('[AICQ] Warning: npm install failed. You may need to run it manually:');
    console.log(`  cd ${targetDir} && npm install`);
  }

  return targetDir;
}

// ── Install to plugins/ directory ───────────────────────────────────
function installToPluginsDir(openclawDir, version) {
  const pluginsDir = path.join(openclawDir, 'plugins');
  const targetDir = path.join(pluginsDir, PLUGIN_ID);

  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  console.log(`[AICQ] Installing plugin to ${targetDir}`);

  installToDir(PLUGIN_DIR, targetDir, version);

  // Install npm dependencies
  console.log('[AICQ] Installing plugin dependencies...');
  try {
    execSync('npm install --omit=dev', {
      cwd: targetDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log('[AICQ] Plugin dependencies installed.');
  } catch (e) {
    console.log('[AICQ] Warning: npm install failed. You may need to run it manually:');
    console.log(`  cd ${targetDir} && npm install`);
  }

  return targetDir;
}

// ── Main ────────────────────────────────────────────────────────────
console.log('');
console.log('  ╔══════════════════════════════════════════════╗');
console.log('  ║       AICQ Chat Plugin — Installing...       ║');
console.log('  ╚══════════════════════════════════════════════╝');
console.log('');

// Read version from package.json
let version = '2.6.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
  version = pkg.version;
} catch (e) {}

let skillInstalled = false;
let pluginInstalled = false;

// Step 1: Install to skills/ directory (for dashboard discovery)
const workspace = findOpenClawWorkspace();
if (workspace) {
  console.log(`[AICQ] Found workspace at: ${workspace}`);
  try {
    const skillDir = installToSkillsDir(workspace, version);
    console.log(`[AICQ] Skill installed to: ${skillDir}`);
    skillInstalled = true;
  } catch (e) {
    console.error('[AICQ] Skill install failed:', e.message);
  }
}

// Step 2: Install to plugins/ directory (for sidecar startup)
const openclawDir = findOpenClawDir();
if (openclawDir) {
  console.log(`[AICQ] Found OpenClaw at: ${openclawDir}`);
  try {
    const pluginDir = installToPluginsDir(openclawDir, version);
    console.log(`[AICQ] Plugin installed to: ${pluginDir}`);
    pluginInstalled = true;
  } catch (e) {
    console.error('[AICQ] Plugin install failed:', e.message);
  }
}

// Summary
console.log('');
if (skillInstalled || pluginInstalled) {
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     AICQ Plugin Installed Successfully!      ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║                                              ║');
  if (skillInstalled) {
    console.log('  ║   ✅ Skill installed (dashboard visible)     ║');
  }
  if (pluginInstalled) {
    console.log('  ║   ✅ Plugin installed (sidecar ready)        ║');
  }
  console.log('  ║                                              ║');
  console.log('  ║   Restart OpenClaw to activate the plugin.   ║');
  console.log('  ║                                              ║');
  console.log('  ║   Chat UI: http://localhost:6109             ║');
  console.log('  ║   Docs: https://aicq.online                  ║');
  console.log('  ╚══════════════════════════════════════════════╝');
} else {
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║       AICQ Chat Plugin Installed!            ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║                                              ║');
  console.log('  ║   OpenClaw not found — auto-install skipped  ║');
  console.log('  ║                                              ║');
  console.log('  ║   Set environment variables:                 ║');
  console.log('  ║     OPENCLAW_HOME=<openclaw-root>            ║');
  console.log('  ║     OPENCLAW_WORKSPACE=<workspace-dir>       ║');
  console.log('  ║                                              ║');
  console.log('  ║   Or install via openclaw CLI:               ║');
  console.log('  ║     openclaw plugins install npm:aicq-chat-plugin ║');
  console.log('  ║                                              ║');
  console.log('  ║   Chat UI: http://localhost:6109             ║');
  console.log('  ║   Docs: https://aicq.online                  ║');
  console.log('  ╚══════════════════════════════════════════════╝');
}
console.log('');
