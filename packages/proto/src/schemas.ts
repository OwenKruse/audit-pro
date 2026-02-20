import { z } from 'zod';

export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  // Optional: used when an endpoint is intentionally stubbed.
  todo: z.unknown().optional(),
});

export const AgentMetricsSchema = z.object({
  httpRequestsTotal: z.number().int().nonnegative(),
  wsMessagesTotal: z.number().int().nonnegative(),
  uptimeSeconds: z.number().nonnegative(),
  httpRequestsPerSecond: z.number().nonnegative(),
  wsMessagesPerSecond: z.number().nonnegative(),
  db: z.object({
    writesTotal: z.number().int().nonnegative(),
    lastWriteMs: z.number().nonnegative().nullable(),
    avgWriteMs: z.number().nonnegative().nullable(),
  }),
});

export type AgentMetrics = z.infer<typeof AgentMetricsSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  version: z.string(),
  time: z.string(),
  db: z.object({
    path: z.string(),
    ok: z.boolean(),
  }),
  metrics: AgentMetricsSchema,
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const HttpMessageStateSchema = z.enum([
  'captured',
  'intercepted',
  'forwarded',
  'replayed',
  'dropped',
  'error',
  'tunnel',
]);

export type HttpMessageState = z.infer<typeof HttpMessageStateSchema>;

export const HttpMessageSummarySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable().default(null),
  createdAt: z.string(),
  scheme: z.enum(['http', 'https', 'connect', 'ws', 'wss']).default('http'),
  host: z.string(),
  port: z.number().int().nonnegative(),
  method: z.string(),
  path: z.string(),
  url: z.string(),
  state: HttpMessageStateSchema,
  responseStatus: z.number().int().nullable(),
  totalMs: z.number().nonnegative().nullable(),
});

export type HttpMessageSummary = z.infer<typeof HttpMessageSummarySchema>;

export const ReplayDiffSchema = z.object({
  baselineId: z.string(),
  variantId: z.string(),
  status: z.object({
    baseline: z.number().int().nullable(),
    variant: z.number().int().nullable(),
    changed: z.boolean(),
  }),
  headers: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.string()),
  }),
  body: z.object({
    changed: z.boolean(),
    kind: z.enum(['json', 'text', 'binary', 'empty']),
    jsonChanges: z
      .array(
        z.object({
          path: z.string(),
          before: z.unknown().optional(),
          after: z.unknown().optional(),
        }),
      )
      .default([]),
    truncated: z.boolean().default(false),
  }),
});

export type ReplayDiff = z.infer<typeof ReplayDiffSchema>;

export const HttpMessageDetailSchema = HttpMessageSummarySchema.extend({
  request: z.object({
    headers: z.record(z.string(), z.array(z.string())),
    cookies: z.record(z.string(), z.string()),
    query: z.record(z.string(), z.array(z.string())),
    bodyBase64: z.string().nullable(),
    bodyText: z.string().nullable(),
    bodyJson: z.unknown().nullable(),
  }),
  response: z.object({
    headers: z.record(z.string(), z.array(z.string())),
    bodyBase64: z.string().nullable(),
    bodyText: z.string().nullable(),
    bodyJson: z.unknown().nullable(),
  }),
  timing: z.object({
    dnsMs: z.number().nonnegative().nullable(),
    connectMs: z.number().nonnegative().nullable(),
    tlsMs: z.number().nonnegative().nullable(),
    ttfbMs: z.number().nonnegative().nullable(),
    totalMs: z.number().nonnegative().nullable(),
  }),
  error: z.string().nullable(),
  replayDiff: ReplayDiffSchema.nullable().default(null),
});

export type HttpMessageDetail = z.infer<typeof HttpMessageDetailSchema>;

export const ListMessagesResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(HttpMessageSummarySchema),
});

export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

export type SitemapPathNode = {
  segment: string;
  requests: number;
  alerts: number;
  children: SitemapPathNode[];
};

export const SitemapPathNodeSchema: z.ZodType<SitemapPathNode> = z.lazy(() =>
  z.object({
    segment: z.string(),
    requests: z.number().int().nonnegative(),
    alerts: z.number().int().nonnegative(),
    children: z.array(SitemapPathNodeSchema),
  }),
);

export const SitemapHostSchema = z.object({
  host: z.string(),
  port: z.number().int().nonnegative(),
  displayLabel: z.string(),
  requests: z.number().int().nonnegative(),
  alerts: z.number().int().nonnegative(),
  pathTree: z.array(SitemapPathNodeSchema),
});

export type SitemapHost = z.infer<typeof SitemapHostSchema>;

export const SitemapResponseSchema = z.object({
  ok: z.literal(true),
  hosts: z.array(SitemapHostSchema),
});

export type SitemapResponse = z.infer<typeof SitemapResponseSchema>;

export const GetMessageResponseSchema = z.object({
  ok: z.literal(true),
  item: HttpMessageDetailSchema,
});

export type GetMessageResponse = z.infer<typeof GetMessageResponseSchema>;

export const ReplayOverridesSchema = z
  .object({
    method: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.array(z.string())).optional(),
    bodyText: z.string().optional(),
    bodyBase64: z.string().optional(),
  })
  .refine((v) => !(v.bodyText != null && v.bodyBase64 != null), {
    message: 'Provide at most one of bodyText or bodyBase64.',
  });

export type ReplayOverrides = z.infer<typeof ReplayOverridesSchema>;

export const ReplayRequestSchema = z.object({
  messageId: z.string(),
  overrides: ReplayOverridesSchema.optional(),
});

export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;

export const ReplayResponseSchema = z.object({
  ok: z.literal(true),
  baseline: HttpMessageDetailSchema,
  variant: HttpMessageDetailSchema,
  diff: ReplayDiffSchema,
});

export type ReplayResponse = z.infer<typeof ReplayResponseSchema>;

export const ReplayBatchRequestSchema = z.object({
  items: z.array(
    z.object({
      messageId: z.string(),
      overrides: ReplayOverridesSchema.optional(),
    }),
  ),
});

export type ReplayBatchRequest = z.infer<typeof ReplayBatchRequestSchema>;

export const ReplayBatchResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    baselineId: z.string(),
    variantId: z.string(),
    diff: ReplayDiffSchema,
  }),
  z.object({
    ok: z.literal(false),
    baselineId: z.string(),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type ReplayBatchResult = z.infer<typeof ReplayBatchResultSchema>;

export const ReplayBatchResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(ReplayBatchResultSchema),
});

export type ReplayBatchResponse = z.infer<typeof ReplayBatchResponseSchema>;

export const FuzzCampaignConfigSchema = z.object({
  maxCases: z.number().int().min(1).max(200).default(24),
  concurrency: z.number().int().min(1).max(20).default(4),
  perHostDelayMs: z.number().int().min(0).max(5000).default(50),
  timeoutMs: z.number().int().min(250).max(120000).default(15000),
  backoffBaseMs: z.number().int().min(0).max(10000).default(250),
  anvilSnapshot: z.boolean().default(true),
  revertAfterRun: z.boolean().default(true),
});

export type FuzzCampaignConfig = z.infer<typeof FuzzCampaignConfigSchema>;

export const FuzzCampaignRequestSchema = z.object({
  messageId: z.string(),
  fieldPath: z.string().min(1),
  maxCases: FuzzCampaignConfigSchema.shape.maxCases.optional(),
  concurrency: FuzzCampaignConfigSchema.shape.concurrency.optional(),
  perHostDelayMs: FuzzCampaignConfigSchema.shape.perHostDelayMs.optional(),
  timeoutMs: FuzzCampaignConfigSchema.shape.timeoutMs.optional(),
  backoffBaseMs: FuzzCampaignConfigSchema.shape.backoffBaseMs.optional(),
  anvilSnapshot: FuzzCampaignConfigSchema.shape.anvilSnapshot.optional(),
  revertAfterRun: FuzzCampaignConfigSchema.shape.revertAfterRun.optional(),
});

export type FuzzCampaignRequest = z.infer<typeof FuzzCampaignRequestSchema>;

export const FuzzTargetSchema = z.object({
  fieldPath: z.string(),
  baselineType: z.enum(['number', 'string', 'boolean', 'array', 'object', 'null', 'unknown']),
  baselineValue: z.unknown(),
});

export type FuzzTarget = z.infer<typeof FuzzTargetSchema>;

export const FuzzCaseAnomalySchema = z.object({
  statusChanged: z.boolean(),
  errorChanged: z.boolean(),
  bodyChanged: z.boolean(),
  shapeChanged: z.boolean(),
  throttled: z.boolean(),
  timeout: z.boolean(),
});

export type FuzzCaseAnomaly = z.infer<typeof FuzzCaseAnomalySchema>;

export const FuzzCaseResultSchema = z.object({
  caseId: z.string(),
  mutationKind: z.string(),
  mutationLabel: z.string(),
  mutationPath: z.string(),
  operation: z.enum(['set', 'remove']),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  variantId: z.string(),
  status: z.number().int().nullable(),
  error: z.string().nullable(),
  totalMs: z.number().nonnegative().nullable(),
  responseShape: z.string(),
  clusterId: z.string(),
  anomaly: FuzzCaseAnomalySchema,
  diff: ReplayDiffSchema,
});

export type FuzzCaseResult = z.infer<typeof FuzzCaseResultSchema>;

export const FuzzClusterSchema = z.object({
  id: z.string(),
  signature: z.object({
    status: z.number().int().nullable(),
    error: z.string(),
    shape: z.string(),
  }),
  caseCount: z.number().int().nonnegative(),
  anomalyCount: z.number().int().nonnegative(),
  caseIds: z.array(z.string()),
  sampleCaseId: z.string().nullable(),
});

export type FuzzCluster = z.infer<typeof FuzzClusterSchema>;

export const FuzzSnapshotSchema = z.object({
  attempted: z.boolean(),
  snapshotId: z.string().nullable(),
  reverted: z.boolean(),
  warning: z.string().nullable(),
});

export type FuzzSnapshot = z.infer<typeof FuzzSnapshotSchema>;

export const FuzzCampaignSummarySchema = z.object({
  baselineId: z.string(),
  baselineStatus: z.number().int().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().nonnegative(),
  totalCases: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  config: FuzzCampaignConfigSchema,
  target: FuzzTargetSchema,
  snapshot: FuzzSnapshotSchema,
});

export type FuzzCampaignSummary = z.infer<typeof FuzzCampaignSummarySchema>;

export const FuzzCampaignResponseSchema = z.object({
  ok: z.literal(true),
  campaign: FuzzCampaignSummarySchema,
  cases: z.array(FuzzCaseResultSchema),
  clusters: z.array(FuzzClusterSchema),
  anomalies: z.array(FuzzCaseResultSchema),
});

export type FuzzCampaignResponse = z.infer<typeof FuzzCampaignResponseSchema>;

export const WsFrameSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  direction: z.enum(['client_to_server', 'server_to_client']),
  opcode: z.number().int().nonnegative(),
  payloadBase64: z.string(),
  payloadText: z.string().nullable(),
  payloadJson: z.unknown().nullable(),
});

export type WsFrame = z.infer<typeof WsFrameSchema>;

export const WsConnectionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  scheme: z.enum(['ws', 'wss']),
  host: z.string(),
  port: z.number().int().nonnegative(),
  path: z.string(),
  url: z.string(),
});

export type WsConnection = z.infer<typeof WsConnectionSchema>;

export const ListWsFramesResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(WsFrameSchema),
});

export type ListWsFramesResponse = z.infer<typeof ListWsFramesResponseSchema>;

export const ListWsConnectionsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(WsConnectionSchema),
});

export type ListWsConnectionsResponse = z.infer<typeof ListWsConnectionsResponseSchema>;

export const RpcInteractionSourceSchema = z.enum(['wallet', 'foundry']);
export type RpcInteractionSource = z.infer<typeof RpcInteractionSourceSchema>;

export const RpcInteractionStatusSchema = z.enum(['success', 'error']);
export type RpcInteractionStatus = z.infer<typeof RpcInteractionStatusSchema>;

export const RpcInteractionTxSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  value: z.string().nullable(),
  data: z.string().nullable(),
  gas: z.string().nullable(),
});

export type RpcInteractionTx = z.infer<typeof RpcInteractionTxSchema>;

export const RpcInteractionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  source: RpcInteractionSourceSchema,
  rpcUrl: z.string().nullable(),
  chainId: z.number().int().positive().nullable(),
  method: z.string(),
  params: z.array(z.unknown()).default([]),
  status: RpcInteractionStatusSchema,
  error: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  tx: RpcInteractionTxSchema.nullable(),
  txHash: z.string().nullable(),
  result: z.unknown().nullable().default(null),
});

export type RpcInteraction = z.infer<typeof RpcInteractionSchema>;

export const RpcInteractionRecordRequestSchema = z.object({
  source: RpcInteractionSourceSchema,
  rpcUrl: z.string().nullable().optional(),
  chainId: z.number().int().positive().nullable().optional(),
  method: z.string().trim().min(1),
  params: z.array(z.unknown()).optional(),
  status: RpcInteractionStatusSchema,
  error: z.string().nullable().optional(),
  durationMs: z.number().nonnegative().nullable().optional(),
  tx: RpcInteractionTxSchema.nullable().optional(),
  txHash: z.string().nullable().optional(),
  result: z.unknown().nullable().optional(),
});

export type RpcInteractionRecordRequest = z.infer<typeof RpcInteractionRecordRequestSchema>;

export const RpcInteractionRecordResponseSchema = z.object({
  ok: z.literal(true),
  item: RpcInteractionSchema,
});

export type RpcInteractionRecordResponse = z.infer<typeof RpcInteractionRecordResponseSchema>;

export const ListRpcInteractionsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(RpcInteractionSchema),
});

export type ListRpcInteractionsResponse = z.infer<typeof ListRpcInteractionsResponseSchema>;

export const GetRpcInteractionResponseSchema = z.object({
  ok: z.literal(true),
  item: RpcInteractionSchema,
});

export type GetRpcInteractionResponse = z.infer<typeof GetRpcInteractionResponseSchema>;

export const ProxyStatusSchema = z.object({
  ok: z.literal(true),
  proxy: z.object({
    host: z.string(),
    port: z.number().int().nonnegative(),
  }),
  interceptEnabled: z.boolean(),
  interceptQueueSize: z.number().int().nonnegative(),
  ignoreHosts: z.array(z.string()).default([]),
});

export type ProxyStatus = z.infer<typeof ProxyStatusSchema>;

export const ProxyIgnoreHostsRequestSchema = z.object({
  hosts: z.array(z.string().trim()).max(1000),
});

export type ProxyIgnoreHostsRequest = z.infer<typeof ProxyIgnoreHostsRequestSchema>;

export const ProxyIgnoreHostsResponseSchema = z.object({
  ok: z.literal(true),
  hosts: z.array(z.string()),
});

export type ProxyIgnoreHostsResponse = z.infer<typeof ProxyIgnoreHostsResponseSchema>;

export const ProxySmokeTestResponseSchema = z.object({
  ok: z.literal(true),
  messageId: z.string(),
  url: z.string(),
  statusCode: z.number().int().nonnegative(),
});

export type ProxySmokeTestResponse = z.infer<typeof ProxySmokeTestResponseSchema>;

export const InterceptQueueEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  method: z.string(),
  host: z.string(),
  port: z.number().int().nonnegative(),
  path: z.string(),
  url: z.string(),
});

export type InterceptQueueEntry = z.infer<typeof InterceptQueueEntrySchema>;

export const ListInterceptQueueResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(InterceptQueueEntrySchema),
});

export type ListInterceptQueueResponse = z.infer<typeof ListInterceptQueueResponseSchema>;

export const CaseStatsSchema = z.object({
  httpMessages: z.number().int().nonnegative(),
  wsConnections: z.number().int().nonnegative(),
  wsFrames: z.number().int().nonnegative(),
  flows: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
});

export type CaseStats = z.infer<typeof CaseStatsSchema>;

export const CaseManifestV1Schema = z.object({
  format: z.literal('cipherscope-case'),
  version: z.literal(1),
  createdAt: z.string(),
  agent: z.object({ name: z.string(), version: z.string() }),
  dbFile: z.string(),
  stats: CaseStatsSchema,
});

export type CaseManifestV1 = z.infer<typeof CaseManifestV1Schema>;

export const CaseImportResponseSchema = z.object({
  ok: z.literal(true),
  manifest: CaseManifestV1Schema.nullable(),
  imported: CaseStatsSchema,
});

export type CaseImportResponse = z.infer<typeof CaseImportResponseSchema>;

export const ContractAbiItemSchema = z.record(z.string(), z.unknown());
export type ContractAbiItem = z.infer<typeof ContractAbiItemSchema>;

export const ContractAbiSchema = z.array(ContractAbiItemSchema).min(1);
export type ContractAbi = z.infer<typeof ContractAbiSchema>;

export const ContractSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  name: z.string(),
  chainId: z.number().int().nullable(),
  address: z.string().nullable(),
  source: z.string(),
  notes: z.string().nullable(),
  abiItemCount: z.number().int().nonnegative(),
});

export type ContractSummary = z.infer<typeof ContractSummarySchema>;

export const ContractDetailSchema = ContractSummarySchema.extend({
  abi: ContractAbiSchema,
});

export type ContractDetail = z.infer<typeof ContractDetailSchema>;

export const ListContractsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(ContractSummarySchema),
});

export type ListContractsResponse = z.infer<typeof ListContractsResponseSchema>;

const EvmAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'address must be a 0x-prefixed 20-byte hex string');

export const UpsertContractRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, 'name is required'),
  chainId: z.number().int().nonnegative().nullable().optional(),
  address: EvmAddressSchema.nullable().optional(),
  source: z.string().trim().min(1).optional(),
  notes: z.string().nullable().optional(),
  abi: ContractAbiSchema,
});

export type UpsertContractRequest = z.infer<typeof UpsertContractRequestSchema>;

export const UpsertContractResponseSchema = z.object({
  ok: z.literal(true),
  item: ContractDetailSchema,
});

export type UpsertContractResponse = z.infer<typeof UpsertContractResponseSchema>;

export const DeleteContractResponseSchema = z.object({
  ok: z.literal(true),
  deleted: z.boolean(),
});

export type DeleteContractResponse = z.infer<typeof DeleteContractResponseSchema>;

export const ContractDecodeKindSchema = z.enum(['transaction', 'typed_data', 'logs']);
export type ContractDecodeKind = z.infer<typeof ContractDecodeKindSchema>;

export const DecodedArgSchema = z.object({
  name: z.string(),
  type: z.string(),
  value: z.unknown(),
});

export type DecodedArg = z.infer<typeof DecodedArgSchema>;

export const ContractDecodedItemSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  requestIndex: z.number().int().nonnegative(),
  createdAt: z.string(),
  host: z.string(),
  path: z.string(),
  rpcMethod: z.string(),
  kind: ContractDecodeKindSchema,
  chainId: z.number().int().nullable(),
  to: z.string().nullable(),
  selector: z.string().nullable(),
  contractId: z.string().nullable(),
  contractName: z.string().nullable(),
  functionName: z.string().nullable(),
  summary: z.string(),
  risks: z.array(z.string()),
  decodedArgs: z.array(DecodedArgSchema).default([]),
  decoded: z.unknown().nullable(),
});

export type ContractDecodedItem = z.infer<typeof ContractDecodedItemSchema>;

export const ListDecodedContractsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(ContractDecodedItemSchema),
});

export type ListDecodedContractsResponse = z.infer<typeof ListDecodedContractsResponseSchema>;

export const FindingSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);

export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const ScannerModeSchema = z.enum(['passive', 'active']);

export type ScannerMode = z.infer<typeof ScannerModeSchema>;

export const ScannerFindingStatusSchema = z.enum(['open', 'triaged', 'resolved']);

export type ScannerFindingStatus = z.infer<typeof ScannerFindingStatusSchema>;

export const ScannerEvidenceSchema = z.object({
  messageId: z.string(),
  field: z.string(),
  note: z.string(),
  replayVariantId: z.string().nullable().default(null),
});

export type ScannerEvidence = z.infer<typeof ScannerEvidenceSchema>;

export const ScannerFindingSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  checkId: z.string(),
  mode: ScannerModeSchema,
  severity: FindingSeveritySchema,
  confidence: z.number().min(0).max(1),
  status: ScannerFindingStatusSchema.default('open'),
  title: z.string(),
  summary: z.string(),
  remediation: z.string(),
  reproducibility: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  evidence: z.array(ScannerEvidenceSchema).min(1),
});

export type ScannerFinding = z.infer<typeof ScannerFindingSchema>;

export const ScannerRunRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(2000).default(250),
    includeActive: z.boolean().default(false),
    messageIds: z.array(z.string().min(1)).max(1000).optional(),
  });

export type ScannerRunRequest = z.infer<typeof ScannerRunRequestSchema>;

export const ScannerRunSummarySchema = z.object({
  scannedMessages: z.number().int().nonnegative(),
  passiveChecks: z.number().int().nonnegative(),
  activeChecks: z.number().int().nonnegative(),
  findingsTotal: z.number().int().nonnegative(),
  bySeverity: z.object({
    info: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
  }),
});

export type ScannerRunSummary = z.infer<typeof ScannerRunSummarySchema>;

export const ScannerRunResponseSchema = z.object({
  ok: z.literal(true),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  includeActive: z.boolean(),
  summary: ScannerRunSummarySchema,
  findings: z.array(ScannerFindingSchema),
});

export type ScannerRunResponse = z.infer<typeof ScannerRunResponseSchema>;

const EvmQuantitySchema = z
  .string()
  .trim()
  .regex(/^(0x[0-9a-fA-F]+|[0-9]+)$/, 'quantity must be decimal or 0x-prefixed hex');

const EvmBytesSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]*$/, 'value must be 0x-prefixed hex bytes');

export const ContractAuditTxSchema = z.object({
  from: EvmAddressSchema.nullable().optional(),
  to: EvmAddressSchema,
  data: EvmBytesSchema.default('0x'),
  value: EvmQuantitySchema.nullable().optional(),
  gas: EvmQuantitySchema.nullable().optional(),
});

export type ContractAuditTx = z.infer<typeof ContractAuditTxSchema>;

export const ContractAuditRunRequestSchema = z.object({
  sourceInteractionId: z.string().min(1).optional(),
  method: z.string().trim().min(1),
  rpcUrl: z.string().trim().url().nullable().optional(),
  chainId: z.number().int().positive().nullable().optional(),
  tx: ContractAuditTxSchema,
});

export type ContractAuditRunRequest = z.infer<typeof ContractAuditRunRequestSchema>;

export const ContractAuditToolingSchema = z.object({
  tool: z.literal('cast_4byte'),
  attempted: z.boolean(),
  available: z.boolean(),
  success: z.boolean(),
  selector: z.string().nullable(),
  signatures: z.array(z.string()),
  command: z.string(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});

export type ContractAuditTooling = z.infer<typeof ContractAuditToolingSchema>;

export const ContractAuditRunSummarySchema = z.object({
  checksRun: z.number().int().nonnegative(),
  findingsTotal: z.number().int().nonnegative(),
  bySeverity: z.object({
    info: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
  }),
});

export type ContractAuditRunSummary = z.infer<typeof ContractAuditRunSummarySchema>;

export const ContractAuditRunResponseSchema = z.object({
  ok: z.literal(true),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  method: z.string(),
  target: z.object({
    sourceInteractionId: z.string().nullable(),
    chainId: z.number().int().nullable(),
    to: EvmAddressSchema,
    selector: z.string().nullable(),
  }),
  summary: ContractAuditRunSummarySchema,
  tooling: ContractAuditToolingSchema,
  findings: z.array(ScannerFindingSchema),
});

export type ContractAuditRunResponse = z.infer<typeof ContractAuditRunResponseSchema>;

export const ListScannerFindingsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(ScannerFindingSchema),
});

export type ListScannerFindingsResponse = z.infer<typeof ListScannerFindingsResponseSchema>;

export const ListFindingsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(ScannerFindingSchema),
});

export type ListFindingsResponse = z.infer<typeof ListFindingsResponseSchema>;

export const CreateFindingRequestSchema = z.object({
  checkId: z.string().min(1).default('manual.custom'),
  mode: ScannerModeSchema.default('passive'),
  severity: FindingSeveritySchema,
  confidence: z.number().min(0).max(1).default(0.8),
  status: ScannerFindingStatusSchema.default('open'),
  title: z.string().min(1),
  summary: z.string().min(1),
  remediation: z.string().default(''),
  reproducibility: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  evidence: z.array(ScannerEvidenceSchema).min(1),
});

export type CreateFindingRequest = z.infer<typeof CreateFindingRequestSchema>;

export const CreateFindingResponseSchema = z.object({
  ok: z.literal(true),
  item: ScannerFindingSchema,
});

export type CreateFindingResponse = z.infer<typeof CreateFindingResponseSchema>;

export const UpdateFindingRequestSchema = z
  .object({
    severity: FindingSeveritySchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: ScannerFindingStatusSchema.optional(),
    title: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    remediation: z.string().optional(),
    reproducibility: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    evidence: z.array(ScannerEvidenceSchema).min(1).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });

export type UpdateFindingRequest = z.infer<typeof UpdateFindingRequestSchema>;

export const UpdateFindingResponseSchema = z.object({
  ok: z.literal(true),
  item: ScannerFindingSchema,
});

export type UpdateFindingResponse = z.infer<typeof UpdateFindingResponseSchema>;

export const AiAgentModeSchema = z.enum([
  'smart_contract_audit',
  'static_analysis',
  'symbolic_execution',
  'fuzzing_campaign',
]);

export type AiAgentMode = z.infer<typeof AiAgentModeSchema>;

export const AiProviderSchema = z.enum([
  'openai',
  'openrouter',
  'gemini',
  'grok',
  'claude',
  'deepseek',
]);

export type AiProvider = z.infer<typeof AiProviderSchema>;

export const AiChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(12000),
});

export type AiChatMessage = z.infer<typeof AiChatMessageSchema>;

export const AiChatRequestSchema = z.object({
  messages: z.array(AiChatMessageSchema).max(80),
  mode: AiAgentModeSchema.default('smart_contract_audit'),
  maxSteps: z.number().int().min(1).max(500).default(250),
  provider: AiProviderSchema.default('openai'),
  model: z.string().trim().min(1).max(200).optional(),
});

export type AiChatRequest = z.infer<typeof AiChatRequestSchema>;

export const AiToolCallTraceSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  summary: z.string(),
  error: z.string().nullable().default(null),
});

export type AiToolCallTrace = z.infer<typeof AiToolCallTraceSchema>;

export const AiChatResponseSchema = z.object({
  ok: z.literal(true),
  status: z.enum(['completed', 'max_steps']),
  mode: AiAgentModeSchema,
  model: z.string(),
  assistant: z.object({
    role: z.literal('assistant'),
    content: z.string(),
    createdAt: z.string(),
  }),
  toolCalls: z.array(AiToolCallTraceSchema),
  warnings: z.array(z.string()).default([]),
});

export type AiChatResponse = z.infer<typeof AiChatResponseSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    time: z.string(),
    agentVersion: z.string(),
  }),
  z.object({
    type: z.literal('metrics'),
    time: z.string(),
    metrics: AgentMetricsSchema,
  }),
  z.object({
    type: z.literal('http_message'),
    time: z.string(),
    message: HttpMessageSummarySchema,
  }),
  z.object({
    type: z.literal('intercept_queue'),
    time: z.string(),
    size: z.number().int().nonnegative(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
