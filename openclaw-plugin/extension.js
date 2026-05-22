/**
 * DEPRECATED — This file is no longer used in AICQ v3.0 (Channel architecture).
 *
 * In v2.x, extension.js served as the lightweight sidecar proxy entry point
 * loaded by `openclaw plugins install`. It proxied tool calls and gateway
 * methods to the sidecar Express server running on port 6109.
 *
 * In v3.0, the plugin runs as an in-process Channel plugin. All functionality
 * is handled directly by index.js + src/channel.js + src/ui-routes.js.
 * No sidecar process or HTTP proxy is needed.
 *
 * This file is kept for backward compatibility but does nothing.
 */

module.exports = {
  register() {
    console.warn('[AICQ] extension.js is deprecated in v3.0 Channel architecture. Use index.js instead.');
    return {
      id: 'aicq-chat',
      name: 'AICQ Encrypted Chat (Legacy Extension)',
      version: '3.0.0',
      description: 'Deprecated — use Channel plugin entry point (index.js) instead',
    };
  },
  activate() {
    console.warn('[AICQ] extension.js activate() is deprecated. Plugin now runs as Channel.');
    return {};
  },
};
