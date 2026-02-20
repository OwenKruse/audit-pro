import type { Metadata } from 'next';
import { IBM_Plex_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { LeftNav } from './_components/LeftNav';
import { RunnerPanel } from './_components/RunnerPanel';
import { TopBar } from './_components/TopBar';
import { WorkbenchTabs } from './_components/WorkbenchTabs';
import { ResizableLayout } from './_components/ResizableLayout';
import { TooltipProvider } from '@/components/ui/tooltip';

const display = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-display',
});

const mono = IBM_Plex_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-code',
});

export const metadata: Metadata = {
  title: 'AuditPro | Smart Contract Security Workbench',
  description: 'AI-powered smart contract audit workbench with real-time agent collaboration.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body className="min-h-dvh max-h-screen overflow-hidden">
        <TooltipProvider>
        <div className="flex h-screen max-h-screen flex-col bg-[color:var(--cs-bg)] text-[color:var(--cs-fg)] overflow-hidden">
          <TopBar />
          <ResizableLayout>
            <LeftNav />
            <section className="flex min-h-0 min-w-0 flex-1 flex-col border-y border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] xl:border-x xl:border-y-0">
              <WorkbenchTabs />
              <main className="min-h-0 flex-1 overflow-auto">{children}</main>
            </section>
            <RunnerPanel />
          </ResizableLayout>
        </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
