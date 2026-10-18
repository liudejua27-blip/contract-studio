import type { Metadata } from 'next';
import './globals.css';
import './workspace.css';
export const metadata: Metadata = { title: '合同工作室 · 对话起草，律师审阅', description: '通过对话起草合同，生成 Word，提交专业律师审阅。' };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="zh-CN"><body>{children}</body></html>; }
