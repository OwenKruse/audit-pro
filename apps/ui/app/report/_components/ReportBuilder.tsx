'use client';

import {
  ListFindingsResponseSchema,
  type ScannerFinding,
  type ScannerFindingStatus,
} from '@cipherscope/proto';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const severityWeight: Record<ScannerFinding['severity'], number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRedactionTerms(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function applyRedactions(text: string, terms: string[]): string {
  let out = text;
  for (const term of terms) {
    out = out.replace(new RegExp(escapeRegExp(term), 'gi'), '[REDACTED]');
  }
  return out;
}

function redactUnknown(value: unknown, terms: string[]): unknown {
  if (typeof value === 'string') return applyRedactions(value, terms);
  if (Array.isArray(value)) return value.map((v) => redactUnknown(v, terms));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactUnknown(v, terms);
    return out;
  }
  return value;
}

function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    const raw = line.trimEnd();
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      closeList();
      if (!inCode) {
        out.push('<pre><code>');
        inCode = true;
      } else {
        out.push('</code></pre>');
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      out.push(`${escapeHtml(raw)}\n`);
      continue;
    }

    if (!trimmed) {
      closeList();
      continue;
    }

    if (trimmed.startsWith('- ')) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${escapeHtml(trimmed.slice(2))}</li>`);
      continue;
    }

    closeList();
    if (trimmed.startsWith('### ')) {
      out.push(`<h3>${escapeHtml(trimmed.slice(4))}</h3>`);
    } else if (trimmed.startsWith('## ')) {
      out.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`);
    } else if (trimmed.startsWith('# ')) {
      out.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`);
    } else {
      out.push(`<p>${escapeHtml(trimmed)}</p>`);
    }
  }

  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function downloadBlob(fileName: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

function fmtTime(iso: string): string {
  const dt = new Date(iso);
  return Number.isFinite(dt.getTime()) ? dt.toLocaleString() : iso;
}

function buildMarkdown(input: {
  title: string;
  executiveSummary: string;
  scope: string;
  methodology: string;
  findings: ScannerFinding[];
}): string {
  const lines: string[] = [
    `# ${input.title}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Executive Summary',
    input.executiveSummary || '_Add summary._',
    '',
    '## Scope',
    input.scope || '_Add scope._',
    '',
    '## Methodology',
    input.methodology || '_Add methodology._',
    '',
    `## Findings (${input.findings.length})`,
    '',
  ];

  for (const finding of input.findings) {
    lines.push(`### [${finding.severity.toUpperCase()}] ${finding.title}`);
    lines.push(`- ID: ${finding.id}`);
    lines.push(`- Status: ${finding.status}`);
    lines.push(`- Confidence: ${finding.confidence.toFixed(2)}`);
    lines.push(`- Check: ${finding.checkId} (${finding.mode})`);
    if (finding.tags.length) lines.push(`- Tags: ${finding.tags.join(', ')}`);
    lines.push(`- Created: ${finding.createdAt}`);
    lines.push('');
    lines.push(finding.summary || '_No summary provided._');
    lines.push('');
    lines.push('Remediation:');
    lines.push(finding.remediation || '_No remediation provided._');
    lines.push('');
    lines.push('Evidence:');
    for (const ev of finding.evidence) {
      lines.push(`- ${ev.messageId} @ ${ev.field}: ${ev.note}`);
    }
    if (finding.reproducibility.length) {
      lines.push('');
      lines.push('Reproducibility:');
      for (const step of finding.reproducibility) lines.push(`- ${step}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function ReportBuilder() {
  const [findings, setFindings] = useState<ScannerFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [initializedSelection, setInitializedSelection] = useState(false);

  const [title, setTitle] = useState('CipherScope Security Findings Report');
  const [executiveSummary, setExecutiveSummary] = useState('');
  const [scope, setScope] = useState('');
  const [methodology, setMethodology] = useState(
    'Traffic capture, scanner checks, replay validation, and manual review.',
  );
  const [redactions, setRedactions] = useState('');

  const [severityFilter, setSeverityFilter] = useState('_');
  const [statusFilter, setStatusFilter] = useState('_');
  const [searchQuery, setSearchQuery] = useState('');

  const loadFindings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/findings?limit=1000', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const parsed = ListFindingsResponseSchema.safeParse(json);
      if (!parsed.success) throw new Error('Unexpected findings payload.');
      const ordered = [...parsed.data.items].sort((a, b) => {
        const bySeverity = severityWeight[b.severity] - severityWeight[a.severity];
        if (bySeverity !== 0) return bySeverity;
        return b.createdAt.localeCompare(a.createdAt);
      });
      setFindings(ordered);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load findings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFindings();
  }, [loadFindings]);

  useEffect(() => {
    if (initializedSelection || !findings.length) return;
    setSelectedIds(new Set(findings.map((f) => f.id)));
    setInitializedSelection(true);
  }, [findings, initializedSelection]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return findings.filter((finding) => {
      if (severityFilter !== '_' && finding.severity !== severityFilter) return false;
      if (statusFilter !== '_' && finding.status !== statusFilter) return false;
      if (!q) return true;
      if (finding.title.toLowerCase().includes(q)) return true;
      if (finding.summary.toLowerCase().includes(q)) return true;
      if (finding.checkId.toLowerCase().includes(q)) return true;
      return finding.evidence.some((ev) => ev.messageId.toLowerCase().includes(q));
    });
  }, [findings, searchQuery, severityFilter, statusFilter]);

  const selectedFindings = useMemo(
    () => findings.filter((item) => selectedIds.has(item.id)),
    [findings, selectedIds],
  );

  const redactionTerms = useMemo(() => parseRedactionTerms(redactions), [redactions]);

  const redactedMarkdown = useMemo(() => {
    const markdown = buildMarkdown({
      title,
      executiveSummary,
      scope,
      methodology,
      findings: selectedFindings,
    });
    return applyRedactions(markdown, redactionTerms);
  }, [executiveSummary, methodology, redactionTerms, scope, selectedFindings, title]);

  const htmlBody = useMemo(() => markdownToHtml(redactedMarkdown), [redactedMarkdown]);

  const htmlDocument = useMemo(
    () =>
      [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width,initial-scale=1" />',
        `<title>${escapeHtml(title)}</title>`,
        '<style>',
        'body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;max-width:980px;margin:0 auto;padding:32px;line-height:1.5;color:#111827;}',
        'h1{font-size:28px;margin:0 0 12px;} h2{font-size:20px;margin:22px 0 10px;} h3{font-size:16px;margin:18px 0 8px;}',
        'p,li{font-size:14px;} ul{padding-left:20px;} pre{background:#f3f4f6;padding:12px;border-radius:8px;overflow:auto;}',
        '</style>',
        '</head>',
        '<body>',
        htmlBody,
        '</body>',
        '</html>',
      ].join('\n'),
    [htmlBody, title],
  );

  const evidenceBundle = useMemo(
    () => ({
      generatedAt: new Date().toISOString(),
      redactions: redactionTerms,
      report: {
        title: applyRedactions(title, redactionTerms),
        executiveSummary: applyRedactions(executiveSummary, redactionTerms),
        scope: applyRedactions(scope, redactionTerms),
        methodology: applyRedactions(methodology, redactionTerms),
      },
      findings: redactUnknown(selectedFindings, redactionTerms),
    }),
    [executiveSummary, methodology, redactionTerms, scope, selectedFindings, title],
  );

  const toggleFinding = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const selectAllFiltered = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of filtered) next.add(item.id);
      return next;
    });
  }, [filtered]);

  const clearAllFiltered = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of filtered) next.delete(item.id);
      return next;
    });
  }, [filtered]);

  const exportHtml = useCallback(() => {
    downloadBlob('cipherscope-report.html', htmlDocument, 'text/html;charset=utf-8');
  }, [htmlDocument]);

  const exportEvidence = useCallback(() => {
    downloadBlob(
      'cipherscope-evidence-bundle.json',
      `${JSON.stringify(evidenceBundle, null, 2)}\n`,
      'application/json;charset=utf-8',
    );
  }, [evidenceBundle]);

  const printPdf = useCallback(() => {
    const win = window.open('', '_blank', 'noopener,noreferrer,width=1000,height=900');
    if (!win) return;
    win.document.open();
    win.document.write(htmlDocument);
    win.document.close();
    win.focus();
    win.print();
  }, [htmlDocument]);

  const byStatus = useMemo(() => {
    const out: Record<ScannerFindingStatus, number> = { open: 0, triaged: 0, resolved: 0 };
    for (const finding of selectedFindings) out[finding.status] += 1;
    return out;
  }, [selectedFindings]);

  return (
    <div className="flex flex-col gap-2">
      <section className="border-b border-[color:var(--cs-border)] pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3 text-xs text-[color:var(--cs-muted)]">
            <span>Selected {selectedFindings.length}</span>
            <span>Open {byStatus.open}</span>
            <span>Triaged {byStatus.triaged}</span>
            <span>Resolved {byStatus.resolved}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={() => void loadFindings()} disabled={loading}>
              Refresh
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={exportEvidence}>
              Export JSON
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={printPdf}>
              Print PDF
            </Button>
            <Button type="button" size="sm" onClick={exportHtml}>
              Export HTML
            </Button>
          </div>
        </div>
        {loadError ? (
          <div className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-200">
            {loadError}
          </div>
        ) : null}
      </section>

      <section className="grid grid-cols-1 gap-2 xl:grid-cols-[1.3fr_1fr]">
        <div className="flex flex-col gap-2">
          <div className="border-b border-[color:var(--cs-border)] pb-2">
            <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">
              Report sections
            </div>
            <label className="mt-1.5 block text-xs text-[color:var(--cs-muted)]">
              title
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-0.5 h-8 text-sm" />
            </label>
            <label className="mt-1.5 block text-xs text-[color:var(--cs-muted)]">
              executive summary
              <textarea
                value={executiveSummary}
                onChange={(e) => setExecutiveSummary(e.target.value)}
                className="mt-0.5 h-20 w-full rounded border border-input bg-transparent px-2 py-1.5 text-sm outline-none"
                placeholder="High-level findings and business impact."
              />
            </label>
            <label className="mt-1.5 block text-xs text-[color:var(--cs-muted)]">
              scope
              <textarea
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="mt-0.5 h-16 w-full rounded border border-input bg-transparent px-2 py-1.5 text-sm outline-none"
                placeholder="Targets, dates, and environment."
              />
            </label>
            <label className="mt-1.5 block text-xs text-[color:var(--cs-muted)]">
              methodology
              <textarea
                value={methodology}
                onChange={(e) => setMethodology(e.target.value)}
                className="mt-0.5 h-16 w-full rounded border border-input bg-transparent px-2 py-1.5 text-sm outline-none"
                placeholder="How validation and testing was performed."
              />
            </label>
            <label className="mt-1.5 block text-xs text-[color:var(--cs-muted)]">
              redaction terms (comma or newline)
              <textarea
                value={redactions}
                onChange={(e) => setRedactions(e.target.value)}
                className="mt-0.5 h-14 w-full rounded border border-input bg-transparent px-2 py-1.5 text-xs font-mono outline-none"
                placeholder="0xabc..., api key"
              />
            </label>
          </div>

          <div className="border-b border-[color:var(--cs-border)] pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">
                Findings
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8 w-48 text-xs"
                  placeholder="title, check id..."
                />
                <select
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  className="h-8 rounded border border-input bg-transparent px-2 text-xs"
                >
                  <option value="_">severity</option>
                  <option value="info">info</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="h-8 rounded border border-input bg-transparent px-2 text-xs"
                >
                  <option value="_">status</option>
                  <option value="open">open</option>
                  <option value="triaged">triaged</option>
                  <option value="resolved">resolved</option>
                </select>
                <Button type="button" variant="ghost" size="sm" onClick={selectAllFiltered}>
                  All
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={clearAllFiltered}>
                  None
                </Button>
              </div>
            </div>
            <div className="mt-1.5 max-h-[400px] overflow-auto rounded border border-[color:var(--cs-border)]">
              {loading ? (
                <div className="px-2 py-2 text-xs text-[color:var(--cs-muted)]">Loading…</div>
              ) : filtered.length ? (
                <div className="flex flex-col">
                  {filtered.map((finding) => (
                    <label
                      key={finding.id}
                      className="flex cursor-pointer items-start gap-2 border-b border-[color:var(--cs-border)] px-2 py-1.5 last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(finding.id)}
                        onChange={(e) => toggleFinding(finding.id, e.target.checked)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px]">{finding.status}</Badge>
                          <Badge className="text-[10px] capitalize">{finding.severity}</Badge>
                          <span className="font-mono text-[10px] text-[color:var(--cs-muted)]">
                            {finding.confidence.toFixed(2)}
                          </span>
                        </div>
                        <div className="text-xs font-medium">{finding.title}</div>
                        <div className="line-clamp-1 text-[11px] text-[color:var(--cs-muted)]">
                          {finding.checkId} · {finding.evidence.length} evidence · {fmtTime(finding.createdAt)}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="px-2 py-2 text-xs text-[color:var(--cs-muted)]">No findings match filters.</div>
              )}
            </div>
          </div>
        </div>

        <div className="border-b border-[color:var(--cs-border)] pb-2">
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">Preview</div>
          <div className="mt-1.5 max-h-[800px] overflow-auto rounded border border-[color:var(--cs-border)] p-2">
            <div
              className="prose prose-sm max-w-none dark:prose-invert"
              dangerouslySetInnerHTML={{ __html: htmlBody }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

