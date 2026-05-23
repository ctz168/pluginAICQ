/**
 * AICQ Setup Entry — Setup Wizard for first-time configuration
 *
 * Uses defineSetupPluginEntry from the OpenClaw Channel SDK
 */
import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { aicqChatPlugin } from './src/channel.mjs';

export default defineSetupPluginEntry(aicqChatPlugin);
