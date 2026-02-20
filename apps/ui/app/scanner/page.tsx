import { ScannerWorkbench } from './_components/ScannerWorkbench';

export default function ScannerPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scanner</h1>
        <div className="mt-1 text-sm text-[color:var(--cs-muted)]">
          Run passive checks and guarded active validation probes across captured traffic.
        </div>
      </div>
      <ScannerWorkbench />
    </div>
  );
}
