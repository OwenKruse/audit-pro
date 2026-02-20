'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AiProvider } from '@cipherscope/proto';

export type AiSettings = {
  provider: AiProvider;
  openaiModel: string;
  openrouterModel: string;
  geminiModel: string;
  grokModel: string;
  claudeModel: string;
  deepseekModel: string;
};

const AI_SETTINGS_STORAGE_KEY = 'cipherscope.ai.settings.v1';
const AI_SETTINGS_EVENT = 'cipherscope:ai-settings:changed';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'openai',
  openaiModel: 'gpt-4.1-mini',
  openrouterModel: 'openai/gpt-4o-mini',
  geminiModel: 'gemini-2.0-flash',
  grokModel: 'grok-2-latest',
  claudeModel: 'claude-3-5-sonnet-latest',
  deepseekModel: 'deepseek-chat',
};

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function dispatchSettingsChanged(): void {
  if (!hasWindow()) return;
  window.dispatchEvent(new Event(AI_SETTINGS_EVENT));
}

function readJson<T>(key: string): T | null {
  if (!hasWindow()) return null;
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function asModel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const out = value.trim();
  return out ? out : fallback;
}

function asProvider(value: unknown, fallback: AiProvider): AiProvider {
  if (
    value === 'openai' ||
    value === 'openrouter' ||
    value === 'gemini' ||
    value === 'grok' ||
    value === 'claude' ||
    value === 'deepseek'
  ) {
    return value;
  }
  return fallback;
}

function parseAiSettings(raw: unknown): AiSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_AI_SETTINGS;
  const rec = raw as Record<string, unknown>;
  return {
    provider: asProvider(rec.provider, DEFAULT_AI_SETTINGS.provider),
    openaiModel: asModel(rec.openaiModel, DEFAULT_AI_SETTINGS.openaiModel),
    openrouterModel: asModel(rec.openrouterModel, DEFAULT_AI_SETTINGS.openrouterModel),
    geminiModel: asModel(rec.geminiModel, DEFAULT_AI_SETTINGS.geminiModel),
    grokModel: asModel(rec.grokModel, DEFAULT_AI_SETTINGS.grokModel),
    claudeModel: asModel(rec.claudeModel, DEFAULT_AI_SETTINGS.claudeModel),
    deepseekModel: asModel(rec.deepseekModel, DEFAULT_AI_SETTINGS.deepseekModel),
  };
}

function readSettings(): AiSettings {
  return parseAiSettings(readJson<unknown>(AI_SETTINGS_STORAGE_KEY));
}

export function getSelectedAiModel(settings: AiSettings): string {
  switch (settings.provider) {
    case 'openrouter':
      return settings.openrouterModel;
    case 'gemini':
      return settings.geminiModel;
    case 'grok':
      return settings.grokModel;
    case 'claude':
      return settings.claudeModel;
    case 'deepseek':
      return settings.deepseekModel;
    case 'openai':
    default:
      return settings.openaiModel;
  }
}

export function useAiSettings() {
  const [settings, setSettingsState] = useState<AiSettings>(DEFAULT_AI_SETTINGS);

  useEffect(() => {
    setSettingsState(readSettings());

    if (!hasWindow()) return;
    const onStorageEvent = () => setSettingsState(readSettings());
    window.addEventListener(AI_SETTINGS_EVENT, onStorageEvent);
    return () => window.removeEventListener(AI_SETTINGS_EVENT, onStorageEvent);
  }, []);

  const setSettings = useCallback((next: AiSettings) => {
    const normalized = parseAiSettings(next);
    writeJson(AI_SETTINGS_STORAGE_KEY, normalized);
    setSettingsState(normalized);
    dispatchSettingsChanged();
  }, []);

  return { settings, setSettings };
}
