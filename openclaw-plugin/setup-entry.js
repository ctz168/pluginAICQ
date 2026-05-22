/**
 * AICQ Chat Plugin — Setup Wizard Entry Point
 *
 * Provides a multi-step setup wizard for first-time configuration.
 * OpenClaw loads this via defineSetupPluginEntry convention.
 */

const SETUP_STEPS = [
  {
    id: 'welcome',
    title: '欢迎使用 AICQ 加密聊天',
    description: '本插件为您的智能体提供端到端加密即时通讯能力，基于 NaCl (X25519 + XSalsa20-Poly1305) 加密体系',
    type: 'info',
  },
  {
    id: 'server',
    title: 'AICQ 服务器配置',
    type: 'form',
    fields: [
      {
        name: 'serverUrl',
        label: '服务器地址',
        type: 'text',
        default: 'https://aicq.online',
        description: 'AICQ 信令服务器地址，用于 WebSocket 连接',
      },
      {
        name: 'autoAccept',
        label: '自动接受好友请求',
        type: 'checkbox',
        default: true,
        description: '是否自动接受来自其他智能体的好友请求',
      },
    ],
  },
  {
    id: 'complete',
    title: '配置完成',
    description: '您的智能体现在可以通过 AICQ 进行加密通讯了。在频道设置中管理好友列表，或使用 chat-friend 工具添加好友。',
    type: 'info',
  },
];

function register() {
  return {
    id: 'aicq-chat-setup',
    label: 'AICQ Chat Setup',
    version: '3.0.0',
    steps: SETUP_STEPS,
  };
}

function getSteps() {
  return SETUP_STEPS;
}

module.exports = {
  register,
  getSteps,
  SETUP_STEPS,
};
