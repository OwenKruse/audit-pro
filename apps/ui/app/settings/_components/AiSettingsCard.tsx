'use client';

import type { AiProvider } from '@cipherscope/proto';
import { useEffect, useState, type FormEvent } from 'react';
import {
  DEFAULT_AI_SETTINGS,
  getSelectedAiModel,
  useAiSettings,
  type AiSettings,
} from '@/lib/ai-settings';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type InlineStatus = { ok: boolean; message: string };

const inputClass =
  'h-7 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]';
const btnClass =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50';

const PROVIDER_OPTIONS: Array<{ value: AiProvider; label: string; envHint: string }> = [
  { value: 'openai', label: 'OpenAI', envHint: 'Requires OPENAI_API_KEY' },
  { value: 'openrouter', label: 'OpenRouter', envHint: 'Requires OPENROUTER_API_KEY' },
  { value: 'gemini', label: 'Gemini', envHint: 'Requires GEMINI_API_KEY' },
  { value: 'grok', label: 'Grok (xAI)', envHint: 'Requires GROK_API_KEY or XAI_API_KEY' },
  { value: 'claude', label: 'Claude (Anthropic)', envHint: 'Requires CLAUDE_API_KEY or ANTHROPIC_API_KEY' },
  { value: 'deepseek', label: 'DeepSeek', envHint: 'Requires DEEPSEEK_API_KEY' },
];

function providerModelField(provider: AiProvider): keyof AiSettings {
  switch (provider) {
    case 'openrouter':
      return 'openrouterModel';
    case 'gemini':
      return 'geminiModel';
    case 'grok':
      return 'grokModel';
    case 'claude':
      return 'claudeModel';
    case 'deepseek':
      return 'deepseekModel';
    case 'openai':
    default:
      return 'openaiModel';
  }
}

export function AiSettingsCard() {
  const { settings, setSettings } = useAiSettings();
  const [draft, setDraft] = useState<AiSettings>(settings);
  const [status, setStatus] = useState<InlineStatus | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  function onModelChange(nextValue: string): void {
    const key = providerModelField(draft.provider);
    setDraft((prev) => ({ ...prev, [key]: nextValue }));
  }

  function onResetDefaults(): void {
    setDraft(DEFAULT_AI_SETTINGS);
    setStatus(null);
  }

  function onSave(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    try {
      setSettings(draft);
      setStatus({ ok: true, message: 'AI provider/model settings saved.' });
    } catch (err) {
      setStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to save AI settings.',
      });
    }
  }

  const activeModel = getSelectedAiModel(draft);
  const providerMeta = PROVIDER_OPTIONS.find((item) => item.value === draft.provider) ?? PROVIDER_OPTIONS[0];

  return (
    <div className="border-b border-[color:var(--cs-border)]">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        AI Models
      </div>
      <div className="space-y-2 px-3 py-2">
        <p className="text-[11px] text-[color:var(--cs-muted)]">
          Select the AI provider and model used by Agent Chat.
        </p>

        <form className="grid grid-cols-1 gap-2 md:grid-cols-2" onSubmit={onSave}>
          <label className="block">
            <div className="mb-0.5 text-[11px] text-[color:var(--cs-muted)]">Provider</div>
            <Select
              value={draft.provider}
              onValueChange={(value) => setDraft((prev) => ({ ...prev, provider: value as AiProvider }))}
            >
              <SelectTrigger className="h-7 w-full border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="block">
            <div className="mb-0.5 text-[11px] text-[color:var(--cs-muted)]">Model ({providerMeta.label})</div>
            <input
              className={inputClass}
              value={activeModel}
              onChange={(e) => onModelChange(e.target.value)}
              placeholder="Enter model id"
              spellCheck={false}
            />
          </label>

          <div className="md:col-span-2 flex flex-wrap items-center gap-2">
            <button type="submit" className={btnClass}>
              Save AI Settings
            </button>
            <button type="button" className={btnClass} onClick={onResetDefaults}>
              Reset Defaults
            </button>
            <span className="text-[11px] text-[color:var(--cs-muted)]">{providerMeta.envHint}</span>
          </div>
        </form>

        {status ? (
          <div
            className={[
              'rounded-md px-2 py-1 text-[11px]',
              status.ok ? 'bg-emerald-500/10 text-emerald-600' : 'bg-rose-500/10 text-rose-600',
            ].join(' ')}
          >
            {status.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}
