import { FindingsBoard } from './_components/FindingsBoard';
import { Suspense } from 'react';

export default function AuditPage() {
  return (
    <div className="flex h-full flex-col">
      <Suspense
        fallback={
          <div className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-3 text-xs text-[color:var(--cs-muted)]">
            Analyzing security findings…
          </div>
        }
      >
        <FindingsBoard />
      </Suspense>
    </div>
  );
}
