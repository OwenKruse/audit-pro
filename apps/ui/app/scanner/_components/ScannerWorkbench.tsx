'use client';

import Link from 'next/link';
import {
  ListScannerFindingsResponseSchema,
  ScannerRunResponseSchema,
  type ScannerFinding,
  type ScannerRunResponse,
} from '@cipherscope/proto';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const severityClass: Record<ScannerFinding['severity'], string> = {
  info: 'bg-sky-500/15 text-sky-300',
  low: 'bg-emerald-500/15 text-emerald-300',
  medium: 'bg-amber-500/15 text-amber-200',
  high: 'bg-rose-500/15 text-rose-200',
  critical: 'bg-red-600/20 text-red-200',
};

function fmtTime(iso: string): string {
  const dt = new Date(iso);
  return Number.isFinite(dt.getTime()) ? dt.toLocaleString() : iso;
}

function toScanLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 250;
  return Math.min(2000, Math.max(1, Math.floor(n)));
}

export function ScannerWorkbench() {
  const [findings, setFindings] = useState<ScannerFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<ScannerRunResponse | null>(null);
  const [includeActive, setIncludeActive] = useState(false);
  const [scanLimit, setScanLimit] = useState('250');

  const [severityFilter, setSeverityFilter] = useState('_');
  const [modeFilter, setModeFilter] = useState('_');
  const [searchQuery, setSearchQuery] = useState('');

  const loadFindings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/scanner/findings?limit=500', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const parsed = ListScannerFindingsResponseSchema.safeParse(json);
      if (!parsed.success) throw new Error('Unexpected scanner findings payload.');
      setFindings(parsed.data.items);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load scanner findings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFindings();
  }, [loadFindings]);

  const filteredFindings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return findings.filter((finding) => {
      if (severityFilter !== '_' && finding.severity !== severityFilter) return false;
      if (modeFilter !== '_' && finding.mode !== modeFilter) return false;
      if (!q) return true;
      if (finding.title.toLowerCase().includes(q)) return true;
      if (finding.summary.toLowerCase().includes(q)) return true;
      if (finding.checkId.toLowerCase().includes(q)) return true;
      return finding.evidence.some((ev) => ev.messageId.toLowerCase().includes(q));
    });
  }, [findings, modeFilter, searchQuery, severityFilter]);

  const runScan = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch('/api/scanner/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          includeActive,
          limit: toScanLimit(scanLimit),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (json as { error?: { message?: unknown } } | null)?.error?.message;
        throw new Error(typeof msg === 'string' ? msg : `Scanner run failed (${res.status}).`);
      }

      const parsed = ScannerRunResponseSchema.safeParse(json);
      if (!parsed.success) throw new Error('Unexpected scanner run payload.');
      setLastRun(parsed.data);
      setFindings(parsed.data.findings);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Scanner run failed.');
    } finally {
      setRunning(false);
    }
  }, [includeActive, scanLimit]);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 p-4 dark:bg-black/30">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-widest text-[color:var(--cs-muted)]">Scanner</div>
            <h2 className="mt-2 text-sm font-semibold">Passive checks + guardrailed active probes</h2>
            <p className="mt-2 text-sm text-[color:var(--cs-muted)]">
              Passive checks analyze captured traffic only. Active probes replay safe invalid-input mutations
              on likely auth/signature validation endpoints and never generate exploit payloads.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex items-center gap-2 rounded-lg border border-[color:var(--cs-border)] bg-white/50 px-3 py-2 text-xs text-[color:var(--cs-muted)] dark:bg-black/30">
              <input
                type="checkbox"
                checked={includeActive}
                onChange={(e) => setIncludeActive(e.target.checked)}
              />
              include active probes
            </label>
            <label className="flex items-center gap-2 text-xs text-[color:var(--cs-muted)]">
              scan limit
              <Input
                value={scanLimit}
                onChange={(e) => setScanLimit(e.target.value)}
                className="h-9 w-[92px] font-mono text-xs"
                inputMode="numeric"
              />
            </label>
            <Button type="button" onClick={() => void runScan()} disabled={running}>
              {running ? 'Running…' : 'Run scan'}
            </Button>
            <Button type="button" variant="outline" onClick={() => void loadFindings()} disabled={loading}>
              Refresh
            </Button>
          </div>
        </div>
        {runError ? (
          <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
            {runError}
          </div>
        ) : null}
      </section>

      {lastRun ? (
        <section className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-6">
          <MetricCard label="Run id" value={lastRun.runId.slice(0, 8)} />
          <MetricCard label="Scanned" value={lastRun.summary.scannedMessages} />
          <MetricCard label="Passive checks" value={lastRun.summary.passiveChecks} />
          <MetricCard label="Active checks" value={lastRun.summary.activeChecks} />
          <MetricCard label="Findings" value={lastRun.summary.findingsTotal} />
          <MetricCard
            label="High/Critical"
            value={lastRun.summary.bySeverity.high + lastRun.summary.bySeverity.critical}
          />
        </section>
      ) : null}

      <section className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 p-4 dark:bg-black/30">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[color:var(--cs-muted)]">Severity</span>
            <Select value={severityFilter} onValueChange={setSeverityFilter}>
              <SelectTrigger className="h-9 w-[140px]">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_">All</SelectItem>
                <SelectItem value="info">info</SelectItem>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
                <SelectItem value="critical">critical</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-[color:var(--cs-muted)]">Mode</span>
            <Select value={modeFilter} onValueChange={setModeFilter}>
              <SelectTrigger className="h-9 w-[130px]">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_">All</SelectItem>
                <SelectItem value="passive">passive</SelectItem>
                <SelectItem value="active">active</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-[color:var(--cs-muted)]">Search</span>
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-[280px]"
              placeholder="title, check id, message id..."
            />
          </div>
        </div>

        {loading ? (
          <div className="mt-4 text-sm text-[color:var(--cs-muted)]">Loading scanner findings…</div>
        ) : loadError ? (
          <div className="mt-4 text-sm text-rose-300">{loadError}</div>
        ) : filteredFindings.length ? (
          <div className="mt-4 rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Severity
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Mode
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Check
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Finding
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Evidence
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Time
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredFindings.map((finding) => (
                  <TableRow key={finding.id}>
                    <TableCell>
                      <Badge className={severityClass[finding.severity]}>{finding.severity}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {finding.mode}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[180px] truncate font-mono text-[11px] text-muted-foreground">
                      {finding.checkId}
                    </TableCell>
                    <TableCell className="max-w-[420px] whitespace-normal">
                      <div className="text-xs font-medium">{finding.title}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{finding.summary}</div>
                      <details className="mt-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">repro + remediation</summary>
                        <div className="mt-1 space-y-1">
                          <div>{finding.remediation}</div>
                          {finding.reproducibility.map((step) => (
                            <div key={`${finding.id}-${step}`}>- {step}</div>
                          ))}
                        </div>
                      </details>
                    </TableCell>
                    <TableCell className="max-w-[280px] whitespace-normal">
                      <div className="space-y-1">
                        {finding.evidence.slice(0, 3).map((ev) => (
                          <div key={`${finding.id}-${ev.messageId}-${ev.field}`} className="text-[11px]">
                            <Link
                              href={`/history/${ev.messageId}`}
                              className="font-mono underline decoration-muted-foreground/30 underline-offset-4 hover:decoration-muted-foreground"
                            >
                              {ev.messageId.slice(0, 8)}…
                            </Link>{' '}
                            <span className="text-muted-foreground">{ev.field}</span>
                            <div className="text-muted-foreground">{ev.note}</div>
                            {ev.replayVariantId ? (
                              <Link
                                href={`/repeater/${ev.replayVariantId}`}
                                className="font-mono text-[10px] underline decoration-muted-foreground/30 underline-offset-4 hover:decoration-muted-foreground"
                              >
                                variant {ev.replayVariantId.slice(0, 8)}…
                              </Link>
                            ) : null}
                          </div>
                        ))}
                        {finding.evidence.length > 3 ? (
                          <div className="text-[11px] text-muted-foreground">
                            +{finding.evidence.length - 3} more evidence entries
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {fmtTime(finding.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="mt-4 text-sm text-[color:var(--cs-muted)]">
            No scanner findings yet. Run a scan from this page.
          </div>
        )}
      </section>
    </div>
  );
}

function MetricCard(props: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 p-3 dark:bg-black/30">
      <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">{props.label}</div>
      <div className="mt-1 font-mono text-xs">{props.value}</div>
    </div>
  );
}
