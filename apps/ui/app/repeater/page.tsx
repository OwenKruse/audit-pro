import { Suspense } from 'react';
import { RepeaterWorkbench } from './_components/RepeaterWorkbench';

export default function RepeaterPage() {
  return (
    <div className="flex h-full flex-col">
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center text-[13px] text-[color:var(--cs-muted)]">
            Loading…
          </div>
        }
      >
        <RepeaterWorkbench />
      </Suspense>
    </div>
  );
}
