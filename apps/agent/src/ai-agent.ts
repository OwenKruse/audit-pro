import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ContractAuditRunRequestSchema,
  FuzzCampaignRequestSchema,
  ReplayOverridesSchema,
  type AgentEvent,
  type AiProvider,
  type AiChatRequest,
  type AiChatResponse,
  type HttpMessageDetail,
  type HttpMessageSummary,
  type ReplayOverrides,
} from '@cipherscope/proto';
import { z } from 'zod';
import { getContract, listContracts, listDecodedContracts } from './contracts.js';
import { runContractAudit } from './contract-audit.js';
import { listFindings } from './findings.js';
import { runFuzzCampaign } from './fuzzer.js';
import { ReplayError, replayOnce, sendRawHttpRequest } from './replay.js';
import {
  getHttpMessage,
  getSitemap,
  insertHttpMessage,
  listHttpMessages,
  listWsConnections,
  listWsFrames,
  parseCookieHeader,
  parseQueryToRecord,
  updateHttpMessageResponse,
} from './store.js';
import { runScanner } from './scanner.js';
import { getRpcInteraction, listRpcInteractions } from './rpc-history.js';
import { getZapScan, listZapScans, startZapScan, stopZapScan } from './zap-scans.js';
import { runSubfinder } from './subfinder.js';
import { recordPassedShodanSearch } from './shodan-searches.js';
import { searchPayloadCatalog } from './payload-catalog.js';
import {
  IntruderAttackRequestSchema,
  isIntruderInputError,
  type IntruderAttackRequest,
  runIntruderAttack,
} from './intruder.js';
import {
  clickPage,
  closeBrowserAutomation,
  evaluatePageJs,
  extractPageDom,
  extractPageText,
  gotoPage,
  screenshotPage,
  typeIntoPage,
  waitForPage,
} from './browser-automation.js';

type ToolCall = {
  id: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAiAssistantMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: ToolCall[];
};

type OpenAiChoice = {
  message?: OpenAiAssistantMessage;
};

type OpenAiResponse = {
  model?: string;
  choices?: OpenAiChoice[];
};

type AnthropicContentBlock =
  | {
      type?: 'text';
      text?: unknown;
    }
  | {
      type?: 'tool_use';
      id?: unknown;
      name?: unknown;
      input?: unknown;
    }
  | {
      type?: string;
      text?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };

type AnthropicMessageResponse = {
  model?: string;
  content?: AnthropicContentBlock[];
};

type OpenAiConversationMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string;
      tool_calls?: ToolCall[];
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };

type AiChatProgressEvent =
  | {
      type: 'run_started';
      createdAt: string;
      mode: AiChatRequest['mode'];
      provider: AiProvider;
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
    };

type RunAiAgentChatInput = {
  db: DatabaseSync;
  request: AiChatRequest;
  aiProvider: AiProvider;
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  aiExtraHeaders?: Record<string, string>;
  publishEvent?: (evt: AgentEvent) => void;
  rpcCall?: <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
  invokeLocal?: (input: {
    method: 'POST' | 'GET';
    url: string;
    payload?: unknown;
  }) => Promise<{ statusCode: number; body: unknown }>;
  fetchImpl?: typeof fetch;
  onProgress?: (event: AiChatProgressEvent) => void;
};

type ToolContext = {
  db: DatabaseSync;
  publishEvent?: (evt: AgentEvent) => void;
  rpcCall?: <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
  invokeLocal?: (input: {
    method: 'POST' | 'GET';
    url: string;
    payload?: unknown;
  }) => Promise<{ statusCode: number; body: unknown }>;
  fetchImpl?: typeof fetch;
};

type ToolExecutionResult = {
  payload: unknown;
  summary: string;
};

type PayloadCandidate = {
  label: string;
  reason: string;
  overrides: ReplayOverrides;
};

const ListMessagesArgsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

const GetMessageArgsSchema = z.object({
  id: z.string().min(1),
});

const ListDecodedArgsSchema = z.object({
  limit: z.number().int().min(1).max(250).optional(),
  offset: z.number().int().min(0).optional(),
});

const ListWsConnectionsArgsSchema = z.object({
  limit: z.number().int().min(1).max(2000).optional(),
  offset: z.number().int().min(0).optional(),
});

const ListWsFramesArgsSchema = z.object({
  connectionId: z.string().min(1),
  limit: z.number().int().min(1).max(2000).optional(),
  offset: z.number().int().min(0).optional(),
});

const GetContractArgsSchema = z.object({
  id: z.string().min(1),
});

const ReplayMessageArgsSchema = z.object({
  messageId: z.string().min(1),
  overrides: ReplayOverridesSchema.optional(),
});

const RunScannerArgsSchema = z.object({
  includeActive: z.boolean().optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  messageIds: z.array(z.string().min(1)).max(1000).optional(),
});

const StartScanArgsSchema = z.object({
  target: z.string().trim().min(1).max(2048),
  spider: z.boolean().optional(),
  ajaxSpider: z.boolean().optional(),
  activeScan: z.boolean().optional(),
  recurse: z.boolean().optional(),
  inScopeOnly: z.boolean().optional(),
  waitForPassiveScan: z.boolean().optional(),
  contextName: z.string().trim().max(120).optional(),
  scanPolicyName: z.string().trim().max(120).optional(),
  maxChildren: z.number().int().min(0).max(50_000).optional(),
  maxAlerts: z.number().int().min(1).max(1000).optional(),
  pollIntervalMs: z.number().int().min(50).max(10_000).optional(),
  maxDurationMs: z.number().int().min(60_000).max(3_600_000).optional(),
});

const GetScanArgsSchema = z.object({
  scanId: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  status: z.enum(['queued', 'running', 'stopping', 'completed', 'failed', 'stopped']).optional(),
});

const StopScanArgsSchema = z.object({
  scanId: z.string().trim().min(1),
});

const RunSubfinderArgsSchema = z.object({
  domain: z.string().trim().min(1).max(2048),
  recursive: z.boolean().optional(),
  allSources: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(5).max(180).optional(),
  maxTimeMinutes: z.number().int().min(1).max(60).optional(),
  rateLimit: z.number().int().min(1).max(5000).optional(),
  sources: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  excludeSources: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
});

const ListFindingsArgsSchema = z.object({
  limit: z.number().int().min(1).max(2000).optional(),
  offset: z.number().int().min(0).optional(),
  status: z.enum(['open', 'triaged', 'resolved']).optional(),
});

const ListRpcInteractionsArgsSchema = z.object({
  limit: z.number().int().min(1).max(2000).optional(),
  offset: z.number().int().min(0).optional(),
  source: z.enum(['wallet', 'foundry']).optional(),
});

const GetRpcInteractionArgsSchema = z.object({
  id: z.string().min(1),
});

const GeneratePayloadCandidatesArgsSchema = z.object({
  messageId: z.string().min(1),
  objective: z.string().trim().max(240).optional(),
  maxCases: z.number().int().min(1).max(20).optional(),
});

const ExplorerListArgSchema = z.union([z.string().trim().max(600), z.array(z.string().trim().max(120)).max(25)]);

const ExploreDexProtocolsArgsSchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: ExplorerListArgSchema.optional(),
  chain: ExplorerListArgSchema.optional(),
  minTvl: z.number().finite().optional(),
  maxTvl: z.number().finite().optional(),
  minMcap: z.number().finite().optional(),
  maxMcap: z.number().finite().optional(),
  minMcapToTvl: z.number().finite().optional(),
  maxMcapToTvl: z.number().finite().optional(),
  minChange1d: z.number().finite().optional(),
  maxChange1d: z.number().finite().optional(),
  minChange7d: z.number().finite().optional(),
  maxChange7d: z.number().finite().optional(),
  includeFees: z.boolean().optional(),
  includeRevenue: z.boolean().optional(),
  sort: z.enum(['tvl', 'mcap', 'mcapToTvl', 'change1d', 'change7d', 'change1m', 'name']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
});

const SearchZoomeyeHostsArgsSchema = z.object({
  q: z.string().trim().min(1).max(1200),
  subType: z.enum(['v4', 'v6', 'web']).optional(),
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
  fields: ExplorerListArgSchema.optional(),
  facets: ExplorerListArgSchema.optional(),
  ignoreCache: z.boolean().optional(),
});

const SearchShodanHostsArgsSchema = z.object({
  q: z.string().trim().min(1).max(1200),
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  facets: ExplorerListArgSchema.optional(),
  minify: z.boolean().optional(),
});

const GetWebPageMarkdownArgsSchema = z.object({
  url: z.string().trim().min(1).max(4096),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  maxChars: z.number().int().min(500).max(200_000).optional(),
  noCache: z.boolean().optional(),
});

const SearchPayloadsArgsSchema = z.object({
  q: z.string().trim().max(500).optional(),
  category: z.string().trim().max(200).optional(),
  subcategory: z.string().trim().max(200).optional(),
  sourceType: z.enum(['intruder', 'markdown', 'file']).optional(),
  sourcePath: z.string().trim().max(600).optional(),
  tag: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
});

const GetExplorerProjectDetailsArgsSchema = z.object({
  slug: z.string().trim().min(1).max(200),
});

const GetContractMetadataArgsSchema = z.object({
  chainId: z
    .union([z.string().trim().regex(/^\d+$/), z.number().int().positive()])
    .transform((v) => String(v)),
  address: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/),
  resolveProxy: z.boolean().optional(),
  blockscout: z.string().trim().max(2048).optional(),
  selector: z.string().trim().max(100).optional(),
  compiler: z.string().trim().max(100).optional(),
});

const DiscoverProtocolAddressesArgsSchema = z.object({
  slug: z.string().trim().min(1).max(200),
  maxUrls: z.number().int().min(1).max(12).optional(),
  maxAddresses: z.number().int().min(1).max(100).optional(),
});

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const HttpRequestHeaderValueSchema = z.union([
  z.string().trim().max(4096),
  z.array(z.string().trim().max(4096)).max(32),
]);
const HttpRequestHeaderMapSchema = z.record(z.string(), HttpRequestHeaderValueSchema);
const HttpRequestHeaderLineSchema = z.string().trim().min(1).max(8192);
const HttpRequestHeadersSchema = z.union([HttpRequestHeaderMapSchema, z.array(HttpRequestHeaderLineSchema).max(128)]);

const RepeaterMutationArgsSchema = z.object({
  url: z.string().trim().min(1).max(4096).optional(),
  scheme: z.enum(['http', 'https']).optional(),
  host: z.string().trim().min(1).max(512).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  path: z.string().trim().max(4096).optional(),
  query: z
    .union([
      z.string().max(4096),
      z.record(z.string(), z.union([z.string().max(4096), z.number(), z.boolean(), z.null()])),
    ])
    .optional(),
  method: HttpMethodSchema.optional(),
  headers: HttpRequestHeadersSchema.optional(),
  headersMode: z.enum(['merge', 'replace']).optional(),
  removeHeaders: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
  clearBody: z.boolean().optional(),
  bodyText: z.string().max(200_000).optional(),
  bodyJson: z.unknown().optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  followRedirects: z.boolean().optional(),
  maxResponseChars: z.number().int().min(0).max(240_000).optional(),
});

const HttpRequestArgsSchema = RepeaterMutationArgsSchema.extend({
  session: z.string().trim().min(1).max(120).optional(),
});

const RepeaterRequestArgsSchema = RepeaterMutationArgsSchema.extend({
  action: z.enum(['send', 'update', 'get_state', 'reset']).optional(),
  session: z.string().trim().min(1).max(120).optional(),
});

const RpcRequestArgsSchema = z.object({
  method: z.string().trim().min(1).max(128),
  params: z.array(z.unknown()).max(100).optional(),
  allowSideEffects: z.boolean().optional(),
});

const BrowserSessionArgsSchema = z.string().trim().min(1).max(120).optional();

const BrowserGotoArgsSchema = z.object({
  session: BrowserSessionArgsSchema,
  url: z.string().trim().min(1).max(4096),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
});

const BrowserClickArgsSchema = z.object({
  session: BrowserSessionArgsSchema,
  selector: z.string().trim().min(1).max(1024),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  button: z.enum(['left', 'middle', 'right']).optional(),
  clickCount: z.number().int().min(1).max(20).optional(),
  delayMs: z.number().int().min(0).max(3000).optional(),
});

const BrowserTypeArgsSchema = z.object({
  session: BrowserSessionArgsSchema,
  selector: z.string().trim().min(1).max(1024),
  text: z.string().max(100_000),
  clear: z.boolean().optional(),
  delayMs: z.number().int().min(0).max(500).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  pressEnter: z.boolean().optional(),
});

const BrowserWaitForArgsSchema = z.object({
  session: BrowserSessionArgsSchema,
  selector: z.string().trim().min(1).max(1024),
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
  timeoutMs: z.number().int().min(50).max(120_000).optional(),
});

const BrowserEvaluateJsArgsSchema = z.object({
  session: BrowserSessionArgsSchema,
  script: z.string().trim().min(1).max(200_000),
  timeoutMs: z.number().int().min(50).max(120_000).optional(),
});

const BrowserExtractTextArgsSchema = z.object({
  session: BrowserSessionArgsSchema,
  selector: z.string().trim().min(1).max(1024),
  all: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  maxChars: z.number().int().min(100).max(500_000).optional(),
  maxItems: z.number().int().min(1).max(2000).optional(),
  trim: z.boolean().optional(),
});

const BrowserExtractDomArgsSchema = z.object({
  session: BrowserSessionArgsSchema,
  selector: z.string().trim().min(1).max(1024).optional(),
  outerHtml: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  maxChars: z.number().int().min(100).max(600_000).optional(),
});

const BrowserScreenshotArgsSchema = z.object({
  session: BrowserSessionArgsSchema,
  selector: z.string().trim().min(1).max(1024).optional(),
  fullPage: z.boolean().optional(),
  path: z.string().trim().min(1).max(4096).optional(),
  type: z.enum(['png', 'jpeg']).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  omitBackground: z.boolean().optional(),
});

const PositiveIntLikeSchema = z.union([
  z.number().int().positive(),
  z.string().trim().regex(/^\d+$/).transform((v) => Number(v)),
]);

const PositiveIntLikeOrNullSchema = z.union([PositiveIntLikeSchema, z.null()]);

const SetForkConfigArgsSchema = z
  .object({
    action: z.literal('set_fork_config'),
    forkUrl: z.string().trim().max(4096).nullable().optional(),
    forkBlockNumber: PositiveIntLikeOrNullSchema.optional(),
    chainId: PositiveIntLikeOrNullSchema.optional(),
  })
  .refine((value) => {
    return (
      value.forkUrl !== undefined ||
      value.forkBlockNumber !== undefined ||
      value.chainId !== undefined
    );
  }, 'set_fork_config requires at least one of forkUrl, forkBlockNumber, or chainId.');

const ManageFoundryEnvironmentArgsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('get_config'),
  }),
  z.object({
    action: z.literal('set_chain_id'),
    chainId: PositiveIntLikeSchema,
  }),
  SetForkConfigArgsSchema,
  z.object({
    action: z.literal('snapshot'),
  }),
  z.object({
    action: z.literal('revert'),
    snapshotId: z.string().trim().min(1).max(256),
  }),
  z.object({
    action: z.literal('mine'),
    blocks: z.number().int().min(1).max(500).optional(),
  }),
  z.object({
    action: z.literal('increase_time'),
    seconds: z.number().int().min(1).max(31_536_000),
    mineBlock: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('set_next_block_timestamp'),
    timestamp: PositiveIntLikeSchema,
  }),
  z.object({
    action: z.literal('set_balance'),
    address: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/),
    balance: z.union([z.number().int().nonnegative(), z.string().trim().min(1).max(80)]),
  }),
]);

const FALLBACK_OPENAI_MODELS = ['gpt-4o-mini'] as const;

const DEFAULT_INTRUDER_FALLBACK_PAYLOADS = [
  "'",
  '"',
  '`',
  '../',
  '../../etc/passwd',
  '<script>alert(1)</script>',
  '{{7*7}}',
  '${7*7}',
  '1 OR 1=1',
  "1' OR '1'='1",
  '%00',
] as const;

function hasNonEmptyIntruderPayloadSets(payloadSets: IntruderAttackRequest['payloadSets']): boolean {
  if (!Array.isArray(payloadSets) || payloadSets.length === 0) return false;
  for (const set of payloadSets) {
    if (!Array.isArray(set) || set.length === 0) continue;
    for (const value of set) {
      if (typeof value === 'string' && value.trim().length > 0) return true;
    }
  }
  return false;
}

function hasIntruderPayloadQueries(payloadSetQueries: IntruderAttackRequest['payloadSetQueries']): boolean {
  return Array.isArray(payloadSetQueries) && payloadSetQueries.length > 0;
}

function buildDefaultIntruderCatalogQuery(maxRequests: number | undefined) {
  const base = typeof maxRequests === 'number' && Number.isFinite(maxRequests) ? Math.trunc(maxRequests) : 120;
  const limit = Math.max(20, Math.min(300, base));
  return {
    sourceType: 'intruder' as const,
    limit,
  };
}

const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_messages',
      description:
        'List captured HTTP messages from call history. Use this first when you need recent evidence or message IDs.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          offset: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_message',
      description:
        'Fetch one captured message by id with request/response details. Use before proposing a replay mutation.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_decoded_contract_calls',
      description:
        'List decoded contract interactions inferred from captured JSON-RPC traffic, including selectors, function names, and risk tags.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 250 },
          offset: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_ws_connections',
      description: 'List captured WebSocket connections (WS history).',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 2000 },
          offset: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_ws_frames',
      description: 'List captured WS frames for a specific connectionId (WS history).',
      parameters: {
        type: 'object',
        properties: {
          connectionId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 2000 },
          offset: { type: 'integer', minimum: 0 },
        },
        required: ['connectionId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_contracts',
      description:
        'List ABI contracts loaded into the inspector with chain/address metadata.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_rpc_interactions',
      description: 'List recorded wallet/foundry JSON-RPC interactions (RPC history).',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 2000 },
          offset: { type: 'integer', minimum: 0 },
          source: { type: 'string', enum: ['wallet', 'foundry'] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_rpc_interaction',
      description: 'Get one recorded JSON-RPC interaction by id (RPC history).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_contract',
      description:
        'Get one contract ABI entry by id for deeper function/event structure analysis.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sitemap',
      description:
        'Read host/path sitemap rolled up from captured traffic, useful for finding target surfaces.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replay_message',
      description:
        'Run repeater against one message ID with optional overrides and return diff/status changes.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          overrides: { type: 'object' },
        },
        required: ['messageId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_scanner',
      description:
        'Run security scanner over captured traffic and return findings summary + top findings.',
      parameters: {
        type: 'object',
        properties: {
          includeActive: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 2000 },
          messageIds: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_scan',
      description:
        'Start an OWASP ZAP scan asynchronously. Use get_scan to check status/progress and retrieve alerts.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          spider: { type: 'boolean' },
          ajaxSpider: { type: 'boolean' },
          activeScan: { type: 'boolean' },
          recurse: { type: 'boolean' },
          inScopeOnly: { type: 'boolean' },
          waitForPassiveScan: { type: 'boolean' },
          contextName: { type: 'string' },
          scanPolicyName: { type: 'string' },
          maxChildren: { type: 'integer', minimum: 0, maximum: 50000 },
          maxAlerts: { type: 'integer', minimum: 1, maximum: 1000 },
          pollIntervalMs: { type: 'integer', minimum: 50, maximum: 10000 },
          maxDurationMs: { type: 'integer', minimum: 60000, maximum: 3600000 },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_scan',
      description:
        'Get ZAP scan status and details. Without scanId, returns recent scans. With scanId, returns full scan state + alerts.',
      parameters: {
        type: 'object',
        properties: {
          scanId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          offset: { type: 'integer', minimum: 0 },
          status: { type: 'string', enum: ['queued', 'running', 'stopping', 'completed', 'failed', 'stopped'] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_scan',
      description:
        'Request stop for a running ZAP scan by scanId.',
      parameters: {
        type: 'object',
        properties: {
          scanId: { type: 'string' },
        },
        required: ['scanId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_subfinder',
      description:
        'Run Subfinder passive subdomain discovery for a domain and return discovered subdomains.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          recursive: { type: 'boolean' },
          allSources: { type: 'boolean' },
          activeOnly: { type: 'boolean' },
          timeoutSeconds: { type: 'integer', minimum: 5, maximum: 180 },
          maxTimeMinutes: { type: 'integer', minimum: 1, maximum: 60 },
          rateLimit: { type: 'integer', minimum: 1, maximum: 5000 },
          sources: { type: 'array', items: { type: 'string' }, maxItems: 50 },
          excludeSources: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        },
        required: ['domain'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_contract_audit',
      description:
        'Run contract audit checks for a target tx call payload (requires tx.to + calldata).',
      parameters: {
        type: 'object',
        properties: {
          sourceInteractionId: { type: 'string' },
          method: { type: 'string' },
          rpcUrl: { type: 'string' },
          chainId: { type: 'integer' },
          tx: { type: 'object' },
        },
        required: ['method', 'tx'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_fuzzer_campaign',
      description:
        'Run JSON-path fuzz campaign against a baseline message and return anomaly clusters.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          fieldPath: { type: 'string' },
          maxCases: { type: 'integer', minimum: 1, maximum: 200 },
          concurrency: { type: 'integer', minimum: 1, maximum: 20 },
          perHostDelayMs: { type: 'integer', minimum: 0, maximum: 5000 },
          timeoutMs: { type: 'integer', minimum: 250, maximum: 120000 },
          backoffBaseMs: { type: 'integer', minimum: 0, maximum: 10000 },
          anvilSnapshot: { type: 'boolean' },
          revertAfterRun: { type: 'boolean' },
        },
        required: ['messageId', 'fieldPath'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_findings',
      description:
        'List existing findings from scanner/manual/audit store.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 2000 },
          offset: { type: 'integer', minimum: 0 },
          status: { type: 'string', enum: ['open', 'triaged', 'resolved'] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_payload_candidates',
      description:
        'Generate concrete replay override payloads from one baseline message.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          objective: { type: 'string' },
          maxCases: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['messageId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_payloads',
      description:
        'Search and filter PayloadsAllTheThings payload catalog by query/category/source for attack payload selection.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          category: { type: 'string' },
          subcategory: { type: 'string' },
          sourceType: { type: 'string', enum: ['intruder', 'markdown', 'file'] },
          sourcePath: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
          offset: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_intruder_attack',
      description:
        'Run a Burp-style intruder attack against an HTTP request template using §...§ payload positions. Provide payloadSets or payloadSetQueries; if omitted, the agent applies fallback payload sources.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string' },
          url: { type: 'string' },
          headers: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' }, maxItems: 256 },
              {
                type: 'object',
                additionalProperties: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'array', items: { type: 'string' }, maxItems: 64 },
                  ],
                },
              },
            ],
          },
          body: { type: 'string' },
          attackType: { type: 'string', enum: ['sniper', 'battering_ram', 'pitchfork', 'cluster_bomb'] },
          payloadSets: {
            type: 'array',
            maxItems: 20,
            items: { type: 'array', items: { type: 'string' }, maxItems: 20000 },
          },
          payloadSetQueries: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                q: { type: 'string' },
                category: { type: 'string' },
                subcategory: { type: 'string' },
                sourceType: { type: 'string', enum: ['intruder', 'markdown', 'file'] },
                sourcePath: { type: 'string' },
                tag: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 3000 },
              },
              additionalProperties: false,
            },
          },
          maxRequests: { type: 'integer', minimum: 1, maximum: 10000 },
          concurrency: { type: 'integer', minimum: 1, maximum: 20 },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
          delayMs: { type: 'integer', minimum: 0, maximum: 5000 },
        },
        required: ['method', 'url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explore_dex_protocols',
      description:
        'Query the DEX explorer screener (DeFiLlama-backed) with filters, sorting, and optional fees/revenue enrichment.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          category: { type: 'array', items: { type: 'string' }, maxItems: 25 },
          chain: { type: 'array', items: { type: 'string' }, maxItems: 25 },
          minTvl: { type: 'number' },
          maxTvl: { type: 'number' },
          minMcap: { type: 'number' },
          maxMcap: { type: 'number' },
          minMcapToTvl: { type: 'number' },
          maxMcapToTvl: { type: 'number' },
          minChange1d: { type: 'number' },
          maxChange1d: { type: 'number' },
          minChange7d: { type: 'number' },
          maxChange7d: { type: 'number' },
          includeFees: { type: 'boolean' },
          includeRevenue: { type: 'boolean' },
          sort: { type: 'string', enum: ['tvl', 'mcap', 'mcapToTvl', 'change1d', 'change7d', 'change1m', 'name'] },
          order: { type: 'string', enum: ['asc', 'desc'] },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          offset: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_explorer_project_details',
      description:
        'Fetch DeFiLlama project/protocol details by slug (for deeper protocol metadata).',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_zoomeye_hosts',
      description:
        'Search ZoomEye host intelligence for internet-facing assets. q must be ZoomEye DSL (not natural language), e.g. app="Apache" && country="US" or service="ssh" && country="NO".',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          subType: { type: 'string', enum: ['v4', 'v6', 'web'] },
          page: { type: 'integer', minimum: 1, maximum: 10000 },
          pageSize: { type: 'integer', minimum: 1, maximum: 1000 },
          fields: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' }, maxItems: 25 },
            ],
          },
          facets: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' }, maxItems: 25 },
            ],
          },
          ignoreCache: { type: 'boolean' },
        },
        required: ['q'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_shodan_hosts',
      description:
        'Search Shodan host intelligence for internet-facing assets. q should use Shodan query/filter syntax, e.g. apache country:US or product:nginx port:443.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          page: { type: 'integer', minimum: 1, maximum: 10000 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
          facets: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' }, maxItems: 25 },
            ],
          },
          minify: { type: 'boolean' },
        },
        required: ['q'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_webpage_markdown',
      description:
        'Fetch AI-readable markdown for a public web page via r.jina.ai. Use this for docs/blog/reference pages when plain markdown content is needed.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
          maxChars: { type: 'integer', minimum: 500, maximum: 200000 },
          noCache: { type: 'boolean' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goto',
      description: 'Open a URL in a headless Chromium browser session.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          url: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
          waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'] },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element in the active Playwright browser session.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          selector: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
          button: { type: 'string', enum: ['left', 'middle', 'right'] },
          clickCount: { type: 'integer', minimum: 1, maximum: 20 },
          delayMs: { type: 'integer', minimum: 0, maximum: 3000 },
        },
        required: ['selector'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: 'Type text into an element in the active Playwright browser session.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          selector: { type: 'string' },
          text: { type: 'string' },
          clear: { type: 'boolean' },
          delayMs: { type: 'integer', minimum: 0, maximum: 500 },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
          pressEnter: { type: 'boolean' },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for',
      description: 'Wait for a selector state in the active Playwright browser session.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          selector: { type: 'string' },
          state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'] },
          timeoutMs: { type: 'integer', minimum: 50, maximum: 120000 },
        },
        required: ['selector'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'evaluate_js',
      description: 'Evaluate JavaScript in the current browser page context.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          script: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 50, maximum: 120000 },
        },
        required: ['script'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_text',
      description: 'Extract text content for a selector from the browser page.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          selector: { type: 'string' },
          all: { type: 'boolean' },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
          maxChars: { type: 'integer', minimum: 100, maximum: 500000 },
          maxItems: { type: 'integer', minimum: 1, maximum: 2000 },
          trim: { type: 'boolean' },
        },
        required: ['selector'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_dom',
      description: 'Extract DOM HTML from the browser page (full page or a selector).',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          selector: { type: 'string' },
          outerHtml: { type: 'boolean' },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
          maxChars: { type: 'integer', minimum: 100, maximum: 600000 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Capture a screenshot from the active browser page or a specific element.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          selector: { type: 'string' },
          fullPage: { type: 'boolean' },
          path: { type: 'string' },
          type: { type: 'string', enum: ['png', 'jpeg'] },
          quality: { type: 'integer', minimum: 1, maximum: 100 },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
          omitBackground: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_contract_metadata',
      description:
        'Fetch contract ABI/proxy metadata using Sourcify first, then Etherscan and optional Blockscout fallback.',
      parameters: {
        type: 'object',
        properties: {
          chainId: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          address: { type: 'string' },
          resolveProxy: { type: 'boolean' },
          blockscout: { type: 'string' },
          selector: { type: 'string' },
          compiler: { type: 'string' },
        },
        required: ['chainId', 'address'],
        additionalProperties: true,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'discover_protocol_addresses',
      description:
        'Find likely contract addresses for a protocol slug by scanning protocol metadata and official/docs pages.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          maxUrls: { type: 'integer', minimum: 1, maximum: 12 },
          maxAddresses: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['slug'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description:
        'Make an ad-hoc HTTP request (curl-like) for verification. You can pass a full url or partial fields (host/path/query) and optionally reuse an existing repeater session.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          scheme: { type: 'string', enum: ['http', 'https'] },
          host: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          path: { type: 'string' },
          query: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                additionalProperties: {
                  oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
                },
              },
            ],
          },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
          headers: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: {
                  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 32 }],
                },
              },
              { type: 'array', items: { type: 'string' }, maxItems: 128 },
            ],
          },
          headersMode: { type: 'string', enum: ['merge', 'replace'] },
          removeHeaders: { type: 'array', items: { type: 'string' }, maxItems: 64 },
          clearBody: { type: 'boolean' },
          bodyText: { type: 'string' },
          bodyJson: {},
          timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
          followRedirects: { type: 'boolean' },
          maxResponseChars: { type: 'integer', minimum: 0, maximum: 240000 },
          session: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repeater_request',
      description:
        'Stateful HTTP repeater. Use action=update to change session defaults once, action=send to execute using saved state + optional overrides, action=get_state to inspect, and action=reset to clear.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['send', 'update', 'get_state', 'reset'] },
          session: { type: 'string' },
          url: { type: 'string' },
          scheme: { type: 'string', enum: ['http', 'https'] },
          host: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          path: { type: 'string' },
          query: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                additionalProperties: {
                  oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
                },
              },
            ],
          },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
          headers: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: {
                  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 32 }],
                },
              },
              { type: 'array', items: { type: 'string' }, maxItems: 128 },
            ],
          },
          headersMode: { type: 'string', enum: ['merge', 'replace'] },
          removeHeaders: { type: 'array', items: { type: 'string' }, maxItems: 64 },
          clearBody: { type: 'boolean' },
          bodyText: { type: 'string' },
          bodyJson: {},
          timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
          followRedirects: { type: 'boolean' },
          maxResponseChars: { type: 'integer', minimum: 0, maximum: 240000 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_foundry_environment',
      description:
        'Manage local Foundry/Anvil environment: read/update chain+fork config and run basic EVM controls (snapshot/revert/mine/time/balance).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'get_config',
              'set_chain_id',
              'set_fork_config',
              'snapshot',
              'revert',
              'mine',
              'increase_time',
              'set_next_block_timestamp',
              'set_balance',
            ],
          },
          chainId: { oneOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] },
          forkUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          forkBlockNumber: { oneOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] },
          snapshotId: { type: 'string' },
          blocks: { type: 'integer', minimum: 1, maximum: 500 },
          seconds: { type: 'integer', minimum: 1 },
          mineBlock: { type: 'boolean' },
          timestamp: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          address: { type: 'string' },
          balance: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rpc_request',
      description:
        'Send a JSON-RPC request to the configured Foundry node (anvil fork). State-changing methods require allowSideEffects=true and AGENT_AI_ALLOW_RPC_SIDE_EFFECTS=1.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string' },
          params: { type: 'array', items: {} },
          allowSideEffects: { type: 'boolean' },
        },
        required: ['method'],
        additionalProperties: false,
      },
    },
  },
] as const;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function envAllows(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function toUrlPort(url: URL): number {
  if (url.port) {
    const parsed = Number(url.port);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  if (url.protocol === 'https:') return 443;
  return 80;
}

function timingEmpty() {
  return {
    dnsMs: null as number | null,
    connectMs: null as number | null,
    tlsMs: null as number | null,
    ttfbMs: null as number | null,
    totalMs: null as number | null,
  };
}

function formatHostHeader(input: { protocol: 'http:' | 'https:'; host: string; port: number }): string {
  const host = input.host.includes(':') && !input.host.startsWith('[') ? `[${input.host}]` : input.host;
  const isDefaultPort =
    (input.protocol === 'https:' && input.port === 443) || (input.protocol === 'http:' && input.port === 80);
  return isDefaultPort ? host : `${host}:${input.port}`;
}

function publishHttpSummaryEvent(
  publishEvent: ((evt: AgentEvent) => void) | undefined,
  message: Omit<HttpMessageSummary, 'parentId'> & { parentId?: string | null },
) {
  if (!publishEvent) return;
  publishEvent({
    type: 'http_message',
    time: new Date().toISOString(),
    message: {
      ...message,
      parentId: message.parentId ?? null,
    } as HttpMessageSummary,
  } as AgentEvent);
}

function normalizeHeaderKey(input: string): string {
  return input.trim().toLowerCase();
}

function parseHeaderLine(input: string): { key: string; value: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const key = normalizeHeaderKey(raw.slice(0, idx));
  if (!key) return null;
  return {
    key,
    value: raw.slice(idx + 1).trim(),
  };
}

function isRedirectStatusCode(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function firstHeaderValue(headers: Record<string, string[]>, key: string): string | null {
  const values = headers[key.toLowerCase()];
  if (!values || values.length === 0) return null;
  const first = values[0];
  return typeof first === 'string' && first.length > 0 ? first : null;
}

function flattenHeaders(headers: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v || v.length === 0) continue;
    out[k] = v.join(', ');
  }
  return out;
}

type HttpMethod = z.infer<typeof HttpMethodSchema>;
type RepeaterMutationArgs = z.infer<typeof RepeaterMutationArgsSchema>;
type RepeaterSessionState = {
  url: string | null;
  method: HttpMethod;
  headers: Record<string, string[]>;
  bodyMode: 'none' | 'text' | 'json';
  bodyText: string | null;
  bodyJson: unknown;
  timeoutMs: number;
  followRedirects: boolean;
  maxResponseChars: number;
  updatedAt: string;
};

const REPEATER_DEFAULT_SESSION = 'default';
const REPEATER_MAX_SESSIONS = 64;
const repeaterSessionStore = new Map<string, RepeaterSessionState>();

function normalizeRepeaterSessionName(value: string | undefined): string {
  const raw = value?.trim();
  return raw ? raw : REPEATER_DEFAULT_SESSION;
}

function cloneHeaderBag(input: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(input)) {
    if (!Array.isArray(values)) continue;
    out[key] = values.map((value) => String(value));
  }
  return out;
}

function createDefaultRepeaterSessionState(): RepeaterSessionState {
  return {
    url: null,
    method: 'GET',
    headers: {},
    bodyMode: 'none',
    bodyText: null,
    bodyJson: null,
    timeoutMs: 12_000,
    followRedirects: true,
    maxResponseChars: 80_000,
    updatedAt: new Date().toISOString(),
  };
}

function cloneRepeaterSessionState(input: RepeaterSessionState): RepeaterSessionState {
  return {
    ...input,
    headers: cloneHeaderBag(input.headers),
    bodyJson: cloneJson(input.bodyJson),
  };
}

function getRepeaterSessionState(session: string): RepeaterSessionState {
  const existing = repeaterSessionStore.get(session);
  if (!existing) return createDefaultRepeaterSessionState();
  return cloneRepeaterSessionState(existing);
}

function upsertRepeaterSessionState(session: string, state: RepeaterSessionState): RepeaterSessionState {
  const next: RepeaterSessionState = {
    ...state,
    headers: cloneHeaderBag(state.headers),
    bodyJson: cloneJson(state.bodyJson),
    updatedAt: new Date().toISOString(),
  };
  repeaterSessionStore.set(session, next);
  if (repeaterSessionStore.size > REPEATER_MAX_SESSIONS) {
    const oldest = [...repeaterSessionStore.entries()]
      .sort((a, b) => {
        const at = Date.parse(a[1].updatedAt);
        const bt = Date.parse(b[1].updatedAt);
        return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0);
      })
      .slice(0, repeaterSessionStore.size - REPEATER_MAX_SESSIONS);
    for (const [sessionName] of oldest) repeaterSessionStore.delete(sessionName);
  }
  return cloneRepeaterSessionState(next);
}

function resetRepeaterSessionState(session: string): RepeaterSessionState {
  repeaterSessionStore.delete(session);
  return createDefaultRepeaterSessionState();
}

function parseHeadersForHttpRequest(
  input: z.infer<typeof HttpRequestHeadersSchema> | undefined,
): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  if (!input) return headers;
  if (Array.isArray(input)) {
    for (const line of input) {
      const parsedLine = parseHeaderLine(line);
      if (!parsedLine) throw new Error(`Invalid header line in headers: "${line}"`);
      if (parsedLine.key === 'host' || parsedLine.key === 'content-length') continue;
      const values = headers[parsedLine.key] ?? [];
      values.push(parsedLine.value);
      headers[parsedLine.key] = values;
    }
    return headers;
  }
  for (const [k, v] of Object.entries(input)) {
    const key = normalizeHeaderKey(k);
    if (!key) continue;
    if (key === 'host' || key === 'content-length') continue;
    const values = headers[key] ?? [];
    if (Array.isArray(v)) values.push(...v);
    else values.push(v);
    headers[key] = values;
  }
  return headers;
}

function hasRepeaterMutation(input: RepeaterMutationArgs): boolean {
  return (
    input.url !== undefined ||
    input.scheme !== undefined ||
    input.host !== undefined ||
    input.port !== undefined ||
    input.path !== undefined ||
    input.query !== undefined ||
    input.method !== undefined ||
    input.headers !== undefined ||
    input.headersMode !== undefined ||
    input.removeHeaders !== undefined ||
    input.clearBody !== undefined ||
    input.bodyText !== undefined ||
    'bodyJson' in input ||
    input.timeoutMs !== undefined ||
    input.followRedirects !== undefined ||
    input.maxResponseChars !== undefined
  );
}

function applyRepeaterUrlMutation(baseUrl: string | null, input: RepeaterMutationArgs): string | null {
  const base = input.url ?? baseUrl;
  const wantsUrlMutation =
    input.scheme !== undefined ||
    input.host !== undefined ||
    input.port !== undefined ||
    input.path !== undefined ||
    input.query !== undefined;
  if (!wantsUrlMutation) return base;
  if (!base) {
    throw new Error(
      'URL mutation requires a baseline url. Set url once (or call repeater_request action=get_state to inspect current state).',
    );
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch (err) {
    throw new Error(`Invalid URL for request state: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (input.scheme) url.protocol = `${input.scheme}:`;
  if (input.host) url.hostname = input.host;
  if (input.port !== undefined) url.port = String(input.port);
  if (input.path !== undefined) {
    const rawPath = input.path.trim();
    if (!rawPath) {
      url.pathname = '/';
      url.search = '';
    } else {
      const queryIdx = rawPath.indexOf('?');
      const pathPart = queryIdx >= 0 ? rawPath.slice(0, queryIdx) : rawPath;
      const queryPart = queryIdx >= 0 ? rawPath.slice(queryIdx) : null;
      url.pathname = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
      if (queryPart != null) url.search = queryPart;
    }
  }
  if (input.query !== undefined) {
    if (typeof input.query === 'string') {
      const raw = input.query.trim();
      url.search = raw ? (raw.startsWith('?') ? raw : `?${raw}`) : '';
    } else {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(input.query)) {
        if (v == null) continue;
        params.set(k, String(v));
      }
      const text = params.toString();
      url.search = text ? `?${text}` : '';
    }
  }
  return url.toString();
}

function applyRepeaterMutation(base: RepeaterSessionState, input: RepeaterMutationArgs): RepeaterSessionState {
  const next = cloneRepeaterSessionState(base);
  next.url = applyRepeaterUrlMutation(next.url, input);
  if (next.url) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(next.url);
    } catch (err) {
      throw new Error(`Invalid URL for request state: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Unsupported protocol for request state: ${parsedUrl.protocol}`);
    }
  }
  if (input.method) next.method = input.method;
  if (input.headers) {
    const patchHeaders = parseHeadersForHttpRequest(input.headers);
    if (input.headersMode === 'replace') {
      next.headers = patchHeaders;
    } else {
      next.headers = { ...next.headers, ...patchHeaders };
    }
  }
  if (Array.isArray(input.removeHeaders) && input.removeHeaders.length > 0) {
    for (const raw of input.removeHeaders) {
      const key = normalizeHeaderKey(raw);
      if (!key || key === 'host' || key === 'content-length') continue;
      delete next.headers[key];
    }
  }
  if (input.clearBody) {
    next.bodyMode = 'none';
    next.bodyText = null;
    next.bodyJson = null;
  }
  if ('bodyJson' in input) {
    next.bodyMode = 'json';
    next.bodyText = null;
    next.bodyJson = cloneJson(input.bodyJson);
  } else if (input.bodyText !== undefined) {
    next.bodyMode = 'text';
    next.bodyText = input.bodyText;
    next.bodyJson = null;
  }
  if (input.timeoutMs !== undefined) next.timeoutMs = input.timeoutMs;
  if (input.followRedirects !== undefined) next.followRedirects = input.followRedirects;
  if (input.maxResponseChars !== undefined) next.maxResponseChars = input.maxResponseChars;
  return next;
}

function repeaterStatePayload(session: string, state: RepeaterSessionState): Record<string, unknown> {
  return {
    session,
    url: state.url,
    method: state.method,
    headers: flattenHeaders(state.headers),
    bodyMode: state.bodyMode,
    bodyText: state.bodyMode === 'text' ? state.bodyText : null,
    bodyJson: state.bodyMode === 'json' ? cloneJson(state.bodyJson) : null,
    timeoutMs: state.timeoutMs,
    followRedirects: state.followRedirects,
    maxResponseChars: state.maxResponseChars,
    updatedAt: state.updatedAt,
  };
}

type ResolvedHttpRequest = {
  url: string;
  method: HttpMethod;
  headers: Record<string, string[]>;
  bodyMode: RepeaterSessionState['bodyMode'];
  bodyText: string | null;
  bodyJson: unknown;
  timeoutMs: number;
  followRedirects: boolean;
  maxResponseChars: number;
};

function resolveHttpRequestFromState(state: RepeaterSessionState): ResolvedHttpRequest {
  if (!state.url) {
    throw new Error(
      'No request URL is set. Provide url in http_request, or set it first with repeater_request action=update.',
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(state.url);
  } catch (err) {
    throw new Error(`Invalid URL for http_request: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Unsupported protocol for http_request: ${parsedUrl.protocol}`);
  }
  return {
    url: parsedUrl.toString(),
    method: state.method,
    headers: cloneHeaderBag(state.headers),
    bodyMode: state.bodyMode,
    bodyText: state.bodyText,
    bodyJson: cloneJson(state.bodyJson),
    timeoutMs: state.timeoutMs,
    followRedirects: state.followRedirects,
    maxResponseChars: state.maxResponseChars,
  };
}

async function executeResolvedHttpRequest(
  ctx: ToolContext,
  input: ResolvedHttpRequest,
): Promise<ToolExecutionResult> {
  const url = new URL(input.url);
  const method = input.method;
  const timeoutMs = input.timeoutMs;
  const followRedirects = input.followRedirects;
  const maxResponseChars = input.maxResponseChars;
  const maxRedirects = 5;

  const allowAny = true;
  if (!allowAny) {
    const hosts = getSitemap(ctx.db);
    const port = toUrlPort(url);
    const match = hosts.some((h) => h.host === url.hostname && h.port === port);
    if (!match) {
      const allowlisted = hosts.slice(0, 25).map((h) => h.displayLabel).join(', ');
      const hint = hosts.length > 25 ? ' (truncated)' : '';
      throw new Error(
        `http_request blocked: host not in captured sitemap (${url.hostname}:${port}). ` +
          `Capture traffic first or set AGENT_AI_HTTP_ALLOW_ANY_HOST=1. ` +
          `Allowlisted hosts: ${allowlisted || '(none)'}${hint}`,
      );
    }
  }

  const headers: Record<string, string[]> = cloneHeaderBag(input.headers);
  let body: string | undefined;
  if (input.bodyMode === 'json') {
    body = safeJsonStringify(input.bodyJson, 200_000);
    if (!headers['content-type']) headers['content-type'] = ['application/json'];
  } else if (input.bodyMode === 'text') {
    body = input.bodyText ?? '';
  }
  const bodyBuffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : null;

  const requestPort = toUrlPort(url);
  const requestScheme = url.protocol === 'https:' ? 'https' : 'http';
  const requestPath = `${url.pathname}${url.search}`;
  const requestUrl = `${requestScheme}://${url.hostname}:${requestPort}${requestPath}`;
  const sentRequestHeaders: Record<string, string[]> = { ...headers };
  sentRequestHeaders.host = [
    formatHostHeader({ protocol: url.protocol as 'http:' | 'https:', host: url.hostname, port: requestPort }),
  ];
  if (bodyBuffer) sentRequestHeaders['content-length'] = [String(bodyBuffer.length)];
  else delete sentRequestHeaders['content-length'];

  const requestCookieHeader = sentRequestHeaders.cookie?.join('; ') ?? undefined;
  const requestCookies = parseCookieHeader(requestCookieHeader);
  const requestQuery = parseQueryToRecord(url);
  let requestBodyJson: string | null = null;
  if (input.bodyMode === 'json') {
    try {
      requestBodyJson = JSON.stringify(input.bodyJson);
    } catch {
      requestBodyJson = null;
    }
  } else if (body != null) {
    const contentType = sentRequestHeaders['content-type']?.[0]?.toLowerCase() ?? '';
    if (contentType.includes('application/json') || contentType.includes('+json')) {
      try {
        requestBodyJson = JSON.stringify(JSON.parse(body));
      } catch {
        requestBodyJson = null;
      }
    }
  }

  const messageId = randomUUID();
  const pseudoParentId = `ai-http-request:${messageId}`;
  const createdAt = new Date().toISOString();
  insertHttpMessage(ctx.db, {
    id: messageId,
    parentId: pseudoParentId,
    createdAt,
    scheme: requestScheme,
    host: url.hostname,
    port: requestPort,
    method,
    path: requestPath,
    url: requestUrl,
    state: 'replayed',
    requestHeaders: sentRequestHeaders,
    requestCookies,
    requestQuery,
    requestBody: bodyBuffer,
    requestBodyText: body ?? null,
    requestBodyJson,
    timingJson: JSON.stringify(timingEmpty()),
    error: null,
  });

  publishHttpSummaryEvent(ctx.publishEvent, {
    id: messageId,
    parentId: pseudoParentId,
    createdAt,
    scheme: requestScheme,
    host: url.hostname,
    port: requestPort,
    method,
    path: requestPath,
    url: requestUrl,
    state: 'replayed',
    responseStatus: null,
    totalMs: null,
  });

  const persistResponse = (response: {
    state: 'replayed' | 'error';
    responseStatus: number | null;
    responseHeaders: Record<string, string[]>;
    responseBody: Buffer | null;
    responseBodyText: string | null;
    responseBodyJson: string | null;
    timing: ReturnType<typeof timingEmpty>;
    error: string | null;
  }) => {
    updateHttpMessageResponse(ctx.db, {
      id: messageId,
      state: response.state,
      responseStatus: response.responseStatus,
      responseHeaders: response.responseHeaders,
      responseBody: response.responseBody,
      responseBodyText: response.responseBodyText,
      responseBodyJson: response.responseBodyJson,
      timingJson: JSON.stringify(response.timing),
      error: response.error,
    });

    publishHttpSummaryEvent(ctx.publishEvent, {
      id: messageId,
      parentId: pseudoParentId,
      createdAt,
      scheme: requestScheme,
      host: url.hostname,
      port: requestPort,
      method,
      path: requestPath,
      url: requestUrl,
      state: response.state,
      responseStatus: response.responseStatus,
      totalMs: response.timing.totalMs,
    });
  };

  const startedAt = Date.now();
  let currentUrl = new URL(url.toString());
  let currentMethod = method;
  let currentBody = method === 'GET' || method === 'HEAD' ? null : bodyBuffer;
  let redirects = 0;
  let upstream: Awaited<ReturnType<typeof sendRawHttpRequest>> | null = null;
  try {
    upstream = await sendRawHttpRequest({
      url: currentUrl.toString(),
      method: currentMethod,
      headers,
      body: currentBody,
      timeoutMs,
    });

    while (
      followRedirects &&
      upstream.error == null &&
      upstream.responseStatus != null &&
      isRedirectStatusCode(upstream.responseStatus)
    ) {
      const location = firstHeaderValue(upstream.responseHeaders, 'location');
      if (!location) break;
      if (redirects >= maxRedirects) {
        throw new Error(`http_request exceeded max redirects (${maxRedirects}).`);
      }
      currentUrl = new URL(location, currentUrl);
      redirects += 1;
      if (
        upstream.responseStatus === 303 ||
        ((upstream.responseStatus === 301 || upstream.responseStatus === 302) &&
          currentMethod !== 'GET' &&
          currentMethod !== 'HEAD')
      ) {
        currentMethod = 'GET';
        currentBody = null;
      }
      upstream = await sendRawHttpRequest({
        url: currentUrl.toString(),
        method: currentMethod,
        headers,
        body: currentBody,
        timeoutMs,
      });
    }
  } catch (err) {
    const transportError = err instanceof Error ? err.message : String(err);
    persistResponse({
      state: 'error',
      responseStatus: upstream?.responseStatus ?? null,
      responseHeaders: upstream?.responseHeaders ?? {},
      responseBody: upstream?.responseBody ?? null,
      responseBodyText: upstream?.responseBodyText ?? null,
      responseBodyJson: upstream?.responseBodyJson ?? null,
      timing: upstream?.timing ?? timingEmpty(),
      error: transportError,
    });
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  if (!upstream) {
    const message = 'http_request failed: no upstream response was produced.';
    persistResponse({
      state: 'error',
      responseStatus: null,
      responseHeaders: {},
      responseBody: null,
      responseBodyText: null,
      responseBodyJson: null,
      timing: timingEmpty(),
      error: message,
    });
    throw new Error(message);
  }
  if (upstream.error) {
    const message = `http_request transport error: ${upstream.error}`;
    persistResponse({
      state: 'error',
      responseStatus: upstream.responseStatus,
      responseHeaders: upstream.responseHeaders,
      responseBody: upstream.responseBody,
      responseBodyText: upstream.responseBodyText,
      responseBodyJson: upstream.responseBodyJson,
      timing: upstream.timing,
      error: message,
    });
    throw new Error(message);
  }
  if (upstream.responseStatus == null) {
    const message = 'http_request failed: no response status was returned.';
    persistResponse({
      state: 'error',
      responseStatus: null,
      responseHeaders: upstream.responseHeaders,
      responseBody: upstream.responseBody,
      responseBodyText: upstream.responseBodyText,
      responseBodyJson: upstream.responseBodyJson,
      timing: upstream.timing,
      error: message,
    });
    throw new Error(message);
  }

  persistResponse({
    state: 'replayed',
    responseStatus: upstream.responseStatus,
    responseHeaders: upstream.responseHeaders,
    responseBody: upstream.responseBody,
    responseBodyText: upstream.responseBodyText,
    responseBodyJson: upstream.responseBodyJson,
    timing: upstream.timing,
    error: null,
  });

  const headerRecord = flattenHeaders(upstream.responseHeaders);
  const bodyText = upstream.responseBodyText;
  const truncatedBodyText = bodyText == null ? null : truncate(bodyText, maxResponseChars);
  let bodyJson: unknown | null = null;
  const ct = firstHeaderValue(upstream.responseHeaders, 'content-type') ?? undefined;
  if (ct && truncatedBodyText && (ct.toLowerCase().includes('application/json') || ct.toLowerCase().includes('+json'))) {
    try {
      bodyJson = JSON.parse(truncatedBodyText);
    } catch {
      bodyJson = null;
    }
  }

  return {
    payload: {
      messageId,
      ok: upstream.responseStatus >= 200 && upstream.responseStatus < 300,
      url: currentUrl.toString(),
      method,
      finalMethod: currentMethod,
      status: upstream.responseStatus,
      redirects,
      durationMs,
      headers: headerRecord,
      bodyText: truncatedBodyText,
      bodyJson,
      truncated: bodyText != null && truncatedBodyText != null && bodyText.length !== truncatedBodyText.length,
    },
    summary: `http_request ${method} ${currentUrl.host}${currentUrl.pathname} -> ${upstream.responseStatus} (${durationMs}ms).`,
  };
}

function isRpcMethodLikelySideEffect(method: string): boolean {
  const m = method.trim();
  if (!m) return false;
  if (m.startsWith('eth_send')) return true;
  if (m === 'eth_sign' || m === 'eth_signTransaction') return true;
  if (m.startsWith('personal_')) return true;
  if (m.startsWith('wallet_')) return true;
  if (m.startsWith('anvil_')) return true;
  if (m.startsWith('hardhat_')) return true;
  if (m.startsWith('evm_')) return true;
  return false;
}

function parseRpcQuantityInput(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const n = Math.trunc(value);
    return n >= 0 ? BigInt(n) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    try {
      const out = BigInt(trimmed);
      return out >= 0n ? out : null;
    } catch {
      return null;
    }
  }
  if (/^\d+$/.test(trimmed)) {
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

function toRpcQuantity(value: bigint): string {
  if (value === 0n) return '0x0';
  return `0x${value.toString(16)}`;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safeJsonStringify(value: unknown, maxChars = 12000): string {
  let text = '';
  try {
    text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    text = String(value);
  }
  return truncate(text, maxChars);
}

function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  return {};
}

function normalizeExplorerListArg(
  value: z.infer<typeof ExplorerListArgSchema> | undefined,
): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => v.trim()).filter(Boolean);
  }
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseAssistantContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean);
    return parts.join('\n').trim();
  }
  return '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHexAddressValue(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function parseAbiItems(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((item): item is Record<string, unknown> => isObject(item));
  return out.length > 0 ? out : null;
}

function firstProxyImplementationAddress(proxyResolution: unknown): string | null {
  if (!isObject(proxyResolution)) return null;
  if (proxyResolution.isProxy !== true) return null;
  const impl = proxyResolution.implementations;
  if (!Array.isArray(impl) || impl.length === 0) return null;
  const first = impl[0];
  if (!isObject(first)) return null;
  const address = typeof first.address === 'string' ? first.address : '';
  return isHexAddressValue(address) ? address : null;
}

type LlamaProtocolIndexRow = {
  slug?: unknown;
  name?: unknown;
  symbol?: unknown;
  tvl?: unknown;
};

function asTrimmedStringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out ? out : null;
}

function asFiniteNumberValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function normalizeLookupValue(value: string): string {
  return value.trim().toLowerCase();
}

function compactLookupValue(value: string): string {
  return normalizeLookupValue(value).replace(/[^a-z0-9]/g, '');
}

function protocolCandidateScore(row: LlamaProtocolIndexRow, query: string): number {
  const q = normalizeLookupValue(query);
  const qCompact = compactLookupValue(query);
  if (!q) return -1;

  const slug = asTrimmedStringValue(row.slug);
  const name = asTrimmedStringValue(row.name);
  const symbol = asTrimmedStringValue(row.symbol);
  const slugNorm = slug ? normalizeLookupValue(slug) : null;
  const nameNorm = name ? normalizeLookupValue(name) : null;
  const symbolNorm = symbol ? normalizeLookupValue(symbol) : null;
  const slugCompact = slug ? compactLookupValue(slug) : null;
  const nameCompact = name ? compactLookupValue(name) : null;
  const symbolCompact = symbol ? compactLookupValue(symbol) : null;

  let score = 0;
  if (slugNorm && slugNorm === q) score += 120;
  if (nameNorm && nameNorm === q) score += 105;
  if (symbolNorm && symbolNorm === q) score += 95;
  if (slugNorm && slugNorm.startsWith(q)) score += 70;
  if (nameNorm && nameNorm.startsWith(q)) score += 65;
  if (symbolNorm && symbolNorm.startsWith(q)) score += 55;
  if (slugNorm && slugNorm.includes(q)) score += 40;
  if (nameNorm && nameNorm.includes(q)) score += 35;
  if (symbolNorm && symbolNorm.includes(q)) score += 25;
  if (slugNorm && q.includes(slugNorm)) score += 30;
  if (nameNorm && q.includes(nameNorm)) score += 25;
  if (symbolNorm && q.includes(symbolNorm)) score += 20;

  if (qCompact) {
    if (slugCompact && slugCompact === qCompact) score += 80;
    if (nameCompact && nameCompact === qCompact) score += 70;
    if (symbolCompact && symbolCompact === qCompact) score += 60;
    if (slugCompact && slugCompact.includes(qCompact)) score += 35;
    if (nameCompact && nameCompact.includes(qCompact)) score += 30;
    if (symbolCompact && symbolCompact.includes(qCompact)) score += 20;
    if (slugCompact && qCompact.includes(slugCompact)) score += 25;
    if (nameCompact && qCompact.includes(nameCompact)) score += 20;
    if (symbolCompact && qCompact.includes(symbolCompact)) score += 15;
  }

  const tvl = asFiniteNumberValue(row.tvl);
  if (tvl && tvl > 0) score += Math.min(20, Math.log10(tvl + 1));
  return score;
}

function resolveProtocolSlugFromIndex(input: {
  query: string;
  rows: LlamaProtocolIndexRow[];
}): {
  resolvedSlug: string | null;
  suggestions: Array<{ slug: string; name: string | null }>;
} {
  const scored = input.rows
    .map((row) => ({
      slug: asTrimmedStringValue(row.slug),
      name: asTrimmedStringValue(row.name),
      score: protocolCandidateScore(row, input.query),
    }))
    .filter((item) => item.slug && item.score > 0)
    .sort((a, b) => b.score - a.score);

  const resolvedSlug = scored[0]?.slug ?? null;
  const suggestions = scored.slice(0, 8).map((item) => ({
    slug: item.slug as string,
    name: item.name ?? null,
  }));
  return { resolvedSlug, suggestions };
}

function getLlamaBaseUrls(): string[] {
  const candidates = [
    process.env.LLAMA_BASE_URL?.trim() ?? '',
    'https://api.llama.fi',
    process.env.LLAMA_PRO_BASE_URL?.trim() ?? '',
  ];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of candidates) {
    if (!raw) continue;
    const normalized = raw.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

type LlamaSlugSuggestion = { slug: string; name: string | null };
type LlamaProtocolLookup = {
  requestedSlug: string;
  resolvedSlug: string;
  suggestions: LlamaSlugSuggestion[];
  baseUrl: string;
  triedBaseUrls: string[];
  data: unknown;
};

async function fetchLlamaProtocolDetails(
  fetchImpl: typeof fetch,
  requestedSlugRaw: string,
): Promise<LlamaProtocolLookup> {
  const requestedSlug = requestedSlugRaw.trim();
  if (!requestedSlug) throw new Error('Missing slug.');
  const baseUrls = getLlamaBaseUrls();
  const errors: string[] = [];
  let suggestions: LlamaSlugSuggestion[] = [];

  for (const baseUrl of baseUrls) {
    const protocolUrl = (slug: string) =>
      `${baseUrl}/protocol/${encodeURIComponent(slug)}`;

    try {
      const data = await fetchJsonAccept<unknown>(fetchImpl, protocolUrl(requestedSlug));
      return {
        requestedSlug,
        resolvedSlug: requestedSlug,
        suggestions: [],
        baseUrl,
        triedBaseUrls: baseUrls,
        data,
      };
    } catch (err) {
      const status = fetchErrorStatusCode(err);
      if (status !== 404) {
        errors.push(`${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    try {
      const index = await fetchJsonAccept<unknown>(fetchImpl, `${baseUrl}/protocols`);
      const rows = Array.isArray(index) ? (index as LlamaProtocolIndexRow[]) : [];
      const resolved = resolveProtocolSlugFromIndex({ query: requestedSlug, rows });
      if (suggestions.length === 0) suggestions = resolved.suggestions;

      if (!resolved.resolvedSlug) {
        errors.push(`${baseUrl}: protocol not found`);
        continue;
      }

      const data = await fetchJsonAccept<unknown>(fetchImpl, protocolUrl(resolved.resolvedSlug));
      return {
        requestedSlug,
        resolvedSlug: resolved.resolvedSlug,
        suggestions: resolved.suggestions,
        baseUrl,
        triedBaseUrls: baseUrls,
        data,
      };
    } catch (err) {
      errors.push(`${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const suggestionText = suggestions.map((s) => s.slug).join(', ') || '(none)';
  const errorText = errors.length > 0 ? ` Errors: ${errors.join(' | ')}` : '';
  throw new Error(`Protocol "${requestedSlug}" not found. Suggestions: ${suggestionText}.${errorText}`);
}

async function mapLimit<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return [];
  const workerCount = Math.max(1, Math.min(Math.trunc(concurrency), items.length));
  const results = new Array<U>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function fetchErrorStatusCode(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/^Fetch failed (\d{3})\b/);
  if (!match) return null;
  const out = Number(match[1]);
  return Number.isFinite(out) ? out : null;
}

function asHttpUrl(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}

function collectUrlsFromUnknown(value: unknown, out: Set<string>, max = 100): void {
  if (out.size >= max) return;
  if (typeof value === 'string') {
    const direct = asHttpUrl(value);
    if (direct) out.add(direct);
    const matches = value.match(/https?:\/\/[^\s"')<>]+/g) ?? [];
    for (const raw of matches) {
      const normalized = asHttpUrl(raw.replace(/[.,;:!?]+$/g, ''));
      if (!normalized) continue;
      out.add(normalized);
      if (out.size >= max) break;
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlsFromUnknown(item, out, max);
      if (out.size >= max) return;
    }
    return;
  }

  if (!isObject(value)) return;
  for (const v of Object.values(value)) {
    collectUrlsFromUnknown(v, out, max);
    if (out.size >= max) return;
  }
}

function extractHexAddressesFromText(text: string): string[] {
  const matches = text.match(/0x[a-fA-F0-9]{40}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of matches) {
    const lower = item.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

async function fetchTextWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs = 10_000,
): Promise<{ status: number; contentType: string | null; text: string }> {
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: { accept: 'text/html,application/json,text/plain,*/*' },
      redirect: 'follow',
    },
    timeoutMs,
  );
  const text = await res.text().catch(() => '');
  return { status: res.status, contentType: res.headers.get('content-type'), text };
}

async function fetchJsonAccept<T>(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs = 12_000,
): Promise<T> {
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: { accept: 'application/json' },
    },
    timeoutMs,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fetch failed ${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

function cloneJson<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function messageSummary(message: HttpMessageDetail): Record<string, unknown> {
  const requestBodyText = message.request.bodyText ? truncate(message.request.bodyText, 3500) : null;
  const responseBodyText = message.response.bodyText ? truncate(message.response.bodyText, 3500) : null;
  const requestBodyJson =
    message.request.bodyJson == null
      ? null
      : JSON.parse(safeJsonStringify(message.request.bodyJson, 7000));
  const responseBodyJson =
    message.response.bodyJson == null
      ? null
      : JSON.parse(safeJsonStringify(message.response.bodyJson, 7000));

  return {
    id: message.id,
    parentId: message.parentId,
    createdAt: message.createdAt,
    method: message.method,
    url: message.url,
    state: message.state,
    responseStatus: message.responseStatus,
    totalMs: message.totalMs,
    request: {
      headers: message.request.headers,
      query: message.request.query,
      cookies: message.request.cookies,
      bodyText: requestBodyText,
      bodyJson: requestBodyJson,
      bodyBase64Bytes: message.request.bodyBase64 ? message.request.bodyBase64.length : 0,
    },
    response: {
      headers: message.response.headers,
      bodyText: responseBodyText,
      bodyJson: responseBodyJson,
      bodyBase64Bytes: message.response.bodyBase64 ? message.response.bodyBase64.length : 0,
    },
    timing: message.timing,
    error: message.error,
    replayDiff: message.replayDiff,
  };
}

function extractSitemapSummary() {
  return {
    hosts: [] as Array<{
      host: string;
      port: number;
      displayLabel: string;
      requests: number;
      alerts: number;
      topPaths: string[];
    }>,
  };
}

function summarizeHosts(hosts: ReturnType<typeof getSitemap>): ReturnType<typeof extractSitemapSummary> {
  const out = extractSitemapSummary();
  for (const host of hosts.slice(0, 40)) {
    out.hosts.push({
      host: host.host,
      port: host.port,
      displayLabel: host.displayLabel,
      requests: host.requests,
      alerts: host.alerts,
      topPaths: host.pathTree.slice(0, 12).map((p) => p.segment),
    });
  }
  return out;
}

function looksLikeHexData(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{10,}$/.test(value);
}

function parseFormPairs(bodyText: string): Array<[string, string]> {
  const params = new URLSearchParams(bodyText);
  const out: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) out.push([k, v]);
  return out;
}

function serializeFormPairs(pairs: Array<[string, string]>): string {
  const params = new URLSearchParams();
  for (const [k, v] of pairs) params.append(k, v);
  return params.toString();
}

function findPreferredFormKey(
  pairs: Array<[string, string]>,
  patterns: RegExp[],
  opts?: { fallbackToFirst?: boolean },
): string | null {
  const keys = [...new Set(pairs.map(([k]) => k))];
  for (const key of keys) {
    if (patterns.some((re) => re.test(key))) return key;
  }
  if (opts?.fallbackToFirst) return keys[0] ?? null;
  return null;
}

function buildPayloadCandidates(input: {
  message: HttpMessageDetail;
  objective?: string;
  maxCases: number;
}): PayloadCandidate[] {
  const out: PayloadCandidate[] = [];
  const seen = new Set<string>();

  const push = (candidate: PayloadCandidate) => {
    if (out.length >= input.maxCases) return;
    const key = safeJsonStringify(candidate.overrides, 8000);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  const bodyJson = input.message.request.bodyJson;
  if (isObject(bodyJson)) {
    const keys = Object.keys(bodyJson).slice(0, 8);
    for (const key of keys) {
      const value = bodyJson[key];
      if (typeof value === 'number') {
        const zero = cloneJson(bodyJson);
        zero[key] = 0;
        push({
          label: `set_${key}_to_0`,
          reason: `Boundary test for numeric field "${key}".`,
          overrides: { bodyText: JSON.stringify(zero) },
        });

        const negative = cloneJson(bodyJson);
        negative[key] = -1;
        push({
          label: `set_${key}_to_-1`,
          reason: `Negative boundary test for numeric field "${key}".`,
          overrides: { bodyText: JSON.stringify(negative) },
        });
      } else if (typeof value === 'string') {
        const empty = cloneJson(bodyJson);
        empty[key] = '';
        push({
          label: `empty_${key}`,
          reason: `Required string validation test for "${key}".`,
          overrides: { bodyText: JSON.stringify(empty) },
        });

        const long = cloneJson(bodyJson);
        long[key] = 'A'.repeat(256);
        push({
          label: `long_${key}`,
          reason: `Length/fuzz test for "${key}".`,
          overrides: { bodyText: JSON.stringify(long) },
        });
      } else if (typeof value === 'boolean') {
        const flipped = cloneJson(bodyJson);
        flipped[key] = !value;
        push({
          label: `flip_${key}`,
          reason: `Boolean branch test for "${key}".`,
          overrides: { bodyText: JSON.stringify(flipped) },
        });
      } else if (Array.isArray(value)) {
        const emptied = cloneJson(bodyJson);
        emptied[key] = [];
        push({
          label: `empty_array_${key}`,
          reason: `Collection boundary test for "${key}".`,
          overrides: { bodyText: JSON.stringify(emptied) },
        });
      }
    }

    if (typeof bodyJson.method === 'string') {
      const badMethod = cloneJson(bodyJson);
      badMethod.method = `${bodyJson.method}_invalid`;
      push({
        label: 'invalid_jsonrpc_method',
        reason: 'JSON-RPC method authorization/validation test.',
        overrides: { bodyText: JSON.stringify(badMethod) },
      });
    }

    if (Array.isArray(bodyJson.params)) {
      const noParams = cloneJson(bodyJson);
      noParams.params = [];
      push({
        label: 'empty_params',
        reason: 'JSON-RPC params arity validation test.',
        overrides: { bodyText: JSON.stringify(noParams) },
      });

      const tx = bodyJson.params[0];
      if (isObject(tx) && looksLikeHexData(tx.data)) {
        const mutatedSelector = cloneJson(bodyJson);
        if (Array.isArray(mutatedSelector.params) && isObject(mutatedSelector.params[0])) {
          const tx0 = mutatedSelector.params[0];
          tx0.data = `0xdeadbeef${tx.data.slice(10)}`;
          push({
            label: 'mutate_selector',
            reason: 'Calldata selector mutation test.',
            overrides: { bodyText: JSON.stringify(mutatedSelector) },
          });
        }

        const truncatedCalldata = cloneJson(bodyJson);
        if (Array.isArray(truncatedCalldata.params) && isObject(truncatedCalldata.params[0])) {
          const tx0 = truncatedCalldata.params[0];
          tx0.data = tx.data.slice(0, 10);
          push({
            label: 'truncate_calldata',
            reason: 'Calldata length validation test.',
            overrides: { bodyText: JSON.stringify(truncatedCalldata) },
          });
        }
      }
    }
  } else if (typeof input.message.request.bodyText === 'string' && input.message.request.bodyText.trim()) {
    const bodyText = input.message.request.bodyText;
    const contentType = (input.message.request.headers['content-type'] ?? [''])[0]?.toLowerCase() ?? '';
    const looksFormBody =
      contentType.includes('application/x-www-form-urlencoded') ||
      (bodyText.includes('=') && !bodyText.trimStart().startsWith('{') && !bodyText.trimStart().startsWith('['));

    if (looksFormBody) {
      const pairs = parseFormPairs(bodyText);
      if (pairs.length > 0) {
        const userKey = findPreferredFormKey(pairs, [/^user(name)?$/i, /^email$/i, /^login$/i], {
          fallbackToFirst: true,
        });
        const passKey = findPreferredFormKey(pairs, [/^pass(word)?$/i, /^pwd$/i]);
        const submitKey = findPreferredFormKey(pairs, [/submit/i, /login[_-]?btn/i, /button/i, /action/i]);

        if (userKey) {
          const userValue = pairs.find(([k]) => k === userKey)?.[1] ?? '1';
          push({
            label: `array_injection_${userKey}`,
            reason: `PHP-style array/type-confusion probe on "${userKey}[123]" parameter.`,
            overrides: { bodyText: serializeFormPairs([...pairs, [`${userKey}[123]`, userValue]]) },
          });
          push({
            label: `array_suffix_${userKey}`,
            reason: `PHP array coercion probe using "${userKey}[]".`,
            overrides: { bodyText: serializeFormPairs([...pairs, [`${userKey}[]`, 'x']]) },
          });
          push({
            label: `nested_array_suffix_${userKey}`,
            reason: `Nested array coercion probe using "${userKey}[][]".`,
            overrides: { bodyText: serializeFormPairs([...pairs, [`${userKey}[][]`, 'x']]) },
          });
          push({
            label: `duplicate_scalar_array_${userKey}`,
            reason: `Duplicate-key ambiguity probe mixing scalar and array-shaped keys.`,
            overrides: { bodyText: serializeFormPairs([...pairs, [userKey, userValue], [`${userKey}[123]`, 'bad']]) },
          });
        }

        if (passKey) {
          push({
            label: `array_injection_${passKey}`,
            reason: `Credential parser robustness probe using "${passKey}[0]".`,
            overrides: { bodyText: serializeFormPairs([...pairs, [`${passKey}[0]`, 'x']]) },
          });
        }

        if (submitKey) {
          push({
            label: `missing_${submitKey}`,
            reason: `Workflow robustness test by removing submit/action control "${submitKey}".`,
            overrides: { bodyText: serializeFormPairs(pairs.filter(([k]) => k !== submitKey)) },
          });
        }
      }
    }

    push({
      label: 'empty_body',
      reason: 'Required body validation test.',
      overrides: { bodyText: '' },
    });
    push({
      label: 'oversized_body',
      reason: 'Body size handling test.',
      overrides: { bodyText: `${bodyText}\n${'A'.repeat(1024)}` },
    });
  }

  if (out.length === 0) {
    push({
      label: 'no_mutation_available',
      reason: 'Message body is empty or non-textual; use replay_message with manual overrides.',
      overrides: {},
    });
  }

  return out.slice(0, input.maxCases);
}

const SYSTEM_PROMPT = `You are CipherScope Autonomous Agent running in a local crypto security workbench. Your primary directive is to be exhaustive, tenacious, and highly detailed in your investigations. Never take the shortest path to completion; always thoroughly enumerate and verify your findings.

### 1. Planning & Methodology (MANDATORY)
Before executing any tools or answering vague requests (e.g., "Investigate [target]"), you must generate a step-by-step execution plan using a \`<scratchpad>\` block.
- Your plan must break the task into distinct, logical phases (e.g., Broad Recon, Service Enumeration, Deep Probing).
- You must not conclude your response until every actionable step in your plan has been executed or definitively blocked by access constraints.

### 2. Standard Operating Procedures (SOPs)
If instructed to "investigate" or "analyze" a target without specific parameters, you must execute an exhaustive enumeration:
1. Query Shodan AND ZoomEye for the target to establish a broad footprint.
2. Enumerate all discovered open ports and technologies.
3. For HTTP/HTTPS ports, use \`http_request\` to fetch the index page and headers.
4. For discovered web apps or docs, use \`get_webpage_markdown\` to read them and extract context.
5. Cross-reference any discovered smart contracts using your protocol/contract lookup tools.

### 3. Tool Usage Rules
- Gather concrete evidence using tools before making factual claims.
- **Crypto/Protocol Lookups:** Use \`get_explorer_project_details\`, \`discover_protocol_addresses\`, and \`get_contract_metadata\`.
- **Reconnaissance:** Use \`search_zoomeye_hosts\` or \`search_shodan_hosts\` for external host discovery/exposed services.
    - \`search_zoomeye_hosts\`: \`q\` must be ZoomEye DSL (field="value" with optional &&/||), never a natural-language sentence. If it returns "Invalid query", rewrite \`q\` into ZoomEye DSL and retry once with a simpler expression.
    - \`search_shodan_hosts\`: \`q\` must use Shodan query syntax with filters (e.g., \`apache country:US\` or \`product:nginx port:443\`).
- **Web Content:** Use \`get_webpage_markdown\` for web docs/blogs/references to get clean markdown content for reasoning.
- **Browser Automation:** For JavaScript-rendered pages use \`goto\`, \`click\`, \`type\`, \`wait_for\`, \`evaluate_js\`, \`extract_text\`, \`extract_dom\`, and \`screenshot\` in sequence.
- **EVM State:** Use \`manage_foundry_environment\` to control chain/fork config and basic Foundry/anvil operations.
- **HTTP/Web Probing:** Use \`repeater_request\` for stateful HTTP exploration (set once, send many) and \`http_request\` for one-off curl-like checks. Pass headers via a headers object or curl-style header lines (example: \`["Authorization: Bearer <token>"]\`).

### 4. Execution vs. Recommendations
- When asked for payload generation, provide concrete replay overrides and explain expected outcomes.
- **Do not stop at recommendations:** If you write anything in "Next Actions" that can be executed with your available tools, YOU MUST EXECUTE IT in this same run before answering.
- Only leave items in "Next Actions" that require user input, manual approval, or access privileges you do not possess.

### 5. Final Reporting
Your internal reasoning and tool execution loop should be highly verbose and multi-stepped. However, your final user-facing response must be concise, structured, and strictly contain only these sections:
- **Summary:** High-level findings and overall posture.
- **Evidence:** Detail any risks identified (must include severity, impact, evidence IDs, and verification steps taken).
- **Next Actions:** Only manual steps, required approvals, or unavailable tool requests.`;

function buildSystemPrompt(_mode: AiChatRequest['mode']): string {
  void _mode;
  return SYSTEM_PROMPT;
}

class AiRequestError extends Error {
  status: number;
  code: string | null;

  constructor(input: { status: number; code?: string | null; message: string }) {
    super(input.message);
    this.name = 'AiRequestError';
    this.status = input.status;
    this.code = input.code ?? null;
  }
}

function parseOptionalFloat(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function shouldOmitTemperature(model: string): boolean {
  // Some models reject non-default temperatures (or only support the default).
  // Heuristic: treat gpt-5* as "temperature-restricted" unless explicitly overridden.
  const m = (model ?? '').trim().toLowerCase();
  if (!m) return false;
  if (m.startsWith('gpt-5')) return true;
  return false;
}

function openAiToolsAsAnthropicTools(): Array<{
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}> {
  return OPENAI_TOOLS.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters as Record<string, unknown>,
  }));
}

function toAnthropicMessages(conversation: OpenAiConversationMessage[]): {
  system: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
          | { type: 'tool_result'; tool_use_id: string; content: string }
        >;
  }>;
} {
  const systemParts: string[] = [];
  const out: Array<{
    role: 'user' | 'assistant';
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
          | { type: 'tool_result'; tool_use_id: string; content: string }
        >;
  }> = [];

  for (const message of conversation) {
    if (message.role === 'system') {
      const text = message.content.trim();
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      > = [];
      const text = message.content.trim();
      if (text) blocks.push({ type: 'text', text });

      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) {
        const id = typeof call.id === 'string' && call.id.trim() ? call.id : randomUUID();
        const name = typeof call.function?.name === 'string' ? call.function.name.trim() : '';
        if (!name) continue;
        blocks.push({
          type: 'tool_use',
          id,
          name,
          input: parseToolArgs(call.function?.arguments),
        });
      }

      if (blocks.length === 0) continue;
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (message.role !== 'tool') continue;
    const content = message.content.trim() || '{}';
    out.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content }],
    });
  }

  return { system: systemParts.join('\n\n'), messages: out };
}

function anthropicMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  if (normalized.endsWith('/v1')) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

async function callOpenAiChat(input: {
  apiKey: string;
  model: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  messages: OpenAiConversationMessage[];
  fetchImpl: typeof fetch;
  temperature?: number | null;
}): Promise<{ model: string; message: OpenAiAssistantMessage }> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    tools: OPENAI_TOOLS,
    tool_choice: 'auto',
  };
  if (input.temperature != null) body.temperature = input.temperature;

  const res = await input.fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.apiKey}`,
      ...(input.extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    const message =
      (json as { error?: { message?: unknown } } | null)?.error?.message ??
      `AI request failed (${res.status}).`;
    const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
    throw new AiRequestError({
      status: res.status,
      code: typeof code === 'string' ? code : null,
      message: typeof message === 'string' ? message : `AI request failed (${res.status}).`,
    });
  }

  const parsed = json as OpenAiResponse;
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const message = choice?.message;
  if (!message || typeof message !== 'object') {
    throw new Error('OpenAI response missing assistant message.');
  }

  return {
    model: typeof parsed.model === 'string' && parsed.model ? parsed.model : input.model,
    message,
  };
}

async function callClaudeChat(input: {
  apiKey: string;
  model: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  messages: OpenAiConversationMessage[];
  fetchImpl: typeof fetch;
  temperature?: number | null;
}): Promise<{ model: string; message: OpenAiAssistantMessage }> {
  const url = anthropicMessagesUrl(input.baseUrl);
  const { system, messages } = toAnthropicMessages(input.messages);
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: 4096,
    messages,
    tools: openAiToolsAsAnthropicTools(),
  };
  if (system) body.system = system;
  if (input.temperature != null) body.temperature = input.temperature;

  const res = await input.fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
      ...(input.extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    const payload = json as { error?: { message?: unknown; type?: unknown } } | null;
    const message =
      payload?.error?.message ?? (typeof payload?.error?.type === 'string' ? payload.error.type : null) ?? `AI request failed (${res.status}).`;
    throw new AiRequestError({
      status: res.status,
      code: typeof payload?.error?.type === 'string' ? payload.error.type : null,
      message: typeof message === 'string' ? message : `AI request failed (${res.status}).`,
    });
  }

  const parsed = json as AnthropicMessageResponse;
  const blocks = Array.isArray(parsed.content) ? parsed.content : [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) textParts.push(text);
      continue;
    }
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name.trim() : '';
      if (!name) continue;
      const id = typeof block.id === 'string' && block.id.trim() ? block.id : randomUUID();
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name,
          arguments: (() => {
            try {
              return JSON.stringify(block.input ?? {});
            } catch {
              return '{}';
            }
          })(),
        },
      });
    }
  }

  return {
    model: typeof parsed.model === 'string' && parsed.model ? parsed.model : input.model,
    message: {
      role: 'assistant',
      content: textParts.join('\n').trim(),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
  };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  switch (name) {
    case 'list_messages': {
      const parsed = ListMessagesArgsSchema.parse(args);
      const limit = parsed.limit ?? 25;
      const offset = parsed.offset ?? 0;
      const items = listHttpMessages(ctx.db, { limit, offset }).map((item) => ({
        id: item.id,
        parentId: item.parentId,
        createdAt: item.createdAt,
        method: item.method,
        url: item.url,
        state: item.state,
        responseStatus: item.responseStatus,
        totalMs: item.totalMs,
      }));
      return {
        payload: { limit, offset, count: items.length, items },
        summary: `Loaded ${items.length} message summaries.`,
      };
    }
    case 'get_message': {
      const parsed = GetMessageArgsSchema.parse(args);
      const item = getHttpMessage(ctx.db, parsed.id);
      if (!item) {
        return {
          payload: { found: false, id: parsed.id },
          summary: `Message ${parsed.id} was not found.`,
        };
      }
      return {
        payload: { found: true, item: messageSummary(item) },
        summary: `Loaded message ${parsed.id} (${item.method} ${item.path}).`,
      };
    }
    case 'list_decoded_contract_calls': {
      const parsed = ListDecodedArgsSchema.parse(args);
      const limit = parsed.limit ?? 50;
      const offset = parsed.offset ?? 0;
      const items = listDecodedContracts(ctx.db, { limit, offset }).map((item) => ({
        id: item.id,
        messageId: item.messageId,
        createdAt: item.createdAt,
        rpcMethod: item.rpcMethod,
        kind: item.kind,
        chainId: item.chainId,
        to: item.to,
        selector: item.selector,
        contractName: item.contractName,
        functionName: item.functionName,
        summary: item.summary,
        risks: item.risks,
        decodedArgs: item.decodedArgs.slice(0, 12),
      }));
      return {
        payload: { limit, offset, count: items.length, items },
        summary: `Loaded ${items.length} decoded contract calls.`,
      };
    }
    case 'list_ws_connections': {
      const parsed = ListWsConnectionsArgsSchema.parse(args);
      const limit = parsed.limit ?? 200;
      const offset = parsed.offset ?? 0;
      const items = listWsConnections(ctx.db, { limit, offset });
      return {
        payload: { limit, offset, count: items.length, items },
        summary: `Loaded ${items.length} WS connections.`,
      };
    }
    case 'list_ws_frames': {
      const parsed = ListWsFramesArgsSchema.parse(args);
      const limit = parsed.limit ?? 200;
      const offset = parsed.offset ?? 0;
      const items = listWsFrames(ctx.db, { connectionId: parsed.connectionId, limit, offset });
      return {
        payload: { connectionId: parsed.connectionId, limit, offset, count: items.length, items },
        summary: `Loaded ${items.length} WS frames for ${parsed.connectionId}.`,
      };
    }
    case 'list_contracts': {
      const items = listContracts(ctx.db).map((item) => ({
        id: item.id,
        name: item.name,
        chainId: item.chainId,
        address: item.address,
        source: item.source,
        abiItemCount: item.abiItemCount,
        updatedAt: item.updatedAt,
      }));
      return {
        payload: { count: items.length, items },
        summary: `Loaded ${items.length} stored contract ABIs.`,
      };
    }
    case 'list_rpc_interactions': {
      const parsed = ListRpcInteractionsArgsSchema.parse(args);
      const limit = parsed.limit ?? 200;
      const offset = parsed.offset ?? 0;
      const out = listRpcInteractions(ctx.db, { limit, offset, source: parsed.source ?? null });
      return {
        payload: { limit, offset, source: parsed.source ?? null, count: out.items.length, items: out.items },
        summary: `Loaded ${out.items.length} RPC interactions${parsed.source ? ` (source=${parsed.source})` : ''}.`,
      };
    }
    case 'get_rpc_interaction': {
      const parsed = GetRpcInteractionArgsSchema.parse(args);
      const out = getRpcInteraction(ctx.db, parsed.id);
      if (!out) {
        return { payload: { found: false, id: parsed.id }, summary: `RPC interaction ${parsed.id} was not found.` };
      }
      return { payload: { found: true, item: out.item }, summary: `Loaded RPC interaction ${parsed.id}.` };
    }
    case 'get_contract': {
      const parsed = GetContractArgsSchema.parse(args);
      const item = getContract(ctx.db, parsed.id);
      if (!item) {
        return {
          payload: { found: false, id: parsed.id },
          summary: `Contract ${parsed.id} was not found.`,
        };
      }
      const abiHead = item.abi.slice(0, 40);
      return {
        payload: {
          found: true,
          item: {
            id: item.id,
            name: item.name,
            chainId: item.chainId,
            address: item.address,
            source: item.source,
            notes: item.notes,
            abiItemCount: item.abiItemCount,
            abiHead,
          },
        },
        summary: `Loaded contract ${item.name} (${item.id}) with ${item.abiItemCount} ABI items.`,
      };
    }
    case 'get_sitemap': {
      const hosts = getSitemap(ctx.db);
      const summary = summarizeHosts(hosts);
      return {
        payload: summary,
        summary: `Loaded sitemap with ${summary.hosts.length} host entries.`,
      };
    }
    case 'replay_message': {
      const parsed = ReplayMessageArgsSchema.parse(args);
      const out = await replayOnce({
        db: ctx.db,
        baselineId: parsed.messageId,
        overrides: parsed.overrides,
        publishEvent: ctx.publishEvent,
      });
      return {
        payload: {
          baselineId: out.baseline.id,
          variantId: out.variant.id,
          baselineStatus: out.baseline.responseStatus,
          variantStatus: out.variant.responseStatus,
          diff: out.diff,
        },
        summary: `Replayed ${parsed.messageId}; created variant ${out.variant.id}.`,
      };
    }
    case 'run_scanner': {
      const parsed = RunScannerArgsSchema.parse(args);
      const out = await runScanner({
        db: ctx.db,
        includeActive: parsed.includeActive ?? false,
        limit: parsed.limit ?? 200,
        messageIds: parsed.messageIds,
        publishEvent: ctx.publishEvent,
      });
      return {
        payload: {
          runId: out.runId,
          startedAt: out.startedAt,
          finishedAt: out.finishedAt,
          summary: out.summary,
          findings: out.findings.slice(0, 20),
        },
        summary: `Scanner completed with ${out.summary.findingsTotal} findings.`,
      };
    }
    case 'start_scan': {
      const parsed = StartScanArgsSchema.parse(args);
      const scan = await startZapScan({
        db: ctx.db,
        request: {
          ...parsed,
          source: 'ai',
        },
      });
      return {
        payload: { scan },
        summary: 'Scan started. Check progress using the get_scan tool.',
      };
    }
    case 'get_scan': {
      const parsed = GetScanArgsSchema.parse(args);
      if (parsed.scanId) {
        const scan = getZapScan({ db: ctx.db, scanId: parsed.scanId });
        if (!scan) {
          return {
            payload: { found: false, scanId: parsed.scanId },
            summary: `Scan ${parsed.scanId} was not found.`,
          };
        }
        return {
          payload: { found: true, scan },
          summary: `Loaded scan ${scan.id} (${scan.status}).`,
        };
      }

      const limit = parsed.limit ?? 20;
      const offset = parsed.offset ?? 0;
      const items = listZapScans({
        db: ctx.db,
        limit,
        offset,
        status: parsed.status,
      });
      return {
        payload: {
          limit,
          offset,
          status: parsed.status ?? null,
          count: items.length,
          items,
        },
        summary: `Loaded ${items.length} scan records${parsed.status ? ` (status=${parsed.status})` : ''}.`,
      };
    }
    case 'stop_scan': {
      const parsed = StopScanArgsSchema.parse(args);
      const scan = await stopZapScan({ db: ctx.db, scanId: parsed.scanId });
      if (!scan) {
        return {
          payload: { found: false, scanId: parsed.scanId },
          summary: `Scan ${parsed.scanId} was not found.`,
        };
      }
      return {
        payload: { found: true, scan },
        summary: `Stop requested for scan ${scan.id}.`,
      };
    }
    case 'run_subfinder': {
      const parsed = RunSubfinderArgsSchema.parse(args);
      const out = await runSubfinder({ request: parsed, db: ctx.db });
      const maxReturned = 200;
      const subdomains = out.subdomains.slice(0, maxReturned);
      const omittedCount = Math.max(0, out.subdomains.length - subdomains.length);
      return {
        payload: {
          domain: out.domain,
          options: out.options,
          run: out.run,
          count: out.count,
          returnedCount: subdomains.length,
          omittedCount,
          subdomains,
        },
        summary: out.run.ok
          ? `Subfinder discovered ${out.count} subdomains for ${out.domain}.`
          : `Subfinder finished with errors for ${out.domain}; discovered ${out.count} subdomains.`,
      };
    }
    case 'run_contract_audit': {
      if (!ctx.rpcCall) throw new Error('Contract audit unavailable: Foundry RPC is not configured.');
      const parsed = ContractAuditRunRequestSchema.parse(args);
      const out = await runContractAudit({
        db: ctx.db,
        request: parsed,
        rpcCall: ctx.rpcCall,
      });
      return {
        payload: {
          runId: out.runId,
          method: out.method,
          target: out.target,
          summary: out.summary,
          tooling: out.tooling,
          findings: out.findings.slice(0, 20),
        },
        summary: `Contract audit completed with ${out.summary.findingsTotal} findings.`,
      };
    }
    case 'run_fuzzer_campaign': {
      if (!ctx.invokeLocal) throw new Error('Fuzzer unavailable: local invoke bridge not configured.');
      const parsed = FuzzCampaignRequestSchema.parse(args);
      const out = await runFuzzCampaign({
        db: ctx.db,
        request: parsed,
        publishEvent: ctx.publishEvent,
        invokeLocal: ctx.invokeLocal,
      });
      return {
        payload: {
          campaign: out.campaign,
          anomalyCount: out.anomalies.length,
          anomalies: out.anomalies.slice(0, 20),
          clusters: out.clusters.slice(0, 20),
        },
        summary: `Fuzzer completed ${out.campaign.totalCases} cases with ${out.anomalies.length} anomalies.`,
      };
    }
    case 'list_findings': {
      const parsed = ListFindingsArgsSchema.parse(args);
      const limit = parsed.limit ?? 200;
      const offset = parsed.offset ?? 0;
      const items = listFindings(ctx.db, { limit, offset, status: parsed.status });
      return {
        payload: {
          limit,
          offset,
          status: parsed.status ?? null,
          count: items.length,
          items,
        },
        summary: `Loaded ${items.length} findings${parsed.status ? ` (status=${parsed.status})` : ''}.`,
      };
    }
    case 'generate_payload_candidates': {
      const parsed = GeneratePayloadCandidatesArgsSchema.parse(args);
      const message = getHttpMessage(ctx.db, parsed.messageId);
      if (!message) {
        return {
          payload: { found: false, messageId: parsed.messageId, candidates: [] },
          summary: `Baseline message ${parsed.messageId} was not found.`,
        };
      }
      const candidates = buildPayloadCandidates({
        message,
        objective: parsed.objective,
        maxCases: parsed.maxCases ?? 8,
      });
      return {
        payload: {
          found: true,
          messageId: parsed.messageId,
          objective: parsed.objective ?? null,
          candidates,
        },
        summary: `Generated ${candidates.length} payload candidates from ${parsed.messageId}.`,
      };
    }
    case 'search_payloads': {
      const parsed = SearchPayloadsArgsSchema.parse(args);
      const out = searchPayloadCatalog({
        q: parsed.q,
        category: parsed.category,
        subcategory: parsed.subcategory,
        sourceType: parsed.sourceType,
        sourcePath: parsed.sourcePath,
        tag: parsed.tag,
        limit: parsed.limit ?? 200,
        offset: parsed.offset ?? 0,
      });
      return {
        payload: {
          source: out.source,
          total: out.total,
          count: out.count,
          limit: out.limit,
          offset: out.offset,
          categories: out.categories,
          subcategories: out.subcategories,
          sourceTypes: out.sourceTypes,
          tags: out.tags,
          items: out.items.map((item) => ({
            id: item.id,
            value: truncate(item.value, 800),
            category: item.category,
            subcategory: item.subcategory,
            sourcePath: item.sourcePath,
            sourceType: item.sourceType,
            tags: item.tags,
          })),
        },
        summary: `Loaded ${out.count} payloads (total ${out.total}) from PayloadsAllTheThings catalog.`,
      };
    }
    case 'run_intruder_attack': {
      const parsed = IntruderAttackRequestSchema.parse(args);
      const hasPayloadSets = hasNonEmptyIntruderPayloadSets(parsed.payloadSets);
      const hasPayloadQueries = hasIntruderPayloadQueries(parsed.payloadSetQueries);

      let effectiveInput: IntruderAttackRequest = parsed;
      let payloadFallback:
        | {
            mode: 'catalog_query' | 'built_in_defaults';
            reason: string;
          }
        | null = null;

      if (!hasPayloadSets && !hasPayloadQueries) {
        effectiveInput = {
          ...parsed,
          payloadSetQueries: [buildDefaultIntruderCatalogQuery(parsed.maxRequests)],
        };
        payloadFallback = {
          mode: 'catalog_query',
          reason:
            'No payloadSets or payloadSetQueries were provided by the model; used a default intruder payload catalog query.',
        };
      }

      let out;
      try {
        out = await runIntruderAttack(effectiveInput);
      } catch (err) {
        const isNoPayloadSet =
          isIntruderInputError(err) && /no payload set available\.?/i.test(err instanceof Error ? err.message : '');
        if (!isNoPayloadSet) throw err;

        out = await runIntruderAttack({
          ...parsed,
          payloadSets: [Array.from(DEFAULT_INTRUDER_FALLBACK_PAYLOADS)],
        });
        payloadFallback = {
          mode: 'built_in_defaults',
          reason:
            payloadFallback == null
              ? 'Payload inputs resolved empty; used built-in fallback payloads.'
              : 'Default catalog query returned no payloads; used built-in fallback payloads.',
        };
      }

      const statusCounts: Record<string, number> = {};
      let errorCount = 0;
      for (const row of out.results) {
        const key = row.status == null ? 'null' : String(row.status);
        statusCounts[key] = (statusCounts[key] ?? 0) + 1;
        if (row.error) errorCount += 1;
      }
      return {
        payload: {
          attackType: out.attackType,
          startedAt: out.startedAt,
          finishedAt: out.finishedAt,
          durationMs: out.durationMs,
          positions: out.positions,
          requestCount: out.requestCount,
          capped: out.capped,
          maxRequests: out.maxRequests,
          stats: {
            statusCounts,
            errorCount,
          },
          payloadFallback,
          results: out.results.slice(0, 120),
          omittedResults: Math.max(0, out.results.length - 120),
        },
        summary: `Intruder attack executed ${out.requestCount} requests (${errorCount} errors)${payloadFallback ? ` with ${payloadFallback.mode} fallback payloads` : ''}.`,
      };
    }
    case 'explore_dex_protocols': {
      if (!ctx.invokeLocal) throw new Error('DEX explorer unavailable: local invoke bridge not configured.');
      const parsed = ExploreDexProtocolsArgsSchema.parse(args);

      const category = normalizeExplorerListArg(parsed.category);
      const chain = normalizeExplorerListArg(parsed.chain);
      const qs = new URLSearchParams();

      if (parsed.q) qs.set('q', parsed.q);
      if (category.length > 0) qs.set('category', category.join(','));
      if (chain.length > 0) qs.set('chain', chain.join(','));

      const numericEntries: Array<[string, number | undefined]> = [
        ['minTvl', parsed.minTvl],
        ['maxTvl', parsed.maxTvl],
        ['minMcap', parsed.minMcap],
        ['maxMcap', parsed.maxMcap],
        ['minMcapToTvl', parsed.minMcapToTvl],
        ['maxMcapToTvl', parsed.maxMcapToTvl],
        ['minChange1d', parsed.minChange1d],
        ['maxChange1d', parsed.maxChange1d],
        ['minChange7d', parsed.minChange7d],
        ['maxChange7d', parsed.maxChange7d],
      ];
      for (const [key, value] of numericEntries) {
        if (typeof value === 'number' && Number.isFinite(value)) qs.set(key, String(value));
      }

      if (parsed.includeFees) qs.set('includeFees', '1');
      if (parsed.includeRevenue) qs.set('includeRevenue', '1');
      if (parsed.sort) qs.set('sort', parsed.sort);
      if (parsed.order) qs.set('order', parsed.order);
      if (typeof parsed.limit === 'number') qs.set('limit', String(parsed.limit));
      if (typeof parsed.offset === 'number') qs.set('offset', String(parsed.offset));

      const localUrl = qs.size > 0 ? `/explorer?${qs.toString()}` : '/explorer';
      const out = await ctx.invokeLocal({ method: 'GET', url: localUrl });
      const body = isObject(out.body) ? out.body : null;

      if (out.statusCode < 200 || out.statusCode >= 300 || !body || body.ok !== true) {
        let message = `Explorer request failed with status ${out.statusCode}.`;
        if (body && body.ok === false && isObject(body.error) && typeof body.error.message === 'string') {
          message = body.error.message;
        }
        throw new Error(message);
      }

      const rows = Array.isArray(body.data) ? body.data : [];
      const meta = isObject(body.meta) ? body.meta : null;
      const total = meta && typeof meta.total === 'number' ? meta.total : rows.length;

      return {
        payload: {
          total,
          count: rows.length,
          meta,
          data: rows,
        },
        summary: `Loaded ${rows.length} explorer rows${total !== rows.length ? ` (total ${total})` : ''}.`,
      };
    }
    case 'get_explorer_project_details': {
      const parsed = GetExplorerProjectDetailsArgsSchema.parse(args);
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const resolved = await fetchLlamaProtocolDetails(fetchImpl, parsed.slug);
      return {
        payload: {
          requestedSlug: resolved.requestedSlug,
          resolvedSlug: resolved.resolvedSlug,
          suggestions: resolved.suggestions.length > 0 ? resolved.suggestions : null,
          baseUrl: resolved.baseUrl,
          triedBaseUrls: resolved.triedBaseUrls,
          data: resolved.data,
        },
        summary:
          resolved.requestedSlug === resolved.resolvedSlug
            ? `Loaded explorer project details for "${resolved.requestedSlug}".`
            : `Loaded explorer project details for "${resolved.requestedSlug}" via slug "${resolved.resolvedSlug}".`,
      };
    }
    case 'search_zoomeye_hosts': {
      if (!ctx.invokeLocal) throw new Error('ZoomEye search unavailable: local invoke bridge not configured.');
      const parsed = SearchZoomeyeHostsArgsSchema.parse(args);
      const qs = new URLSearchParams();
      qs.set('q', parsed.q);
      if (parsed.subType) qs.set('subType', parsed.subType);
      if (typeof parsed.page === 'number') qs.set('page', String(parsed.page));
      if (typeof parsed.pageSize === 'number') qs.set('pageSize', String(parsed.pageSize));

      const fields = normalizeExplorerListArg(parsed.fields);
      if (fields.length > 0) qs.set('fields', fields.join(','));
      const facets = normalizeExplorerListArg(parsed.facets);
      if (facets.length > 0) qs.set('facets', facets.join(','));
      if (parsed.ignoreCache) qs.set('ignoreCache', '1');

      const localUrl = `/zoomeye/hosts?${qs.toString()}`;
      const out = await ctx.invokeLocal({ method: 'GET', url: localUrl });
      const body = isObject(out.body) ? out.body : null;

      if (out.statusCode < 200 || out.statusCode >= 300 || !body || body.ok !== true) {
        let message = `ZoomEye request failed with status ${out.statusCode}.`;
        if (body && body.ok === false && isObject(body.error) && typeof body.error.message === 'string') {
          message = body.error.message;
        }
        throw new Error(message);
      }

      const rows = Array.isArray(body.items) ? body.items : [];
      const meta = isObject(body.meta) ? body.meta : null;
      const total = meta && typeof meta.total === 'number' ? meta.total : rows.length;
      return {
        payload: {
          total,
          count: rows.length,
          meta,
          items: rows,
        },
        summary: `Loaded ${rows.length} ZoomEye host results${total !== rows.length ? ` (total ${total})` : ''}.`,
      };
    }
    case 'search_shodan_hosts': {
      if (!ctx.invokeLocal) throw new Error('Shodan search unavailable: local invoke bridge not configured.');
      const parsed = SearchShodanHostsArgsSchema.parse(args);
      const qs = new URLSearchParams();
      qs.set('q', parsed.q);
      if (typeof parsed.page === 'number') qs.set('page', String(parsed.page));
      if (typeof parsed.pageSize === 'number') qs.set('pageSize', String(parsed.pageSize));

      const facets = normalizeExplorerListArg(parsed.facets);
      if (facets.length > 0) qs.set('facets', facets.join(','));
      if (parsed.minify) qs.set('minify', '1');

      const localUrl = `/shodan/hosts?${qs.toString()}`;
      const out = await ctx.invokeLocal({ method: 'GET', url: localUrl });
      const body = isObject(out.body) ? out.body : null;

      if (out.statusCode < 200 || out.statusCode >= 300 || !body || body.ok !== true) {
        let message = `Shodan request failed with status ${out.statusCode}.`;
        if (body && body.ok === false && isObject(body.error) && typeof body.error.message === 'string') {
          message = body.error.message;
        }
        throw new Error(message);
      }

      const rows = Array.isArray(body.items) ? body.items : [];
      const meta = isObject(body.meta) ? body.meta : null;
      const total = meta && typeof meta.total === 'number' ? meta.total : rows.length;
      const summary = `Loaded ${rows.length} Shodan host results${total !== rows.length ? ` (total ${total})` : ''}.`;
      recordPassedShodanSearch(ctx.db, {
        args: parsed as Record<string, unknown>,
        payload: {
          total,
          count: rows.length,
          meta,
          items: rows as unknown[],
        },
        summary,
      });
      return {
        payload: {
          total,
          count: rows.length,
          meta,
          items: rows,
        },
        summary,
      };
    }
    case 'get_webpage_markdown': {
      const parsed = GetWebPageMarkdownArgsSchema.parse(args);
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const timeoutMs = parsed.timeoutMs ?? 15_000;
      const maxChars = parsed.maxChars ?? 16_000;
      const noCache = parsed.noCache ?? false;

      let target: URL;
      try {
        target = new URL(parsed.url);
      } catch (err) {
        throw new Error(`get_webpage_markdown invalid url: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('get_webpage_markdown requires an http or https url.');
      }
      target.hash = '';
      const normalizedUrl = target.toString();
      const readerUrl = `https://r.jina.ai/${encodeURIComponent(normalizedUrl)}`;

      const res = await fetchWithTimeout(
        fetchImpl,
        readerUrl,
        {
          method: 'GET',
          headers: {
            accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1',
            ...(noCache ? { 'x-no-cache': 'true' } : {}),
          },
          redirect: 'follow',
        },
        timeoutMs,
      );
      const content = await res.text().catch(() => '');
      if (!res.ok) {
        throw new Error(
          `get_webpage_markdown failed (${res.status} ${res.statusText}): ${truncate(content, 500)}`,
        );
      }

      const text = content.trim();
      const titleMatch = text.match(/(?:^|\n)Title:\s*(.+)\s*(?:\n|$)/);
      const sourceMatch = text.match(/(?:^|\n)URL Source:\s*(.+)\s*(?:\n|$)/);
      const markdownMarker = 'Markdown Content:';
      const markdownStart = text.indexOf(markdownMarker);
      const markdown = markdownStart >= 0 ? text.slice(markdownStart + markdownMarker.length).trimStart() : text;
      const markdownOut = truncate(markdown, maxChars);
      const truncated = markdownOut.length < markdown.length;

      return {
        payload: {
          requestedUrl: normalizedUrl,
          readerUrl,
          sourceUrl: sourceMatch?.[1]?.trim() || normalizedUrl,
          title: titleMatch?.[1]?.trim() || null,
          markdown: markdownOut,
          markdownChars: markdown.length,
          truncated,
        },
        summary: `Fetched markdown for ${target.host}${target.pathname} (${markdownOut.length} chars${truncated ? ', truncated' : ''}).`,
      };
    }
    case 'goto': {
      const parsed = BrowserGotoArgsSchema.parse(args);
      return await gotoPage(parsed);
    }
    case 'click': {
      const parsed = BrowserClickArgsSchema.parse(args);
      return await clickPage(parsed);
    }
    case 'type': {
      const parsed = BrowserTypeArgsSchema.parse(args);
      return await typeIntoPage(parsed);
    }
    case 'wait_for': {
      const parsed = BrowserWaitForArgsSchema.parse(args);
      return await waitForPage(parsed);
    }
    case 'evaluate_js': {
      const parsed = BrowserEvaluateJsArgsSchema.parse(args);
      return await evaluatePageJs(parsed);
    }
    case 'extract_text': {
      const parsed = BrowserExtractTextArgsSchema.parse(args);
      return await extractPageText(parsed);
    }
    case 'extract_dom': {
      const parsed = BrowserExtractDomArgsSchema.parse(args);
      return await extractPageDom(parsed);
    }
    case 'screenshot': {
      const parsed = BrowserScreenshotArgsSchema.parse(args);
      return await screenshotPage(parsed);
    }
    case 'discover_protocol_addresses': {
      const parsed = DiscoverProtocolAddressesArgsSchema.parse(args);
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const maxUrls = parsed.maxUrls ?? 6;
      const maxAddresses = parsed.maxAddresses ?? 40;
      const protocol = await fetchLlamaProtocolDetails(fetchImpl, parsed.slug);
      const resolvedSlug = protocol.resolvedSlug;
      const suggestions = protocol.suggestions;
      const details = protocol.data;

      const detailsObj = isObject(details) ? details : null;
      const seedUrls = new Set<string>();
      collectUrlsFromUnknown(details, seedUrls, 120);

      const website = asHttpUrl(asTrimmedStringValue(detailsObj?.url));
      if (website) {
        seedUrls.add(website);
        try {
          const url = new URL(website);
          for (const p of ['/docs', '/developer', '/developers']) {
            url.pathname = p;
            url.search = '';
            url.hash = '';
            seedUrls.add(url.toString());
          }
        } catch {
          // Ignore malformed URL manipulations.
        }
      }

      const urls = Array.from(seedUrls).slice(0, maxUrls);
      const pages = await mapLimit(urls, 3, async (url) => {
        try {
          const res = await fetchTextWithTimeout(fetchImpl, url, 10_000);
          const addresses = extractHexAddressesFromText(res.text);
          return {
            url,
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            contentType: res.contentType,
            addresses,
          };
        } catch (err) {
          return {
            url,
            ok: false,
            status: null as number | null,
            contentType: null as string | null,
            addresses: [] as string[],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });

      const fromDetails = extractHexAddressesFromText(
        JSON.stringify(details, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      );

      const agg = new Map<string, { score: number; sources: Set<string> }>();
      const add = (address: string, source: string, weight = 1) => {
        const key = address.toLowerCase();
        const cur = agg.get(key) ?? { score: 0, sources: new Set<string>() };
        cur.score += weight;
        cur.sources.add(source);
        agg.set(key, cur);
      };

      for (const address of fromDetails) add(address, 'protocol_details', 2);
      for (const page of pages) {
        for (const address of page.addresses) add(address, page.url, 1);
      }

      const candidates = Array.from(agg.entries())
        .map(([address, v]) => ({
          address,
          score: v.score,
          sourceCount: v.sources.size,
          sources: Array.from(v.sources).slice(0, 6),
        }))
        .sort((a, b) => (b.score === a.score ? b.sourceCount - a.sourceCount : b.score - a.score))
        .slice(0, maxAddresses);

      return {
        payload: {
          requestedSlug: protocol.requestedSlug,
          resolvedSlug,
          suggestions: suggestions.length > 0 ? suggestions : null,
          baseUrl: protocol.baseUrl,
          triedBaseUrls: protocol.triedBaseUrls,
          fetchedUrls: urls,
          crawledPages: pages.map((p) => ({
            url: p.url,
            ok: p.ok,
            status: p.status,
            contentType: p.contentType ?? null,
            addressCount: p.addresses.length,
            error: 'error' in p ? p.error : null,
          })),
          candidates,
        },
        summary: `Discovered ${candidates.length} candidate addresses for "${resolvedSlug}".`,
      };
    }
    case 'get_contract_metadata': {
      const parsed = GetContractMetadataArgsSchema.parse(args);
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const chainId = parsed.chainId;
      const address = parsed.address.toLowerCase();
      const resolveProxy = parsed.resolveProxy ?? false;
      const blockscout = parsed.blockscout?.trim() || '';
      const providerErrors: Record<string, string> = {};

      const sourcifyBase =
        process.env.SOURCIFY_BASE_URL?.trim() ||
        process.env.SOURCIFY_SERVER_URL?.trim() ||
        'https://sourcify.dev/server';
      const sourcifyFields = 'all';

      const sourcifyLookup = async (targetAddress: string): Promise<{
        provider: 'sourcify';
        abi: Array<Record<string, unknown>> | null;
        proxyResolution: unknown | null;
        raw: unknown | null;
        error?: string;
      }> => {
        const url = `${sourcifyBase.replace(/\/+$/, '')}/v2/contract/${encodeURIComponent(chainId)}/${encodeURIComponent(targetAddress.toLowerCase())}?fields=${encodeURIComponent(sourcifyFields)}`;
        try {
          const raw = await fetchJsonAccept<unknown>(fetchImpl, url);
          const obj = isObject(raw) ? raw : null;
          return {
            provider: 'sourcify',
            abi: parseAbiItems(obj?.abi),
            proxyResolution: obj?.proxyResolution ?? null,
            raw,
          };
        } catch (err) {
          return {
            provider: 'sourcify',
            abi: null,
            proxyResolution: null,
            raw: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      };

      let primary: {
        provider: 'sourcify';
        abi: Array<Record<string, unknown>> | null;
        proxyResolution: unknown | null;
        raw: unknown;
        fallback?: 'etherscan' | 'blockscout';
        error?: string;
      } = await sourcifyLookup(address);
      if (primary.error) providerErrors.sourcify = primary.error;

      const implementationAddress = resolveProxy
        ? firstProxyImplementationAddress(primary.proxyResolution)
        : null;
      const implementation = implementationAddress
        ? await sourcifyLookup(implementationAddress)
        : null;
      if (implementation?.error) providerErrors.sourcifyImplementation = implementation.error;

      if (!primary.abi) {
        const apiKey = process.env.ETHERSCAN_API_KEY?.trim();
        if (apiKey) {
          try {
            const url = new URL('https://api.etherscan.io/v2/api');
            url.searchParams.set('chainid', chainId);
            url.searchParams.set('module', 'contract');
            url.searchParams.set('action', 'getabi');
            url.searchParams.set('address', address.toLowerCase());
            url.searchParams.set('apikey', apiKey);

            const response = await fetchJsonAccept<unknown>(fetchImpl, url.toString());
            const obj = isObject(response) ? response : null;
            const status = typeof obj?.status === 'string' ? obj.status : '';
            const result = obj?.result;

            if (status === '1' && typeof result === 'string') {
              try {
                const parsedAbi = parseAbiItems(JSON.parse(result) as unknown);
                if (parsedAbi) primary = { ...primary, abi: parsedAbi, fallback: 'etherscan' };
              } catch {
                // Ignore ABI parse failures; we'll continue to other fallbacks.
              }
            } else {
              providerErrors.etherscan = `Etherscan returned status=${status}.`;
            }
          } catch (err) {
            providerErrors.etherscan = err instanceof Error ? err.message : String(err);
          }
        }
      }

      if (!primary.abi && blockscout) {
        try {
          const url = new URL(`${blockscout.replace(/\/+$/, '')}/api`);
          url.searchParams.set('module', 'contract');
          url.searchParams.set('action', 'getabi');
          url.searchParams.set('address', address.toLowerCase());

          const response = await fetchJsonAccept<unknown>(fetchImpl, url.toString());
          const obj = isObject(response) ? response : null;
          const status = typeof obj?.status === 'string' ? obj.status : '';
          const result = obj?.result;

          if (status === '1') {
            try {
              const parsedAbi = parseAbiItems(
                typeof result === 'string' ? (JSON.parse(result) as unknown) : result,
              );
              if (parsedAbi) primary = { ...primary, abi: parsedAbi, fallback: 'blockscout' };
            } catch {
              // Ignore ABI parse failures from optional fallback source.
            }
          } else {
            providerErrors.blockscout = `Blockscout returned status=${status}.`;
          }
        } catch (err) {
          providerErrors.blockscout = err instanceof Error ? err.message : String(err);
        }
      }

      return {
        payload: {
          query: { chainId, address, resolveProxy },
          data: {
            provider: primary.provider,
            fallback: primary.fallback ?? null,
            abi: primary.abi,
            proxyResolution: primary.proxyResolution ?? null,
            implementation: implementation
              ? {
                  address: implementationAddress,
                  provider: implementation.provider,
                  abi: implementation.abi,
                }
              : null,
            providerErrors: Object.keys(providerErrors).length > 0 ? providerErrors : null,
            raw: primary.raw ?? null,
          },
        },
        summary: `Loaded contract metadata for ${address} on chain ${chainId}.`,
      };
    }
    case 'http_request': {
      const parsed = HttpRequestArgsSchema.parse(args);
      const session = normalizeRepeaterSessionName(parsed.session);
      const currentState = getRepeaterSessionState(session);
      const nextState = applyRepeaterMutation(currentState, parsed);
      const persistedState = upsertRepeaterSessionState(session, nextState);
      const out = await executeResolvedHttpRequest(ctx, resolveHttpRequestFromState(persistedState));
      return {
        payload: isObject(out.payload) ? { ...out.payload, session } : { session, result: out.payload },
        summary: out.summary,
      };
    }
    case 'repeater_request': {
      const parsed = RepeaterRequestArgsSchema.parse(args);
      const action = parsed.action ?? 'send';
      const session = normalizeRepeaterSessionName(parsed.session);

      if (action === 'reset') {
        const state = resetRepeaterSessionState(session);
        return {
          payload: repeaterStatePayload(session, state),
          summary: `Reset repeater session "${session}".`,
        };
      }

      if (action === 'get_state') {
        const state = getRepeaterSessionState(session);
        return {
          payload: repeaterStatePayload(session, state),
          summary: `Loaded repeater session "${session}".`,
        };
      }

      const currentState = getRepeaterSessionState(session);
      const nextState = hasRepeaterMutation(parsed) ? applyRepeaterMutation(currentState, parsed) : currentState;
      const persistedState = upsertRepeaterSessionState(session, nextState);

      if (action === 'update') {
        return {
          payload: repeaterStatePayload(session, persistedState),
          summary: `Updated repeater session "${session}".`,
        };
      }

      const out = await executeResolvedHttpRequest(ctx, resolveHttpRequestFromState(persistedState));
      return {
        payload: isObject(out.payload)
          ? { ...out.payload, session, state: repeaterStatePayload(session, persistedState) }
          : { session, state: repeaterStatePayload(session, persistedState), result: out.payload },
        summary: out.summary,
      };
    }
    case 'manage_foundry_environment': {
      const parsed = ManageFoundryEnvironmentArgsSchema.parse(args);

      const mutatingActions = new Set([
        'set_chain_id',
        'set_fork_config',
        'snapshot',
        'revert',
        'mine',
        'increase_time',
        'set_next_block_timestamp',
        'set_balance',
      ]);
      if (mutatingActions.has(parsed.action) && !envAllows('AGENT_AI_ALLOW_RPC_SIDE_EFFECTS')) {
        throw new Error(
          'manage_foundry_environment blocked: mutating EVM actions require AGENT_AI_ALLOW_RPC_SIDE_EFFECTS=1.',
        );
      }

      const invokeLocal = async (
        method: 'GET' | 'POST',
        url: string,
        payload?: unknown,
      ): Promise<unknown> => {
        if (!ctx.invokeLocal) {
          throw new Error('manage_foundry_environment unavailable: local invoke bridge not configured.');
        }
        const out = await ctx.invokeLocal({ method, url, payload });
        const body = isObject(out.body) ? out.body : null;
        if (out.statusCode >= 200 && out.statusCode < 300 && body?.ok === true) {
          return out.body;
        }
        let message = `Local EVM request failed with status ${out.statusCode}.`;
        if (body && isObject(body.error) && typeof body.error.message === 'string') {
          message = body.error.message;
        }
        throw new Error(message);
      };

      const callRpc = async (method: string, params: unknown[]): Promise<unknown> => {
        if (!ctx.rpcCall) throw new Error('manage_foundry_environment unavailable: Foundry RPC is not configured.');
        return await ctx.rpcCall(method, params);
      };

      const startedAt = Date.now();

      switch (parsed.action) {
        case 'get_config': {
          const body = await invokeLocal('GET', '/evm/config');
          return {
            payload: body,
            summary: 'Loaded Foundry EVM configuration.',
          };
        }
        case 'set_chain_id': {
          const body = await invokeLocal('POST', '/evm/config', { chainId: parsed.chainId });
          return {
            payload: body,
            summary: `Updated Foundry chainId to ${parsed.chainId}.`,
          };
        }
        case 'set_fork_config': {
          const patch: Record<string, unknown> = {};
          if (parsed.forkUrl !== undefined) patch.forkUrl = parsed.forkUrl;
          if (parsed.forkBlockNumber !== undefined) patch.forkBlockNumber = parsed.forkBlockNumber;
          if (parsed.chainId !== undefined) patch.chainId = parsed.chainId;
          const body = await invokeLocal('POST', '/evm/config', patch);
          return {
            payload: body,
            summary: 'Updated Foundry fork configuration.',
          };
        }
        case 'snapshot': {
          const body = await invokeLocal('POST', '/evm/snapshot');
          return {
            payload: body,
            summary: 'Created EVM snapshot.',
          };
        }
        case 'revert': {
          const body = await invokeLocal('POST', '/evm/revert', { snapshotId: parsed.snapshotId });
          return {
            payload: body,
            summary: `Attempted EVM revert to snapshot ${parsed.snapshotId}.`,
          };
        }
        case 'mine': {
          const blocks = parsed.blocks ?? 1;
          const result =
            blocks === 1
              ? await callRpc('evm_mine', [])
              : await callRpc('anvil_mine', [toRpcQuantity(BigInt(blocks))]);
          const durationMs = Date.now() - startedAt;
          return {
            payload: {
              action: parsed.action,
              blocks,
              durationMs,
              result,
            },
            summary: `Mined ${blocks} block${blocks === 1 ? '' : 's'} (${durationMs}ms).`,
          };
        }
        case 'increase_time': {
          const increaseResult = await callRpc('evm_increaseTime', [parsed.seconds]);
          const shouldMine = parsed.mineBlock ?? true;
          const mineResult = shouldMine ? await callRpc('evm_mine', []) : null;
          const durationMs = Date.now() - startedAt;
          return {
            payload: {
              action: parsed.action,
              seconds: parsed.seconds,
              mined: shouldMine,
              durationMs,
              increaseResult,
              mineResult,
            },
            summary: `Increased EVM time by ${parsed.seconds}s${shouldMine ? ' and mined 1 block' : ''} (${durationMs}ms).`,
          };
        }
        case 'set_next_block_timestamp': {
          const result = await callRpc('evm_setNextBlockTimestamp', [parsed.timestamp]);
          const durationMs = Date.now() - startedAt;
          return {
            payload: {
              action: parsed.action,
              timestamp: parsed.timestamp,
              durationMs,
              result,
            },
            summary: `Set next block timestamp to ${parsed.timestamp} (${durationMs}ms).`,
          };
        }
        case 'set_balance': {
          const quantity = parseRpcQuantityInput(parsed.balance);
          if (quantity == null) {
            throw new Error('manage_foundry_environment set_balance requires a non-negative integer/hex balance.');
          }
          const balanceHex = toRpcQuantity(quantity);
          const result = await callRpc('anvil_setBalance', [parsed.address.toLowerCase(), balanceHex]);
          const durationMs = Date.now() - startedAt;
          return {
            payload: {
              action: parsed.action,
              address: parsed.address.toLowerCase(),
              balanceHex,
              durationMs,
              result,
            },
            summary: `Set balance for ${parsed.address.toLowerCase()} to ${balanceHex} (${durationMs}ms).`,
          };
        }
        default: {
          throw new Error('Unsupported manage_foundry_environment action.');
        }
      }
    }
    case 'rpc_request': {
      if (!ctx.rpcCall) throw new Error('rpc_request unavailable: Foundry RPC is not configured.');
      const parsed = RpcRequestArgsSchema.parse(args);
      const params = parsed.params ?? [];

      const needsSideEffectOptIn = isRpcMethodLikelySideEffect(parsed.method);
      if (needsSideEffectOptIn && !parsed.allowSideEffects) {
        throw new Error(
          `rpc_request blocked: method "${parsed.method}" is likely state-changing. Re-run with allowSideEffects=true.`,
        );
      }
      if (needsSideEffectOptIn && !envAllows('AGENT_AI_ALLOW_RPC_SIDE_EFFECTS')) {
        throw new Error(
          `rpc_request blocked: state-changing RPC methods require AGENT_AI_ALLOW_RPC_SIDE_EFFECTS=1.`,
        );
      }

      const startedAt = Date.now();
      const result = await ctx.rpcCall(parsed.method, params);
      const durationMs = Date.now() - startedAt;

      return {
        payload: {
          method: parsed.method,
          paramsCount: params.length,
          durationMs,
          result,
        },
        summary: `rpc_request ${parsed.method} (${params.length} params) completed in ${durationMs}ms.`,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function buildMaxStepSummary(toolCalls: AiChatResponse['toolCalls']): string {
  if (toolCalls.length === 0) {
    return 'Summary\n- Reached the maximum autonomous steps without completing a response.\n\nNext Actions\n- Ask a narrower question so I can continue from a specific message or contract ID.';
  }
  const recent = toolCalls.slice(-5);
  const bulletLines = recent.map((call) => `- ${call.name}: ${call.summary}`);
  return [
    'Summary',
    '- Reached maximum autonomous steps during tool execution.',
    '',
    'Evidence',
    ...bulletLines,
    '',
    'Next Actions',
    '- Increase Max Steps and re-run, or ask me to continue from one of the tool outputs above.',
  ].join('\n');
}

export async function runAiAgentChat(input: RunAiAgentChatInput): Promise<AiChatResponse> {
  const emitProgress = (event: AiChatProgressEvent): void => {
    if (!input.onProgress) return;
    try {
      input.onProgress(event);
    } catch {
      // Progress callbacks must never break execution.
    }
  };
  const nowIso = (): string => new Date().toISOString();

  const fetchImpl = input.fetchImpl ?? fetch;
  const temperatureOverride =
    parseOptionalFloat(process.env.AI_TEMPERATURE) ?? parseOptionalFloat(process.env.OPENAI_TEMPERATURE);
  const aiTemperature =
    temperatureOverride != null ? temperatureOverride : shouldOmitTemperature(input.aiModel) ? null : 0.2;
  const conversation: OpenAiConversationMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(input.request.mode),
    },
    ...input.request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];

  const toolCalls: AiChatResponse['toolCalls'] = [];
  const warnings: string[] = [];
  let finalContent = '';
  let finalModel = input.aiModel;
  let status: AiChatResponse['status'] = 'completed';
  let autonomyNudges = 0;

  emitProgress({
    type: 'run_started',
    createdAt: nowIso(),
    mode: input.request.mode,
    provider: input.aiProvider,
    model: input.aiModel,
    maxSteps: input.request.maxSteps,
  });

  for (let step = 0; step < input.request.maxSteps; step += 1) {
    const stepNumber = step + 1;
    emitProgress({
      type: 'thinking',
      createdAt: nowIso(),
      step: stepNumber,
      maxSteps: input.request.maxSteps,
      message: `Planning step ${stepNumber}/${input.request.maxSteps}...`,
    });

    let result: { model: string; message: OpenAiAssistantMessage } | null = null;
    try {
      result =
        input.aiProvider === 'claude'
          ? await callClaudeChat({
              apiKey: input.aiApiKey,
              model: input.aiModel,
              baseUrl: input.aiBaseUrl,
              extraHeaders: input.aiExtraHeaders,
              messages: conversation,
              fetchImpl,
              temperature: aiTemperature,
            })
          : await callOpenAiChat({
              apiKey: input.aiApiKey,
              model: input.aiModel,
              baseUrl: input.aiBaseUrl,
              extraHeaders: input.aiExtraHeaders,
              messages: conversation,
              fetchImpl,
              temperature: aiTemperature,
            });
    } catch (err) {
      // If the default model isn't available for the key/org, fall back once to a widely available option.
      if (
        err instanceof AiRequestError &&
        (err.status === 404 || err.status === 400) &&
        input.aiProvider === 'openai' &&
        input.aiModel === 'gpt-5-nano-2025-08-07'
      ) {
        const fallback = FALLBACK_OPENAI_MODELS[0];
        const warning = `OpenAI model "${input.aiModel}" failed (${err.status}); retrying with "${fallback}".`;
        warnings.push(warning);
        emitProgress({ type: 'warning', createdAt: nowIso(), message: warning });
        result = await callOpenAiChat({
          apiKey: input.aiApiKey,
          model: fallback,
          baseUrl: input.aiBaseUrl,
          extraHeaders: input.aiExtraHeaders,
          messages: conversation,
          fetchImpl,
          // Keep the same temperature policy while falling back.
          temperature: temperatureOverride != null ? temperatureOverride : shouldOmitTemperature(fallback) ? null : 0.2,
        });
      } else {
        throw err;
      }
    }
    if (!result) throw new Error('AI chat request failed.');

    finalModel = result.model;
    const assistant = result.message;
    const assistantContent = parseAssistantContent(assistant.content);
    const assistantPreview = assistantContent.trim();
    if (assistantPreview) {
      emitProgress({
        type: 'thinking',
        createdAt: nowIso(),
        step: stepNumber,
        maxSteps: input.request.maxSteps,
        message: truncate(assistantPreview, 220),
      });
    }
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    conversation.push(
      calls.length
        ? {
            role: 'assistant',
            content: assistantContent,
            tool_calls: calls,
          }
        : {
            role: 'assistant',
            content: assistantContent,
          },
    );

    if (calls.length === 0) {
      const trimmed = assistantContent.trim();
      const hasNextActions = /(^|\n)\s*Next Actions\s*:/i.test(trimmed);
      const hasBullets = /(^|\n)\s*-\s+\S+/.test(trimmed);
      const canNudge = step + 1 < input.request.maxSteps && autonomyNudges < 1 && hasNextActions && hasBullets;
      if (canNudge) {
        autonomyNudges += 1;
        emitProgress({
          type: 'status',
          createdAt: nowIso(),
          message: 'Continuing autonomously from Next Actions...',
        });
        conversation.push({
          role: 'user',
          content:
            'Continue autonomously. Execute the Next Actions now using available tools (do not just restate them). ' +
            'Only stop once you have either executed them or you are genuinely blocked by missing user input/approval.',
        });
        continue;
      }

      finalContent = trimmed || 'Summary\n- No response content was produced.';
      break;
    }

    for (const call of calls) {
      const callId = typeof call.id === 'string' && call.id ? call.id : randomUUID();
      const toolName = typeof call.function?.name === 'string' ? call.function.name : 'unknown_tool';
      const args = parseToolArgs(call.function?.arguments);
      emitProgress({
        type: 'tool_call_started',
        createdAt: nowIso(),
        step: stepNumber,
        id: callId,
        name: toolName,
        args,
      });

      try {
        const executed = await executeTool(toolName, args, {
          db: input.db,
          publishEvent: input.publishEvent,
          rpcCall: input.rpcCall,
          invokeLocal: input.invokeLocal,
          fetchImpl,
        });

        toolCalls.push({
          id: callId,
          name: toolName,
          args,
          ok: true,
          summary: executed.summary,
          error: null,
        });
        emitProgress({
          type: 'tool_call_completed',
          createdAt: nowIso(),
          step: stepNumber,
          id: callId,
          name: toolName,
          args,
          ok: true,
          summary: executed.summary,
          error: null,
        });

        conversation.push({
          role: 'tool',
          tool_call_id: callId,
          content: safeJsonStringify(executed.payload, 14000),
        });
      } catch (err) {
        const message = err instanceof ReplayError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
        toolCalls.push({
          id: callId,
          name: toolName,
          args,
          ok: false,
          summary: `Tool failed: ${message}`,
          error: message,
        });
        warnings.push(`Tool ${toolName} failed: ${message}`);
        emitProgress({
          type: 'tool_call_completed',
          createdAt: nowIso(),
          step: stepNumber,
          id: callId,
          name: toolName,
          args,
          ok: false,
          summary: `Tool failed: ${message}`,
          error: message,
        });
        emitProgress({
          type: 'warning',
          createdAt: nowIso(),
          message: `Tool ${toolName} failed: ${message}`,
        });
        conversation.push({
          role: 'tool',
          tool_call_id: callId,
          content: safeJsonStringify({ ok: false, error: message }),
        });
      }
    }
  }

  if (!finalContent) {
    status = 'max_steps';
    finalContent = buildMaxStepSummary(toolCalls);
    emitProgress({
      type: 'status',
      createdAt: nowIso(),
      message: 'Run hit the max autonomous step limit.',
    });
  }

  return {
    ok: true,
    status,
    mode: input.request.mode,
    model: finalModel,
    assistant: {
      role: 'assistant',
      content: finalContent,
      createdAt: new Date().toISOString(),
    },
    toolCalls,
    warnings,
  };
}

export async function closeAiAgentResources(): Promise<void> {
  await closeBrowserAutomation();
}
