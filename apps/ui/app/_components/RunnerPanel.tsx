'use client';

import {
  AiChatResponseSchema,
  type AiAgentMode,
} from '@cipherscope/proto';
import {
  AlertTriangle,
  Copy,
  Hammer,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Settings,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { ChatMarkdown } from '@/components/ui/chat-markdown';
import { Textarea } from '@/components/ui/textarea';
import { getSelectedAiModel, useAiSettings } from '@/lib/ai-settings';
import {
  buildReferenceToken,
  extractReferenceIds,
  RUNNER_REFERENCE_EVENT,
  type RunnerReferenceDetail,
} from '@/lib/chat-references';

type RunnerTabId = 'chat' | 'risks' | 'tools';

type ChatRole = 'user' | 'assistant';

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

type ToolCallEntry = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  error: string | null;
  createdAt: string;
};

type ChatItem =
  | { kind: 'message'; id: string; createdAt: string; message: ChatMessage }
  | { kind: 'tool'; id: string; createdAt: string; tool: ToolCallEntry };

type ModeLabel =
  | 'Smart Contract Audit'
  | 'Static Analysis'
  | 'Symbolic Execution'
  | 'Fuzzing Campaign';

type ChatConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  mode: ModeLabel;
  maxSteps: string;
  statusLine: string;
  messages: ChatMessage[];
  toolCalls: ToolCallEntry[];
};

type RunnerConversationStore = {
  selectedConversationId: string;
  conversations: ChatConversation[];
};

type HttpMessageReferenceDetail = {
  id: string;
  method: string;
  url: string;
  createdAt: string;
  state: string;
  responseStatus: number | null;
  totalMs: number | null;
  request?: {
    headers?: unknown;
    cookies?: unknown;
    query?: unknown;
    bodyText?: string | null;
    bodyBase64?: string | null;
    bodyJson?: unknown;
  };
  response?: {
    headers?: unknown;
    bodyText?: string | null;
    bodyBase64?: string | null;
    bodyJson?: unknown;
  };
  error?: string | null;
};

type AiChatStreamEvent =
  | {
      type: 'run_started';
      createdAt: string;
      mode: string;
      provider: string;
      model: string;
      maxSteps: number;
    }
  | {
      type: 'thinking';
      createdAt: string;
      step: number;
      maxSteps: number;
      message: string;
    }
  | {
      type: 'status';
      createdAt: string;
      message: string;
    }
  | {
      type: 'tool_call_started';
      createdAt: string;
      step: number;
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_call_completed';
      createdAt: string;
      step: number;
      id: string;
      name: string;
      args: Record<string, unknown>;
      ok: boolean;
      summary: string;
      error: string | null;
    }
  | {
      type: 'warning';
      createdAt: string;
      message: string;
    }
  | {
      type: 'done';
      createdAt: string;
      response: unknown;
    }
  | {
      type: 'error';
      createdAt: string;
      error: {
        code: string;
        message: string;
      };
    };

const RUNNER_TABS: Array<{
  id: RunnerTabId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { id: 'chat', label: 'Agent Chat', icon: MessageSquare },
  { id: 'risks', label: 'Security Risks', icon: AlertTriangle },
  { id: 'tools', label: 'Tools', icon: Hammer },
];

const MODE_TO_AGENT: Record<ModeLabel, AiAgentMode> = {
  'Smart Contract Audit': 'smart_contract_audit',
  'Static Analysis': 'static_analysis',
  'Symbolic Execution': 'symbolic_execution',
  'Fuzzing Campaign': 'fuzzing_campaign',
};

const RUNNER_CONVERSATION_STORAGE_KEY = 'cipherscope.runner.conversations.v1';
const DEFAULT_MODE: ModeLabel = 'Smart Contract Audit';
const DEFAULT_MAX_STEPS = '250';
const DEFAULT_STATUS_LINE = 'Idle.';
const MAX_CONVERSATIONS = 30;
const MAX_REFERENCES_PER_PROMPT = 8;
const MAX_REFERENCE_SNIPPET_CHARS = 700;
const AGENT_RETRY_MAX_ATTEMPTS = 8;
const AGENT_RETRY_BASE_DELAY_MS = 1000;
const AGENT_RETRY_MAX_DELAY_MS = 10000;
const MAX_LIVE_TRACE_LINES = 10;
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_TOOL_CALLS: ToolCallEntry[] = [];

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort);
  });
}

function parseApiError(json: unknown, status: number): { code: string | null; message: string } {
  const rec = asRecord(json);
  const err = asRecord(rec?.error);
  const code = typeof err?.code === 'string' ? err.code : null;
  const message = typeof err?.message === 'string' ? err.message : `Agent chat failed (${status}).`;
  return { code, message };
}

function isAgentUnreachableError(code: string | null, message: string): boolean {
  return code === 'agent_unreachable' || /agent is unreachable/i.test(message);
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

function formatConversationStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function shortJson(value: unknown, max = 240): string {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= max) return raw;
    return `${raw.slice(0, max - 3)}...`;
  } catch {
    const raw = String(value);
    if (raw.length <= max) return raw;
    return `${raw.slice(0, max - 3)}...`;
  }
}

class StreamUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamUnsupportedError';
  }
}

function upsertToolCallEntry(entries: ToolCallEntry[], next: ToolCallEntry): ToolCallEntry[] {
  const idx = entries.findIndex((entry) => entry.id === next.id);
  if (idx < 0) return [...entries, next];
  const out = entries.slice();
  out[idx] = { ...out[idx], ...next, args: next.args };
  return out;
}

function mergeFinalToolCalls(
  existing: ToolCallEntry[],
  incoming: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    ok: boolean;
    summary: string;
    error: string | null;
  }>,
  createdAt: string,
): ToolCallEntry[] {
  let next = existing.slice();
  for (const call of incoming) {
    const existingEntry = next.find((entry) => entry.id === call.id);
    next = upsertToolCallEntry(next, {
      id: call.id,
      name: call.name,
      args: call.args,
      ok: call.ok,
      summary: call.summary,
      error: call.error,
      createdAt: existingEntry?.createdAt ?? createdAt,
    });
  }
  return next;
}

function appendTraceLine(lines: string[], line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return lines;
  const next = [...lines, trimmed];
  if (next.length <= MAX_LIVE_TRACE_LINES) return next;
  return next.slice(next.length - MAX_LIVE_TRACE_LINES);
}

type SsePacket = { event: string | null; data: string };

function parseSsePacket(block: string): SsePacket | null {
  const normalized = block.replaceAll('\r', '');
  const lines = normalized.split('\n');
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim() || null;
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
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
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage write errors should not break the panel.
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asDateString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const out = Math.trunc(value);
  return out > 0 ? out : null;
}

function parseAiChatStreamEvent(raw: unknown): AiChatStreamEvent | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const type = asString(rec.type, '');
  const createdAt = asDateString(rec.createdAt, new Date().toISOString());

  if (type === 'run_started') {
    const model = asString(rec.model, '').trim();
    const provider = asString(rec.provider, '').trim();
    const mode = asString(rec.mode, '').trim();
    const maxSteps = asPositiveInt(rec.maxSteps);
    if (!model || !provider || !mode || maxSteps == null) return null;
    return { type, createdAt, mode, provider, model, maxSteps };
  }

  if (type === 'thinking') {
    const message = asString(rec.message, '').trim();
    const step = asPositiveInt(rec.step);
    const maxSteps = asPositiveInt(rec.maxSteps);
    if (!message || step == null || maxSteps == null) return null;
    return { type, createdAt, step, maxSteps, message };
  }

  if (type === 'status') {
    const message = asString(rec.message, '').trim();
    if (!message) return null;
    return { type, createdAt, message };
  }

  if (type === 'tool_call_started') {
    const id = asString(rec.id, '').trim();
    const name = asString(rec.name, '').trim();
    const step = asPositiveInt(rec.step);
    const args = asRecord(rec.args) ?? {};
    if (!id || !name || step == null) return null;
    return { type, createdAt, step, id, name, args };
  }

  if (type === 'tool_call_completed') {
    const id = asString(rec.id, '').trim();
    const name = asString(rec.name, '').trim();
    const step = asPositiveInt(rec.step);
    const args = asRecord(rec.args) ?? {};
    const ok = rec.ok !== false;
    const summary = asString(rec.summary, '').trim();
    const error = rec.error == null ? null : asString(rec.error, '');
    if (!id || !name || step == null || !summary) return null;
    return { type, createdAt, step, id, name, args, ok, summary, error };
  }

  if (type === 'warning') {
    const message = asString(rec.message, '').trim();
    if (!message) return null;
    return { type, createdAt, message };
  }

  if (type === 'done') {
    return { type, createdAt, response: rec.response };
  }

  if (type === 'error') {
    const err = asRecord(rec.error);
    const code = asString(err?.code, '').trim();
    const message = asString(err?.message, '').trim();
    if (!code || !message) return null;
    return { type, createdAt, error: { code, message } };
  }

  return null;
}

function normalizeMode(value: unknown): ModeLabel {
  if (
    value === 'Smart Contract Audit' ||
    value === 'Static Analysis' ||
    value === 'Symbolic Execution' ||
    value === 'Fuzzing Campaign'
  ) {
    return value;
  }
  return DEFAULT_MODE;
}

function makeWelcomeMessage(createdAt = new Date().toISOString()): ChatMessage {
  return {
    id: createId(),
    role: 'assistant',
    content:
      'Autonomous security agent is live. Ask me to inspect call history, replay traffic, analyze contracts, or generate payloads.',
    createdAt,
  };
}

function conversationTitleFromMessages(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((item) => item.role === 'user');
  if (!firstUserMessage) return 'New Chat';
  const normalized = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'New Chat';
  return normalized.length > 44 ? `${normalized.slice(0, 44)}...` : normalized;
}

function createConversation(createdAt = new Date().toISOString()): ChatConversation {
  const messages = [makeWelcomeMessage(createdAt)];
  return {
    id: createId(),
    title: conversationTitleFromMessages(messages),
    createdAt,
    updatedAt: createdAt,
    mode: DEFAULT_MODE,
    maxSteps: DEFAULT_MAX_STEPS,
    statusLine: DEFAULT_STATUS_LINE,
    messages,
    toolCalls: [],
  };
}

function buildAgentDiagnosticMessage(input: {
  status: 'completed' | 'max_steps';
  warnings: string[];
  toolCalls: Array<{ name: string; ok: boolean; error: string | null; summary: string }>;
}): string | null {
  const lines: string[] = [];

  if (input.status === 'max_steps') {
    lines.push('- Agent reached max autonomous steps before clean completion.');
  }

  const failedTools = input.toolCalls.filter((call) => !call.ok);
  if (failedTools.length > 0) {
    lines.push(`- ${failedTools.length} tool call${failedTools.length === 1 ? '' : 's'} failed:`);
    for (const call of failedTools.slice(0, 5)) {
      const detail = call.error ?? call.summary;
      lines.push(`  - ${call.name}: ${detail}`);
    }
    if (failedTools.length > 5) {
      lines.push(`  - ...and ${failedTools.length - 5} more`);
    }
  }

  if (input.warnings.length > 0) {
    lines.push('- Warnings:');
    for (const warning of input.warnings.slice(0, 5)) {
      lines.push(`  - ${warning}`);
    }
    if (input.warnings.length > 5) {
      lines.push(`  - ...and ${input.warnings.length - 5} more`);
    }
  }

  if (lines.length === 0) return null;
  return `Agent log\n${lines.join('\n')}`;
}

function normalizeChatMessage(raw: unknown): ChatMessage | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const role = rec.role === 'user' || rec.role === 'assistant' ? rec.role : null;
  const content = asString(rec.content, '').trim();
  if (!role || !content) return null;
  const nowIso = new Date().toISOString();
  return {
    id: asString(rec.id, createId()),
    role,
    content,
    createdAt: asDateString(rec.createdAt, nowIso),
  };
}

function normalizeToolCall(raw: unknown): ToolCallEntry | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const name = asString(rec.name, '').trim();
  if (!name) return null;
  const args = asRecord(rec.args) ?? {};
  const nowIso = new Date().toISOString();
  return {
    id: asString(rec.id, createId()),
    name,
    args,
    ok: rec.ok !== false,
    summary: asString(rec.summary, ''),
    error: rec.error == null ? null : asString(rec.error, ''),
    createdAt: asDateString(rec.createdAt, nowIso),
  };
}

function normalizeConversation(raw: unknown): ChatConversation | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const messages =
    Array.isArray(rec.messages) ?
      rec.messages.map((item) => normalizeChatMessage(item)).filter((item): item is ChatMessage => item != null)
    : [];
  const toolCalls =
    Array.isArray(rec.toolCalls) ?
      rec.toolCalls.map((item) => normalizeToolCall(item)).filter((item): item is ToolCallEntry => item != null)
    : [];
  const createdAt = asDateString(rec.createdAt, new Date().toISOString());
  const updatedAt = asDateString(rec.updatedAt, createdAt);
  const safeMessages = messages.length > 0 ? messages : [makeWelcomeMessage(createdAt)];
  return {
    id: asString(rec.id, createId()),
    title: conversationTitleFromMessages(safeMessages),
    createdAt,
    updatedAt,
    mode: normalizeMode(rec.mode),
    maxSteps: asString(rec.maxSteps, DEFAULT_MAX_STEPS),
    statusLine: asString(rec.statusLine, DEFAULT_STATUS_LINE),
    messages: safeMessages,
    toolCalls,
  };
}

function normalizeConversationStore(raw: unknown): RunnerConversationStore | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const conversations =
    Array.isArray(rec.conversations) ?
      rec.conversations
        .map((item) => normalizeConversation(item))
        .filter((item): item is ChatConversation => item != null)
    : [];
  if (conversations.length === 0) return null;
  conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selectedConversationId = asString(rec.selectedConversationId, conversations[0].id);
  const selectedExists = conversations.some((item) => item.id === selectedConversationId);
  return {
    selectedConversationId: selectedExists ? selectedConversationId : conversations[0].id,
    conversations: conversations.slice(0, MAX_CONVERSATIONS),
  };
}

function loadConversationStore(): RunnerConversationStore {
  const parsed = normalizeConversationStore(readJson<unknown>(RUNNER_CONVERSATION_STORAGE_KEY));
  if (parsed) return parsed;
  const seed = createConversation();
  return {
    selectedConversationId: seed.id,
    conversations: [seed],
  };
}

function saveConversationStore(store: RunnerConversationStore): void {
  writeJson(RUNNER_CONVERSATION_STORAGE_KEY, store);
}

function trimForPrompt(input: string, maxChars: number): string {
  const text = input.trim();
  if (!text) return '(empty)';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

function toPromptText(value: unknown, maxChars = MAX_REFERENCE_SNIPPET_CHARS): string {
  if (value == null) return '(empty)';
  if (typeof value === 'string') return trimForPrompt(value, maxChars);
  try {
    return trimForPrompt(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return trimForPrompt(String(value), maxChars);
  }
}

function formatReferenceBody(input: {
  bodyJson?: unknown;
  bodyText?: string | null;
  bodyBase64?: string | null;
}): string {
  if (input.bodyJson != null) return toPromptText(input.bodyJson);
  if (typeof input.bodyText === 'string') return toPromptText(input.bodyText);
  if (typeof input.bodyBase64 === 'string') return toPromptText(input.bodyBase64);
  return '(empty)';
}

function appendReferenceToken(prompt: string, referenceId: string): string {
  const token = buildReferenceToken(referenceId);
  if (!referenceId.trim()) return prompt;
  if (prompt.includes(token)) return prompt;
  const normalized = prompt.trimEnd();
  if (!normalized) return token;
  return `${normalized} ${token}`;
}

async function loadMessageReference(referenceId: string): Promise<HttpMessageReferenceDetail | null> {
  try {
    const res = await fetch(`/api/messages/${encodeURIComponent(referenceId)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { item?: unknown } | null;
    const item = asRecord(json?.item);
    if (!item) return null;
    const method = asString(item.method, '').trim();
    const url = asString(item.url, '').trim();
    if (!method || !url) return null;
    return {
      id: asString(item.id, referenceId),
      method,
      url,
      createdAt: asDateString(item.createdAt, new Date().toISOString()),
      state: asString(item.state, 'unknown'),
      responseStatus: typeof item.responseStatus === 'number' ? item.responseStatus : null,
      totalMs: typeof item.totalMs === 'number' ? item.totalMs : null,
      request: asRecord(item.request) ?? undefined,
      response: asRecord(item.response) ?? undefined,
      error: item.error == null ? null : asString(item.error, ''),
    };
  } catch {
    return null;
  }
}

async function withReferenceContext(prompt: string): Promise<string> {
  const referenceIds = extractReferenceIds(prompt).slice(0, MAX_REFERENCES_PER_PROMPT);
  if (referenceIds.length === 0) return prompt;

  const rows = await Promise.all(
    referenceIds.map(async (referenceId) => ({
      referenceId,
      detail: await loadMessageReference(referenceId),
    })),
  );

  const lines: string[] = ['Referenced HTTP context:'];
  for (const row of rows) {
    if (!row.detail) {
      lines.push(`- ${buildReferenceToken(row.referenceId)} not found in call history.`);
      continue;
    }
    const detail = row.detail;
    const statusPart = detail.responseStatus == null ? '-' : String(detail.responseStatus);
    const timingPart = detail.totalMs == null ? '-' : `${detail.totalMs.toFixed(1)}ms`;
    lines.push(
      `- ${buildReferenceToken(detail.id)} ${detail.method} ${detail.url} | status=${statusPart} state=${detail.state} total=${timingPart}`,
    );
    lines.push(`  request.headers: ${toPromptText(detail.request?.headers)}`);
    lines.push(`  request.query: ${toPromptText(detail.request?.query)}`);
    lines.push(`  request.cookies: ${toPromptText(detail.request?.cookies)}`);
    lines.push(`  request.body: ${formatReferenceBody(detail.request ?? {})}`);
    lines.push(`  response.headers: ${toPromptText(detail.response?.headers)}`);
    lines.push(`  response.body: ${formatReferenceBody(detail.response ?? {})}`);
    if (detail.error) {
      lines.push(`  error: ${toPromptText(detail.error)}`);
    }
  }

  if (extractReferenceIds(prompt).length > MAX_REFERENCES_PER_PROMPT) {
    lines.push(
      `- Additional references were omitted (max ${MAX_REFERENCES_PER_PROMPT} per prompt).`,
    );
  }

  return `${prompt}\n\n${lines.join('\n')}`;
}

export function RunnerPanel() {
  const [activeTab, setActiveTab] = useState<RunnerTabId>('chat');
  const [conversationStore, setConversationStore] = useState<RunnerConversationStore>({
    selectedConversationId: '',
    conversations: [],
  });
  const [conversationsReady, setConversationsReady] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [liveTraceConversationId, setLiveTraceConversationId] = useState<string | null>(null);
  const [liveTraceLines, setLiveTraceLines] = useState<string[]>([]);
  const { settings: aiSettings } = useAiSettings();

  async function copyMessageContent(content: string, messageId: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // ignore
    }
  }

  const abortRef = useRef<AbortController | null>(null);
  const runningConversationIdRef = useRef<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const { conversations, selectedConversationId } = conversationStore;
  const selectedConversation = useMemo(() => {
    if (conversations.length === 0) return null;
    return conversations.find((item) => item.id === selectedConversationId) ?? conversations[0];
  }, [conversations, selectedConversationId]);

  const messages = selectedConversation?.messages ?? EMPTY_MESSAGES;
  const toolCalls = selectedConversation?.toolCalls ?? EMPTY_TOOL_CALLS;
  const maxSteps = selectedConversation?.maxSteps ?? DEFAULT_MAX_STEPS;
  const statusLine = selectedConversation?.statusLine ?? DEFAULT_STATUS_LINE;
  const aiProvider = aiSettings.provider;
  const aiModel = getSelectedAiModel(aiSettings);
  const visibleLiveTrace =
    busy && selectedConversation && selectedConversation.id === liveTraceConversationId ? liveTraceLines : [];

  function updateConversation(
    id: string,
    updater: (conversation: ChatConversation) => ChatConversation,
    updatedAt = new Date().toISOString(),
  ): void {
    setConversationStore((prev) => {
      let matched = false;
      const nextConversations = prev.conversations.map((conversation) => {
        if (conversation.id !== id) return conversation;
        matched = true;
        const next = updater(conversation);
        return {
          ...next,
          title: conversationTitleFromMessages(next.messages),
          updatedAt,
        };
      });

      if (!matched) return prev;

      nextConversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const trimmedConversations = nextConversations.slice(0, MAX_CONVERSATIONS);
      const selectedStillExists = trimmedConversations.some(
        (item) => item.id === prev.selectedConversationId,
      );
      return {
        selectedConversationId: selectedStillExists ? prev.selectedConversationId : trimmedConversations[0].id,
        conversations: trimmedConversations,
      };
    });
  }

  function updateSelectedConversation(
    updater: (conversation: ChatConversation) => ChatConversation,
    updatedAt?: string,
  ): void {
    if (!selectedConversation) return;
    updateConversation(selectedConversation.id, updater, updatedAt);
  }

  function appendLiveTrace(conversationId: string, line: string): void {
    setLiveTraceConversationId((prev) => (prev === conversationId ? prev : conversationId));
    setLiveTraceLines((prev) => appendTraceLine(prev, line));
  }

  function clearLiveTrace(conversationId?: string): void {
    if (conversationId && liveTraceConversationId && liveTraceConversationId !== conversationId) return;
    setLiveTraceLines([]);
    setLiveTraceConversationId(null);
  }

  function upsertConversationToolCall(
    conversationId: string,
    toolCall: ToolCallEntry,
    updatedAt = toolCall.createdAt,
  ): void {
    updateConversation(
      conversationId,
      (prev) => ({
        ...prev,
        toolCalls: upsertToolCallEntry(prev.toolCalls, toolCall),
      }),
      updatedAt,
    );
  }

  function createNewConversation(): void {
    if (!conversationsReady || busy) return;
    const now = new Date().toISOString();
    const freshConversation = createConversation(now);
    setConversationStore((prev) => ({
      selectedConversationId: freshConversation.id,
      conversations: [freshConversation, ...prev.conversations].slice(0, MAX_CONVERSATIONS),
    }));
    setPrompt('');
    clearLiveTrace();
    setActiveTab('chat');
  }

  function selectConversation(id: string): void {
    if (!conversationsReady || busy) return;
    setConversationStore((prev) => {
      if (prev.selectedConversationId === id) return prev;
      if (!prev.conversations.some((item) => item.id === id)) return prev;
      return { ...prev, selectedConversationId: id };
    });
    setPrompt('');
    clearLiveTrace();
    setActiveTab('chat');
  }

  useEffect(() => {
    setConversationStore(loadConversationStore());
    setConversationsReady(true);
  }, []);

  useEffect(() => {
    if (!conversationsReady) return;
    saveConversationStore(conversationStore);
  }, [conversationStore, conversationsReady]);

  useEffect(() => {
    if (!hasWindow()) return;
    const onReference = (event: Event) => {
      const detail = (event as CustomEvent<RunnerReferenceDetail>).detail;
      const referenceId =
        detail && typeof detail.referenceId === 'string' ? detail.referenceId.trim() : '';
      if (!referenceId) return;
      setPrompt((prev) => appendReferenceToken(prev, referenceId));
      setActiveTab('chat');
    };

    window.addEventListener(RUNNER_REFERENCE_EVENT, onReference as EventListener);
    return () => window.removeEventListener(RUNNER_REFERENCE_EVENT, onReference as EventListener);
  }, []);

  useEffect(() => {
    if (activeTab !== 'chat') return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeTab, messages, toolCalls, busy, liveTraceLines, selectedConversationId]);

  const toolFailures = useMemo(() => toolCalls.filter((item) => !item.ok), [toolCalls]);

  const inferredRisks = useMemo(() => {
    const out: Array<{ severity: 'High' | 'Medium' | 'Low'; title: string }> = [];
    for (const call of toolCalls) {
      if (call.name === 'run_scanner' || call.name === 'run_contract_audit') {
        const match = call.summary.match(/(\d+) findings?/i);
        const findings = match ? Number(match[1]) : 0;
        if (findings > 0) {
          out.push({
            severity: findings >= 5 ? 'High' : findings >= 2 ? 'Medium' : 'Low',
            title: `${call.name} reported ${findings} findings`,
          });
        }
      }
    }

    for (const failure of toolFailures.slice(0, 3)) {
      out.push({
        severity: 'Medium',
        title: `Tool failure: ${failure.name}`,
      });
    }

    return out.slice(0, 8);
  }, [toolCalls, toolFailures]);

  const chatItems = useMemo((): ChatItem[] => {
    const items: ChatItem[] = [
      ...messages.map((message) => ({
        kind: 'message' as const,
        id: message.id,
        createdAt: message.createdAt,
        message,
      })),
      ...toolCalls.map((tool) => ({
        kind: 'tool' as const,
        id: `tool_${tool.id}`,
        createdAt: tool.createdAt,
        tool,
      })),
    ];

    items.sort((a, b) => {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
      if (a.kind !== b.kind) return a.kind === 'tool' ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

    return items;
  }, [messages, toolCalls]);

  function applyCompletedRun(
    conversationId: string,
    parsed: ReturnType<typeof AiChatResponseSchema.parse>,
  ): void {
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content: parsed.assistant.content,
      createdAt: parsed.assistant.createdAt,
    };
    const diagnosticContent = buildAgentDiagnosticMessage({
      status: parsed.status,
      warnings: parsed.warnings,
      toolCalls: parsed.toolCalls,
    });
    const diagnosticMessage: ChatMessage | null =
      diagnosticContent ?
        {
          id: createId(),
          role: 'assistant',
          content: diagnosticContent,
          createdAt: parsed.assistant.createdAt,
        }
      : null;

    const lastTool = parsed.toolCalls.at(-1);
    const failureCount = parsed.toolCalls.filter((call) => !call.ok).length;
    const baseStatus =
      parsed.status === 'completed'
        ? 'Run complete.'
        : 'Run hit max autonomous steps.';
    updateConversation(
      conversationId,
      (prev) => ({
        ...prev,
        messages: diagnosticMessage ?
            [...prev.messages, assistantMessage, diagnosticMessage]
          : [...prev.messages, assistantMessage],
        toolCalls: mergeFinalToolCalls(prev.toolCalls, parsed.toolCalls, parsed.assistant.createdAt),
        statusLine:
          failureCount > 0 ?
            `${baseStatus} ${failureCount} tool call${failureCount === 1 ? '' : 's'} failed.`
          : lastTool ?
            `${baseStatus} Last action: ${lastTool.summary}`
          : baseStatus,
      }),
      parsed.assistant.createdAt,
    );
  }

  async function runPromptLegacy(
    requestBody: Record<string, unknown>,
    conversationId: string,
    controller: AbortController,
  ): Promise<ReturnType<typeof AiChatResponseSchema.parse>> {
    let parsed: ReturnType<typeof AiChatResponseSchema.parse> | null = null;
    for (let attempt = 1; attempt <= AGENT_RETRY_MAX_ATTEMPTS; attempt += 1) {
      let res: Response;
      try {
        res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        if (attempt >= AGENT_RETRY_MAX_ATTEMPTS) {
          throw new Error(
            `Agent is unreachable after ${AGENT_RETRY_MAX_ATTEMPTS} reconnect attempts. Start it with "pnpm dev" and retry.`,
          );
        }
        const retryDelayMs = Math.min(
          AGENT_RETRY_MAX_DELAY_MS,
          AGENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        );
        const retryInSec = Math.max(1, Math.round(retryDelayMs / 1000));
        updateConversation(conversationId, (prev) => ({
          ...prev,
          statusLine: `Agent unreachable. Reconnecting (${attempt}/${AGENT_RETRY_MAX_ATTEMPTS}) - retrying in ${retryInSec}s...`,
        }));
        await delayWithSignal(retryDelayMs, controller.signal);
        continue;
      }

      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const apiError = parseApiError(json, res.status);
        if (
          isAgentUnreachableError(apiError.code, apiError.message) &&
          attempt < AGENT_RETRY_MAX_ATTEMPTS
        ) {
          const retryDelayMs = Math.min(
            AGENT_RETRY_MAX_DELAY_MS,
            AGENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          );
          const retryInSec = Math.max(1, Math.round(retryDelayMs / 1000));
          updateConversation(conversationId, (prev) => ({
            ...prev,
            statusLine: `Agent unreachable. Reconnecting (${attempt}/${AGENT_RETRY_MAX_ATTEMPTS}) - retrying in ${retryInSec}s...`,
          }));
          await delayWithSignal(retryDelayMs, controller.signal);
          continue;
        }
        throw new Error(apiError.message);
      }

      parsed = AiChatResponseSchema.parse(json);
      break;
    }

    if (!parsed) {
      throw new Error('Agent did not return a response after reconnect attempts.');
    }

    return parsed;
  }

  async function runPromptStreaming(
    requestBody: Record<string, unknown>,
    conversationId: string,
    controller: AbortController,
  ): Promise<ReturnType<typeof AiChatResponseSchema.parse>> {
    let res: Response;
    try {
      res = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new StreamUnsupportedError('Unable to establish stream connection.');
    }

    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new StreamUnsupportedError('Streaming endpoint is not available on this agent version.');
      }
      const json = (await res.json().catch(() => null)) as unknown;
      const apiError = parseApiError(json, res.status);
      throw new Error(apiError.message);
    }
    if (!res.body) {
      throw new StreamUnsupportedError('Stream endpoint returned no body.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let gotAnyStreamEvent = false;
    let finalResponse: ReturnType<typeof AiChatResponseSchema.parse> | null = null;

    const handleEvent = (event: AiChatStreamEvent): void => {
      gotAnyStreamEvent = true;
      switch (event.type) {
        case 'run_started':
          appendLiveTrace(conversationId, `Run started (${event.provider} / ${event.model}).`);
          updateConversation(conversationId, (prev) => ({
            ...prev,
            statusLine: 'Agent stream connected. Executing...',
          }));
          return;
        case 'thinking':
          appendLiveTrace(conversationId, `[${event.step}/${event.maxSteps}] ${event.message}`);
          updateConversation(conversationId, (prev) => ({
            ...prev,
            statusLine: `Thinking (${event.step}/${event.maxSteps})...`,
          }));
          return;
        case 'status':
          appendLiveTrace(conversationId, event.message);
          updateConversation(conversationId, (prev) => ({ ...prev, statusLine: event.message }));
          return;
        case 'tool_call_started':
          appendLiveTrace(conversationId, `Tool ${event.name} started.`);
          upsertConversationToolCall(conversationId, {
            id: event.id,
            name: event.name,
            args: event.args,
            ok: true,
            summary: 'Running...',
            error: null,
            createdAt: event.createdAt,
          });
          return;
        case 'tool_call_completed':
          appendLiveTrace(
            conversationId,
            `Tool ${event.name} ${event.ok ? 'completed' : 'failed'}: ${event.summary}`,
          );
          upsertConversationToolCall(
            conversationId,
            {
              id: event.id,
              name: event.name,
              args: event.args,
              ok: event.ok,
              summary: event.summary,
              error: event.error,
              createdAt: event.createdAt,
            },
            event.createdAt,
          );
          return;
        case 'warning':
          appendLiveTrace(conversationId, `Warning: ${event.message}`);
          return;
        case 'done':
          finalResponse = AiChatResponseSchema.parse(event.response);
          return;
        case 'error':
          throw new Error(event.error.message);
      }
    };

    const consumeBlock = (block: string): void => {
      const packet = parseSsePacket(block);
      if (!packet) return;
      let raw: unknown;
      try {
        raw = JSON.parse(packet.data) as unknown;
      } catch {
        return;
      }
      const parsedEvent = parseAiChatStreamEvent(raw);
      if (!parsedEvent) return;
      handleEvent(parsedEvent);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        consumeBlock(block);
        boundary = buffer.indexOf('\n\n');
      }
    }

    buffer += decoder.decode().replaceAll('\r\n', '\n');
    const tail = buffer.trim();
    if (tail) consumeBlock(tail);

    if (finalResponse) return finalResponse;
    if (!gotAnyStreamEvent) {
      throw new StreamUnsupportedError('Agent stream ended without events.');
    }
    throw new Error('Agent stream ended before completion.');
  }

  async function submitPrompt(sourcePrompt?: string): Promise<void> {
    const conversation = selectedConversation;
    const text = (sourcePrompt ?? prompt).trim();
    if (!conversation || !text || busy) return;
    const conversationId = conversation.id;

    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };

    const nextMessages = [...conversation.messages, userMessage];
    updateConversation(
      conversationId,
      (prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        statusLine: 'Agent is reasoning and running tools...',
      }),
      userMessage.createdAt,
    );
    setPrompt('');
    setBusy(true);
    setLiveTraceConversationId(conversationId);
    setLiveTraceLines(['Connecting stream...']);
    runningConversationIdRef.current = conversationId;

    const maxStepsNum = Number.parseInt(conversation.maxSteps, 10);
    const boundedMaxSteps = Number.isFinite(maxStepsNum)
      ? Math.min(500, Math.max(1, maxStepsNum))
      : 250;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const agentUserPrompt = await withReferenceContext(userMessage.content);
      const requestBody = {
        mode: MODE_TO_AGENT[conversation.mode],
        maxSteps: boundedMaxSteps,
        provider: aiProvider,
        model: aiModel,
        messages: nextMessages.map((item) => ({
          role: item.role,
          content: item.id === userMessage.id ? agentUserPrompt : item.content,
        })),
      };

      let parsed: ReturnType<typeof AiChatResponseSchema.parse>;
      try {
        parsed = await runPromptStreaming(requestBody, conversationId, controller);
      } catch (err) {
        if (err instanceof StreamUnsupportedError) {
          appendLiveTrace(conversationId, 'Stream unavailable. Falling back to standard mode...');
          parsed = await runPromptLegacy(requestBody, conversationId, controller);
        } else {
          throw err;
        }
      }

      applyCompletedRun(conversationId, parsed);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        updateConversation(conversationId, (prev) => ({ ...prev, statusLine: 'Run paused.' }));
      } else {
        const now = new Date().toISOString();
        const errorText = err instanceof Error ? err.message : 'Failed to run autonomous agent.';
        const isUnreachable = isAgentUnreachableError(null, errorText);
        if (isUnreachable) {
          setPrompt((prev) => (prev.trim() ? prev : text));
        }
        const errorMessage: ChatMessage = {
          id: createId(),
          role: 'assistant',
          content:
            isUnreachable ?
              `Agent log\n- Run paused: ${errorText}\n- Prompt restored. Start the agent, then press Run to continue.`
            : `Agent log\n- Run failed before completion: ${errorText}`,
          createdAt: now,
        };
        updateConversation(
          conversationId,
          (prev) => ({
            ...prev,
            messages: [...prev.messages, errorMessage],
            statusLine:
              isUnreachable ?
                'Agent disconnected. Start it and press Run to resume this prompt.'
              : errorText,
          }),
          now,
        );
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      if (runningConversationIdRef.current === conversationId) {
        runningConversationIdRef.current = null;
      }
      clearLiveTrace(conversationId);
      setBusy(false);
    }
  }

  function onPause() {
    abortRef.current?.abort();
  }

  function onStop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    const targetConversationId = runningConversationIdRef.current ?? selectedConversation?.id ?? null;
    if (targetConversationId) {
      updateConversation(targetConversationId, (prev) => ({ ...prev, statusLine: 'Agent stopped.' }));
      clearLiveTrace(targetConversationId);
    }
    runningConversationIdRef.current = null;
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-y border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] xl:border-y-0 xl:border-l">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-shrink-0 border-b border-[color:var(--cs-border)] px-3 py-2">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-base font-semibold text-[color:var(--cs-fg)]">
              <span
                className={[
                  'h-2 w-2 shrink-0 rounded-full',
                  busy ? 'animate-pulse bg-emerald-500' : 'bg-[color:var(--cs-muted)]',
                ].join(' ')}
              />
              <span className="truncate">{busy ? 'Agent Running' : 'Agent Idle'}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-[color:var(--cs-muted)]">
              <button
                type="button"
                onClick={() => void submitPrompt()}
                disabled={busy || !prompt.trim() || !selectedConversation}
                title="Run"
                className="disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5 cursor-pointer text-emerald-600 hover:text-emerald-500" />
              </button>
              <button
                type="button"
                onClick={onPause}
                disabled={!busy}
                title="Pause"
                className="disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Pause className="h-3.5 w-3.5 cursor-pointer text-amber-600 hover:text-amber-500" />
              </button>
              <button type="button" onClick={onStop} title="Stop">
                <Square className="h-3.5 w-3.5 cursor-pointer text-rose-600 hover:text-rose-500" />
              </button>
            </div>
          </div>

          <div className="mt-2 truncate text-[12px] text-[color:var(--cs-muted)]">{statusLine}</div>
          <div className="mt-1 truncate text-[11px] text-[color:var(--cs-muted)]">
            AI: {aiProvider} · {aiModel}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => setSettingsOpen((prev) => !prev)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1.5 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
              </button>
              {settingsOpen ? (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    aria-hidden
                    onClick={() => setSettingsOpen(false)}
                  />
                  <div className="absolute left-0 top-full z-20 mt-1 min-w-[12rem] rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3 shadow-lg">
                    <RunnerField
                      label="Max Steps"
                      value={maxSteps}
                      disabled={busy || !selectedConversation}
                      onChange={(value) =>
                        updateSelectedConversation((prev) => ({
                          ...prev,
                          maxSteps: value,
                        }))
                      }
                    />
                  </div>
                </>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1.5 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {selectedConversation ? selectedConversation.title : 'Chat history'}
              </span>
            </button>
          </div>

          {historyOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
              onClick={(e) => e.target === e.currentTarget && setHistoryOpen(false)}
            >
              <div
                className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between border-b border-[color:var(--cs-border)] px-3 py-2">
                  <span className="text-sm font-semibold text-[color:var(--cs-fg)]">Chat history</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={createNewConversation}
                      disabled={busy || !conversationsReady}
                      className="inline-flex items-center gap-1 rounded border border-[color:var(--cs-border)] px-2 py-1 text-[11px] text-[color:var(--cs-fg)] disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[color:var(--cs-hover)]"
                    >
                      <Plus className="h-3 w-3" />
                      New Chat
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryOpen(false)}
                      className="rounded p-1 text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)] hover:text-[color:var(--cs-fg)]"
                      aria-label="Close"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2">
                  {conversations.length === 0 ? (
                    <div className="px-2 py-4 text-center text-[11px] text-[color:var(--cs-muted)]">
                      {conversationsReady ? 'No conversations yet.' : 'Loading conversations...'}
                    </div>
                  ) : null}
                  {conversations.map((conversation) => {
                    const isSelected = conversation.id === selectedConversationId;
                    const userPrompts = conversation.messages.filter((item) => item.role === 'user').length;
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => {
                          selectConversation(conversation.id);
                          setHistoryOpen(false);
                        }}
                        disabled={busy || !conversationsReady}
                        className={[
                          'w-full rounded px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                          isSelected
                            ? 'bg-[color:var(--cs-accent)] text-white'
                            : 'hover:bg-[color:var(--cs-hover)] text-[color:var(--cs-fg)]',
                        ].join(' ')}
                      >
                        <div className="truncate text-[11px] font-medium">{conversation.title}</div>
                        <div className={['mt-0.5 text-[10px]', isSelected ? 'text-white/80' : 'text-[color:var(--cs-muted)]'].join(' ')}>
                          {userPrompts} prompts · {conversation.toolCalls.length} tools · {formatConversationStamp(conversation.updatedAt)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex-shrink-0 border-b border-[color:var(--cs-border)] px-3 pt-1.5">
          <div className="scrollbar-hide flex gap-1 overflow-x-auto pb-1.5">
            {RUNNER_TABS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              const badge =
                item.id === 'risks' && inferredRisks.length > 0
                  ? String(inferredRisks.length)
                  : item.id === 'tools' && toolCalls.length > 0
                    ? String(toolCalls.length)
                    : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={[
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-all',
                    isActive
                      ? 'bg-[color:var(--cs-accent)] text-white shadow-sm'
                      : 'text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)] hover:text-[color:var(--cs-fg)]',
                  ].join(' ')}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                  {badge ? (
                    <span className="ml-1 rounded-full bg-rose-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                      {badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 scroll-smooth">
          {activeTab === 'chat' ? (
            <div className="flex flex-col gap-4">
              {chatItems.map((item) => {
                if (item.kind === 'tool') {
                  return (
                    <div
                      key={item.id}
                      className="mx-auto flex w-fit max-w-[90%] items-center gap-2 rounded-full border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2.5 py-1 text-[11px] text-[color:var(--cs-muted)]"
                      title="Tool call (details in Tools tab)"
                    >
                      <Hammer className="h-3.5 w-3.5 shrink-0" />
                      <span className="font-mono">{item.tool.name}</span>
                    </div>
                  );
                }

                const message = item.message;
                const isUser = message.role === 'user';
                const justCopied = copiedId === message.id;
                return (
                  <div
                    key={message.id}
                    className={[
                      'max-w-[85%] min-w-0 rounded-2xl px-4 py-3 shadow-sm',
                      isUser
                        ? 'ml-auto bg-[color:var(--cs-accent)] text-white'
                        : 'border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] text-[color:var(--cs-fg)]',
                    ].join(' ')}
                  >
                    {isUser ? (
                      <div className="text-[14px] leading-relaxed break-words whitespace-pre-wrap">
                        {message.content}
                      </div>
                    ) : (
                      <ChatMarkdown content={message.content} />
                    )}
                    <div
                      className={[
                        'mt-2 flex items-center justify-between gap-2 text-[11px]',
                        isUser ? 'opacity-70' : 'text-[color:var(--cs-muted)]',
                      ].join(' ')}
                    >
                      <span>{formatTime(message.createdAt)}</span>
                      <button
                        type="button"
                        onClick={() => copyMessageContent(message.content, message.id)}
                        title={justCopied ? 'Copied!' : 'Copy message'}
                        className={[
                          'shrink-0 rounded p-0.5 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cs-accent)]',
                          isUser ? 'opacity-70 hover:bg-white/10' : 'opacity-60 hover:bg-[color:var(--cs-hover)]',
                        ].join(' ')}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {busy ? (
                <div
                  className="max-w-[85%] min-w-0 rounded-2xl border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-4 py-3 shadow-sm text-[color:var(--cs-fg)]"
                  aria-label="Agent is thinking"
                >
                  <div className="flex items-center gap-1.5 text-[14px] text-[color:var(--cs-muted)]">
                    <span className="flex gap-1">
                      <span className="h-2 w-2 rounded-full bg-[color:var(--cs-muted)] [animation:agent-bounce_1.4s_ease-in-out_infinite_both]" />
                      <span className="h-2 w-2 rounded-full bg-[color:var(--cs-muted)] [animation:agent-bounce_1.4s_ease-in-out_0.2s_infinite_both]" />
                      <span className="h-2 w-2 rounded-full bg-[color:var(--cs-muted)] [animation:agent-bounce_1.4s_ease-in-out_0.4s_infinite_both]" />
                    </span>
                    <span className="text-[13px]">Thinking…</span>
                  </div>
                  {visibleLiveTrace.length > 0 ? (
                    <div className="mt-2 space-y-1 text-[12px] text-[color:var(--cs-muted)]">
                      {visibleLiveTrace.map((line, idx) => (
                        <div key={`${idx}_${line}`} className="break-words">
                          {line}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === 'risks' ? (
            <div className="space-y-3">
              {inferredRisks.length === 0 ? (
                <div className="text-[12px] text-[color:var(--cs-muted)]">
                  No inferred risks yet. Run scanner/audit actions from chat to populate this view.
                </div>
              ) : (
                inferredRisks.map((risk, idx) => (
                  <RiskItem key={`${risk.title}_${idx}`} severity={risk.severity} title={risk.title} />
                ))
              )}
            </div>
          ) : null}

          {activeTab === 'tools' ? (
            <div className="space-y-3">
              {toolCalls.length === 0 ? (
                <div className="text-[12px] text-[color:var(--cs-muted)]">No tool executions yet.</div>
              ) : (
                toolCalls
                  .slice()
                  .reverse()
                  .map((call) => (
                    <div key={`tools_${call.id}`} className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <div className="font-medium text-[color:var(--cs-fg)]">{call.name}</div>
                        <div
                          className={[
                            'rounded-md px-2 py-0.5 text-[11px] font-medium',
                            call.ok ? 'bg-emerald-500/10 text-emerald-600' : 'bg-rose-500/10 text-rose-600',
                          ].join(' ')}
                        >
                          {call.ok ? 'ok' : 'error'}
                        </div>
                      </div>
                      <div className="mt-1 text-[12px] text-[color:var(--cs-muted)]">{call.summary}</div>
                      <div className="mt-1 font-mono text-[11px] text-[color:var(--cs-muted)] break-all">
                        {shortJson(call.args, 400)}
                      </div>
                      {call.error ? (
                        <div className="mt-1 text-[11px] text-rose-600 break-words">{call.error}</div>
                      ) : null}
                    </div>
                  ))
              )}
            </div>
          ) : null}
        </div>

        <div className="flex-shrink-0 border-t border-[color:var(--cs-border)] px-2 py-2">
          <div className="mb-1.5 flex flex-wrap gap-1">
            <ToolButton label={`Tools ${toolCalls.length}`} />
            <ToolButton label={busy ? 'Running' : 'Idle'} />
          </div>

          <form
            className="flex min-w-0 items-end gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void submitPrompt();
            }}
          >
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (prompt.trim() && selectedConversation && !busy) void submitPrompt();
                }
              }}
              disabled={!selectedConversation}
              placeholder="Ask agent to inspect, replay, fuzz, or generate payloads..."
              rows={2}
              className="min-h-[2.5rem] max-h-[12rem] min-w-0 flex-1 resize-y border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2 text-[13px] outline-none focus:border-[color:var(--cs-accent)] focus-visible:ring-[color:var(--cs-accent)]/30"
            />
            <button
              type="submit"
              disabled={busy || !prompt.trim() || !selectedConversation}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[color:var(--cs-accent)] text-white shadow-md shadow-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

function RiskItem({ severity, title }: { severity: 'High' | 'Medium' | 'Low'; title: string }) {
  const colors = {
    High: 'text-rose-500 bg-rose-500/10',
    Medium: 'text-amber-500 bg-amber-500/10',
    Low: 'text-blue-500 bg-blue-500/10',
  }[severity];

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3">
      <span className={`flex-shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${colors}`}>
        {severity}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[color:var(--cs-fg)]">{title}</span>
    </div>
  );
}

function RunnerField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <div className="mb-0.5 text-[11px] text-[color:var(--cs-muted)]">{props.label}</div>
      <input
        type="text"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2.5 text-[13px] outline-none focus:border-[color:var(--cs-accent)] disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  );
}

function ToolButton(props: { label: string }) {
  return (
    <button
      type="button"
      className="h-7 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)]"
    >
      {props.label}
    </button>
  );
}
