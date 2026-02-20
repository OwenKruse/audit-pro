'use client';

import { Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RepeaterClient } from './RepeaterClient';
import type { HttpMessageDetail } from '@cipherscope/proto';

type Tab = { id: string; messageId: string | null; label: string };

const STORAGE_KEY = 'repeater-tabs';

function loadTabs(): Tab[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Tab[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTabs(tabs: Tab[]) {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
  } catch {
    // ignore
  }
}

function tabLabel(m: HttpMessageDetail): string {
  const path = m.path?.length > 40 ? `${m.path.slice(0, 40)}…` : m.path ?? '/';
  return `${m.method} ${path}`;
}

export function RepeaterWorkbench() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openParam = searchParams.get('open');

  const [tabs, setTabs] = useState<Tab[]>(() => {
    const stored = loadTabs();
    if (stored.length > 0) return stored;
    return [{ id: crypto.randomUUID(), messageId: null, label: 'New Request' }];
  });
  const [activeId, setActiveId] = useState<string>(() => tabs[0]?.id ?? crypto.randomUUID());
  const [messages, setMessages] = useState<Record<string, HttpMessageDetail>>({});

  // Sync activeId when tabs change (e.g. close active tab)
  useEffect(() => {
    const exists = tabs.some((t) => t.id === activeId);
    if (!exists && tabs.length > 0) {
      setActiveId(tabs[0].id);
    } else if (tabs.length === 0) {
      const newTab: Tab = { id: crypto.randomUUID(), messageId: null, label: 'New Request' };
      setTabs([newTab]);
      setActiveId(newTab.id);
    }
  }, [tabs, activeId]);

  useEffect(() => {
    saveTabs(tabs);
  }, [tabs]);

  // Fetch messages for tabs that need them (restored from sessionStorage)
  useEffect(() => {
    const toFetch = tabs.filter((t) => t.messageId && !messages[t.messageId!]);
    toFetch.forEach((tab) => {
      const mid = tab.messageId!;
      fetch(`/api/messages/${encodeURIComponent(mid)}`)
        .then((r) => r.json())
        .then((res) => {
          const item = res?.item as HttpMessageDetail | undefined;
          if (item) {
            setMessages((prev) => ({ ...prev, [mid]: item }));
          }
        })
        .catch(() => {});
    });
  }, [tabs]);

  // Handle ?open=messageId from URL (e.g. from Call History "Open in Repeater")
  useEffect(() => {
    if (!openParam) return;
    const messageId = openParam.trim();
    if (!messageId) return;

    fetch(`/api/messages/${encodeURIComponent(messageId)}`)
      .then((r) => r.json())
      .then((res) => {
        const item = res?.item as HttpMessageDetail | undefined;
        if (!item) return;

        setMessages((prev) => ({ ...prev, [messageId]: item }));

        const newTab: Tab = {
          id: crypto.randomUUID(),
          messageId,
          label: tabLabel(item),
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveId(newTab.id);
      })
      .catch(() => {})
      .finally(() => {
        router.replace('/repeater', { scroll: false });
      });
  }, [openParam, router]);

  const addTab = useCallback(() => {
    const newTab: Tab = { id: crypto.randomUUID(), messageId: null, label: 'New Request' };
    setTabs((prev) => [...prev, newTab]);
    setActiveId(newTab.id);
  }, []);

  const closeTab = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setTabs((prev) => prev.filter((t) => t.id !== id));
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      {/* Tab bar */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1">
        <button
          type="button"
          onClick={addTab}
          className="inline-flex h-8 w-8 items-center justify-center rounded text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)] hover:text-[color:var(--cs-fg)]"
          title="New tab"
        >
          <Plus className="h-4 w-4" />
        </button>
        <div className="ml-1 flex flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeId;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveId(tab.id)}
                className={[
                  'group flex max-w-[200px] items-center gap-1 rounded-t-lg border-b-2 px-3 py-1.5 text-[13px] font-medium transition-all',
                  isActive
                    ? 'border-[color:var(--cs-accent)] bg-[color:var(--cs-panel)] text-[color:var(--cs-accent)]'
                    : 'border-transparent text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)] hover:text-[color:var(--cs-fg)]',
                ].join(' ')}
              >
                <span className="truncate">{tab.label}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => closeTab(e, tab.id)}
                  onKeyDown={(e) => e.key === 'Enter' && closeTab(e as unknown as React.MouseEvent, tab.id)}
                  className={[
                    'rounded p-0.5',
                    isActive
                      ? 'opacity-70 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10'
                      : 'opacity-0 group-hover:opacity-70 hover:opacity-100',
                  ].join(' ')}
                  aria-label="Close tab"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content - render all tabs to preserve state, only show active */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tabs.map((tab) => {
          const baseline = tab.messageId ? messages[tab.messageId] ?? null : null;
          const loading = tab.messageId !== null && baseline === null;
          const isActive = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={isActive ? 'flex h-full min-h-0 flex-col overflow-hidden' : 'hidden'}
            >
              <RepeaterClient baseline={baseline} loading={loading} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
