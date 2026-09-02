import type { Metadata } from 'next';
import './globals.css';
import { Navbar } from '@/components/Navbar';

export const metadata: Metadata = {
  title: 'BoundPay - Bounded Financial Authority for Agentic Commerce',
  description: 'Deterministic policy evaluation and bounded financial authority for autonomous agent shopping.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-slate-50 min-h-screen text-slate-900 flex flex-col antialiased">
        <Navbar />
        <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
          {children}
        </main>
        <footer className="border-t border-slate-200 bg-white py-4 text-center text-xs text-slate-500">
          BoundPay Phase 3 Evaluation Build &bull; Mode is shown from server configuration &bull; Integer-paise authority
        </footer>
      </body>
    </html>
  );
}
