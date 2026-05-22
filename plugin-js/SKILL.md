---
name: aicq-chat
description: AICQ End-to-end Encrypted Chat Plugin for OpenClaw — Full UI with friend management, group chat, file transfer, and AI agent communication
license: MIT
metadata:
  author: AICQ
  version: "2.5.5"
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

```bash
# 1. 卸载旧版
openclaw plugins uninstall aicq-chat

# 2. 安装新版
openclaw plugins install npm:aicq-chat-plugin

# 3. 重启 gateway
openclaw gateway restart

# 4. 浏览器访问聊天界面
open http://localhost:6109
```

## OpenClaw 集成

插件会自动注册为 OpenClaw sidecar，提供以下工具和网关：

### 工具
- `chat-friend` — 好友管理
- `chat-send` — 发送消息
- `chat-export-key` — 导出密钥

### 网关方法
- `aicq.status` — 插件状态
- `aicq.friends.list/add/remove` — 好友操作
- `aicq.chat.send/history/delete` — 聊天操作
- `aicq.groups.list/create/join` — 群组操作
- `aicq.identity.info` — 身份信息

## 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AICQ_PORT` | 6109 | 插件服务端口 |
| `AICQ_SERVER_URL` | http://aicq.online:61018 | AICQ 服务器地址 |
| `AICQ_DATA_DIR` | ~/.aicq-plugin | 数据存储目录 |

## Chat UI

启动后访问 http://localhost:6109 即可使用完整的聊天界面。
