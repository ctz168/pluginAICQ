/**
 * AICQ Chat Plugin — Channel Plugin Entry Point (ESM)
 *
 * Uses OpenClaw Channel Plugin SDK:
 *   - defineChannelPluginEntry from openclaw/plugin-sdk/channel-core
 *   - createChatChannelPlugin from openclaw/plugin-sdk/channel-core
 *
 * Architecture: In-process Channel (no sidecar, no independent port)
 */
import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { aicqChatPlugin } from './src/channel.mjs';

export default defineChannelPluginEntry({
  id: 'aicq-chat',
  name: 'AICQ Encrypted Chat',
  description: 'End-to-end encrypted chat channel via AICQ protocol — in-process Channel plugin',
  plugin: aicqChatPlugin,

  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program
          .command('aicq-chat')
          .description('AICQ Encrypted Chat management');
      },
      {
        descriptors: [
          {
            name: 'aicq-chat',
            description: 'AICQ Encrypted Chat management',
            hasSubcommands: false,
          },
        ],
      },
    );
  },

  registerFull(api) {
    // Register gateway HTTP routes for the SPA UI
    const gatewayMethods = [
      'aicq.status',
      'aicq.friends.list',
      'aicq.friends.add',
      'aicq.friends.remove',
      'aicq.friends.requests',
      'aicq.friends.acceptRequest',
      'aicq.friends.rejectRequest',
      'aicq.identity.info',
      'aicq.agent.create',
      'aicq.agent.delete',
      'aicq.chat.send',
      'aicq.chat.history',
      'aicq.chat.streamChunk',
      'aicq.chat.streamEnd',
      'aicq.groups.list',
      'aicq.groups.create',
      'aicq.groups.join',
      'aicq.groups.messages',
      'aicq.groups.silent',
      'aicq.sessions.list',
    ];

    for (const method of gatewayMethods) {
      api.registerGatewayMethod(method, async (kwargs, ctx) => {
        const { handleGateway } = await import('./src/gateway-handlers.mjs');
        return handleGateway(method, kwargs, ctx);
      });
    }
  },
});
