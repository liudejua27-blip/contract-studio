import type { NextConfig } from 'next';
const config: NextConfig = { distDir: process.env.CONTRACT_BUILD_DIR || '.next', serverExternalPackages: ['pg', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'typebox'], poweredByHeader: false, devIndicators: false };
export default config;
