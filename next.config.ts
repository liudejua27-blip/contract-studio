import type { NextConfig } from 'next';
const config: NextConfig = { distDir: process.env.CONTRACT_BUILD_DIR || '.next', serverExternalPackages: ['pg'], poweredByHeader: false, devIndicators: false };
export default config;
