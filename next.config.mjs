/** @type {import('next').NextConfig} */
const config = { distDir: process.env.CONTRACT_BUILD_DIR || '.next', serverExternalPackages: ['pdfjs-dist', 'pg', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'typebox'], poweredByHeader: false, devIndicators: false };
export default config;
