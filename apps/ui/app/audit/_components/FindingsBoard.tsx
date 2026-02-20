'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  CreateFindingResponseSchema,
  ListFindingsResponseSchema,
  UpdateFindingResponseSchema,
  type ScannerFinding,
  type ScannerFindingStatus,
} from '@cipherscope/proto';
import { useCallback, useEffect, useMemo, useState } from 'react';

const statusOrder: ScannerFindingStatus[] = ['open', 'triaged', 'resolved'];

const severityClass: Record<ScannerFinding['severity'], string> = {
  info: 'text-sky-500',
  low: 'text-emerald-500',
  medium: 'text-amber-500',
  high: 'text-rose-500',
  critical: 'text-red-500',
};

type DraftState = {
  title: string;
  summary: string;
  remediation: string;
  severity: ScannerFinding['severity'];
  status: ScannerFindingStatus;
  confidence: string;
  reproducibility: string;
  tags: string;
};

export function FindingsBoard() {
  const searchParams = useSearchParams();
  const initialMessageId = searchParams.get('messageId') ?? '';

  const [findings, setFindings] = useState<ScannerFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  
  const [showCreate, setShowCreate] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formSeverity, setFormSeverity] = useState<ScannerFinding['severity']>('medium');

  const loadFindings = useCallback(async () => {
    try {
      const res = await fetch('/api/findings?limit=1000', { cache: 'no-store' });
      const json = await res.json();
      const parsed = ListFindingsResponseSchema.safeParse(json);
      if (parsed.success) setFindings(parsed.data.items);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFindings(); }, [loadFindings]);

  const selected = useMemo(() => findings.find(f => f.id === selectedId), [findings, selectedId]);

  useEffect(() => {
    if (selected) {
      setDraft({
        title: selected.title,
        summary: selected.summary,
        remediation: selected.remediation,
        severity: selected.severity,
        status: selected.status,
        confidence: String(selected.confidence),
        reproducibility: selected.reproducibility.join('\n'),
        tags: selected.tags.join(', '),
      });
    }
  }, [selected]);

  const saveDraft = async () => {
    if (!selected || !draft) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/findings/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          confidence: Number(draft.confidence) || 0.8,
          reproducibility: draft.reproducibility.split('\n').filter(Boolean),
          tags: draft.tags.split(',').map(t => t.trim()).filter(Boolean),
        }),
      });
      const json = await res.json();
      const parsed = UpdateFindingResponseSchema.safeParse(json);
      if (parsed.success) {
        setFindings(prev => prev.map(f => f.id === parsed.data.item.id ? parsed.data.item : f));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const createFinding = async () => {
    try {
      const res = await fetch('/api/findings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: formTitle || 'New Finding',
          severity: formSeverity,
          status: 'open',
          checkId: 'manual.custom',
          mode: 'passive',
          confidence: 0.8,
          summary: '',
          remediation: '',
          reproducibility: [],
          tags: [],
          evidence: initialMessageId ? [{ messageId: initialMessageId, field: 'request', note: '', replayVariantId: null }] : []
        }),
      });
      const json = await res.json();
      const parsed = CreateFindingResponseSchema.safeParse(json);
      if (parsed.success) {
        setFindings(prev => [parsed.data.item, ...prev]);
        setSelectedId(parsed.data.item.id);
        setShowCreate(false);
        setFormTitle('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <div className="flex items-center justify-between border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5">
        <div className="flex items-center gap-3">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Audit Findings</h3>
          <button 
            onClick={() => setShowCreate(!showCreate)}
            className="h-6 rounded-md bg-[color:var(--cs-accent)] px-2 text-[10px] font-bold text-white hover:bg-blue-600 shadow-sm"
          >
            + New Finding
          </button>
        </div>
        <div className="text-[10px] uppercase font-bold text-[color:var(--cs-muted)]">
          {findings.length} Findings Total
        </div>
      </div>

      {showCreate && (
        <div className="flex items-center gap-3 bg-[color:var(--cs-panel)] p-3 border-b border-[color:var(--cs-border)]">
          <input
            type="text"
            placeholder="Finding title..."
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            className="h-8 flex-1 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
          />
          <select 
            value={formSeverity}
            onChange={(e) => setFormSeverity(e.target.value as any)}
            className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
          >
            <option value="info">Info</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
          <button onClick={createFinding} className="h-8 px-4 bg-[color:var(--cs-accent)] text-white font-bold text-[12px] rounded-md">Create</button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="w-[480px] border-r border-[color:var(--cs-border)] overflow-auto bg-[color:var(--cs-panel-soft)]">
          <div className="divide-y divide-[color:var(--cs-border)]">
            {statusOrder.map(status => (
              <div key={status} className="flex flex-col">
                <div className="px-3 py-1 bg-[color:var(--cs-panel-soft)] text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)] border-b border-[color:var(--cs-border)] flex justify-between">
                  <span>{status}</span>
                  <span>{findings.filter(f => f.status === status).length}</span>
                </div>
                {findings.filter(f => f.status === status).map(finding => (
                  <div
                    key={finding.id}
                    onClick={() => setSelectedId(finding.id)}
                    className={[
                      'p-3 cursor-pointer transition-colors border-b last:border-0 border-[color:var(--cs-border)]',
                      selectedId === finding.id ? 'bg-[color:var(--cs-accent-soft)]' : 'bg-[color:var(--cs-panel)] hover:bg-[color:var(--cs-hover)]'
                    ].join(' ')}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className={['text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-current', severityClass[finding.severity]].join(' ')}>
                        {finding.severity}
                      </span>
                      <span className="text-[10px] font-mono text-[color:var(--cs-muted)]">
                        {new Date(finding.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="text-[12px] font-bold text-[color:var(--cs-fg)] leading-tight">{finding.title}</div>
                    <div className="mt-1 text-[11px] text-[color:var(--cs-muted)] line-clamp-2">{finding.summary || 'No summary provided.'}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto bg-[color:var(--cs-panel)] flex flex-col p-4">
          {selected && draft ? (
            <div className="max-w-3xl space-y-6">
              <div className="space-y-4">
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  className="w-full text-xl font-bold bg-transparent border-none outline-none text-[color:var(--cs-fg)] placeholder:text-[color:var(--cs-muted)]"
                  placeholder="Untitled Finding"
                />
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Severity</label>
                    <select
                      value={draft.severity}
                      onChange={(e) => setDraft({ ...draft, severity: e.target.value as any })}
                      className="w-full h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none"
                    >
                      <option value="info">Info</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Status</label>
                    <select
                      value={draft.status}
                      onChange={(e) => setDraft({ ...draft, status: e.target.value as any })}
                      className="w-full h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none"
                    >
                      <option value="open">Open</option>
                      <option value="triaged">Triaged</option>
                      <option value="resolved">Resolved</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Summary</label>
                  <textarea
                    value={draft.summary}
                    onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                    className="w-full h-32 p-3 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] text-[13px] outline-none resize-none"
                    placeholder="Describe the vulnerability..."
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Remediation</label>
                  <textarea
                    value={draft.remediation}
                    onChange={(e) => setDraft({ ...draft, remediation: e.target.value })}
                    className="w-full h-32 p-3 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] text-[13px] outline-none resize-none"
                    placeholder="Provide a fix recommendation..."
                  />
                </div>

                {selected.evidence.length > 0 && (
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Evidence</label>
                    <div className="flex flex-col gap-2">
                      {selected.evidence.map(ev => (
                        <div key={ev.messageId} className="p-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] flex items-center justify-between">
                          <span className="text-[11px] font-mono text-[color:var(--cs-muted)]">{ev.messageId}</span>
                          <Link href={`/history?search=${ev.messageId}`} className="text-[10px] font-bold text-[color:var(--cs-accent)] hover:underline">View in History</Link>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-[color:var(--cs-border)]">
                <button
                  onClick={saveDraft}
                  disabled={saving}
                  className="px-6 h-9 rounded-md bg-[color:var(--cs-accent)] text-white font-bold text-[13px] shadow-lg shadow-blue-500/20 hover:scale-[1.02] active:scale-[0.98] transition-all"
                >
                  {saving ? 'Saving...' : 'Save Finding'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[color:var(--cs-muted)] text-[13px]">
              {loading ? 'Loading findings...' : 'Select a finding to edit details'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
