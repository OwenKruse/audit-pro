'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const WORKBENCH_TABS: Array<{ href: string; label: string }> = [
  { href: '/repeater', label: 'HTTP Repeater' },
  { href: '/', label: 'Contract Sandbox' },
  { href: '/inspector', label: 'Contract Inspector' },
  { href: '/explorer', label: 'DEX Explorer' },
  { href: '/zoomeye', label: 'Host Search' },
  { href: '/history', label: 'Call History' },
  { href: '/audit', label: 'Security Audit' },
  { href: '/gas', label: 'Gas Profiler' },
  { href: '/fuzzer', label: 'Fuzzer' },
  { href: '/payloads', label: 'Payloads' },
  { href: '/intruder', label: 'Intruder' },
];

export function WorkbenchTabs() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3">
      <ul className="flex items-center gap-1 overflow-x-auto py-1">
        {WORKBENCH_TABS.map((tab) => {
          const isActive = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.label}>
              <Link
                href={tab.href}
                className={[
                  'inline-flex min-w-max items-center rounded-t-lg border-b-2 px-3 py-1.5 text-[13px] font-medium transition-all',
                  isActive
                    ? 'border-[color:var(--cs-accent)] text-[color:var(--cs-accent)]'
                    : 'border-transparent text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]',
                ].join(' ')}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
