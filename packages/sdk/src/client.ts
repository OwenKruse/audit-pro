import {
  AiChatRequestSchema,
  AiChatResponseSchema,
  AgentEventSchema,
  AgentMetricsSchema,
  CaseImportResponseSchema,
  ContractAuditRunRequestSchema,
  ContractAuditRunResponseSchema,
  CreateFindingRequestSchema,
  CreateFindingResponseSchema,
  DeleteContractResponseSchema,
  FuzzCampaignRequestSchema,
  FuzzCampaignResponseSchema,
  GetMessageResponseSchema,
  HealthResponseSchema,
  ListContractsResponseSchema,
  ListDecodedContractsResponseSchema,
  ListFindingsResponseSchema,
  ListInterceptQueueResponseSchema,
  ListMessagesResponseSchema,
  ListScannerFindingsResponseSchema,
  ListWsFramesResponseSchema,
  ProxyIgnoreHostsRequestSchema,
  ProxyIgnoreHostsResponseSchema,
  ProxyStatusSchema,
  ProxySmokeTestResponseSchema,
  ReplayBatchResponseSchema,
  ReplayResponseSchema,
  ScannerRunRequestSchema,
  ScannerRunResponseSchema,
  SitemapResponseSchema,
  UpdateFindingRequestSchema,
  UpdateFindingResponseSchema,
  UpsertContractResponseSchema,
  type AgentEvent,
  type AgentMetrics,
  type AiChatRequest,
  type AiChatResponse,
  type CaseImportResponse,
  type ContractAuditRunRequest,
  type ContractAuditRunResponse,
  type CreateFindingRequest,
  type CreateFindingResponse,
  type DeleteContractResponse,
  type FuzzCampaignRequest,
  type FuzzCampaignResponse,
  type GetMessageResponse,
  type HealthResponse,
  type ListContractsResponse,
  type ListDecodedContractsResponse,
  type ListFindingsResponse,
  type ListInterceptQueueResponse,
  type ListMessagesResponse,
  type ListScannerFindingsResponse,
  type ListWsFramesResponse,
  type ProxyIgnoreHostsRequest,
  type ProxyIgnoreHostsResponse,
  type ProxyStatus,
  type ProxySmokeTestResponse,
  type ReplayBatchResponse,
  type ReplayOverrides,
  type ReplayResponse,
  type ScannerRunRequest,
  type ScannerRunResponse,
  type SitemapResponse,
  type UpdateFindingRequest,
  type UpdateFindingResponse,
  type UpsertContractRequest,
  type UpsertContractResponse,
} from '@cipherscope/proto';

export type AgentClientOptions = {
  httpBaseUrl: string;
  wsBaseUrl?: string;
  fetch?: typeof fetch;
};

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function toUtf8String(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  // Undici WebSocket may deliver Blob in some environments.
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    // Caller must handle async for Blob; we avoid that path for now.
    throw new Error('Unsupported WebSocket message type: Blob');
  }
  throw new Error(`Unsupported WebSocket message type: ${Object.prototype.toString.call(data)}`);
}

export class AgentClient {
  #httpBaseUrl: string;
  #wsBaseUrl: string;
  #fetch: typeof fetch;

  constructor(opts: AgentClientOptions) {
    this.#httpBaseUrl = stripTrailingSlash(opts.httpBaseUrl);
    this.#wsBaseUrl = stripTrailingSlash(
      opts.wsBaseUrl ?? this.#httpBaseUrl.replace(/^http/, 'ws'),
    );
    this.#fetch = opts.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') {
      throw new Error('AgentClient requires a global fetch or an injected fetch implementation.');
    }
  }

  async health(): Promise<HealthResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/health`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent health check failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return HealthResponseSchema.parse(json);
  }

  async metrics(): Promise<AgentMetrics> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/metrics`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent metrics request failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return AgentMetricsSchema.parse(json);
  }

  async proxyStatus(): Promise<ProxyStatus> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/proxy/status`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent proxy status failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ProxyStatusSchema.parse(json);
  }

  async setIntercept(enabled: boolean): Promise<ProxyStatus> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/proxy/intercept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      throw new Error(`Agent intercept toggle failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ProxyStatusSchema.parse(json);
  }

  async proxySmokeTest(): Promise<ProxySmokeTestResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/proxy/smoke`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Agent proxy smoke test failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ProxySmokeTestResponseSchema.parse(json);
  }

  async listInterceptQueue(): Promise<ListInterceptQueueResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/proxy/queue`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent intercept queue failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ListInterceptQueueResponseSchema.parse(json);
  }

  async forwardIntercept(id: string): Promise<{ ok: true }> {
    const res = await this.#fetch(
      `${this.#httpBaseUrl}/proxy/queue/${encodeURIComponent(id)}/forward`,
      {
        method: 'POST',
      },
    );
    if (!res.ok) {
      throw new Error(`Agent forward intercept failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    if (!json?.ok) throw new Error('Forward failed');
    return { ok: true };
  }

  async dropIntercept(id: string): Promise<{ ok: true }> {
    const res = await this.#fetch(
      `${this.#httpBaseUrl}/proxy/queue/${encodeURIComponent(id)}/drop`,
      {
        method: 'POST',
      },
    );
    if (!res.ok) {
      throw new Error(`Agent drop intercept failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    if (!json?.ok) throw new Error('Drop failed');
    return { ok: true };
  }

  async proxyIgnoreHosts(): Promise<ProxyIgnoreHostsResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/proxy/ignore-hosts`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent proxy ignore hosts failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ProxyIgnoreHostsResponseSchema.parse(json);
  }

  async setProxyIgnoreHosts(hosts: string[]): Promise<ProxyIgnoreHostsResponse> {
    const payload: ProxyIgnoreHostsRequest = ProxyIgnoreHostsRequestSchema.parse({ hosts });
    const res = await this.#fetch(`${this.#httpBaseUrl}/proxy/ignore-hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Agent set proxy ignore hosts failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ProxyIgnoreHostsResponseSchema.parse(json);
  }

  async listMessages(params?: {
    limit?: number;
    offset?: number;
    search?: string;
    source?: string;
    method?: string;
    scheme?: string;
    status?: string;
  }): Promise<ListMessagesResponse> {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));
    if (params?.search != null && params.search !== '') qs.set('search', params.search);
    if (params?.source != null && params.source !== '') qs.set('source', params.source);
    if (params?.method != null && params.method !== '') qs.set('method', params.method);
    if (params?.scheme != null && params.scheme !== '') qs.set('scheme', params.scheme);
    if (params?.status != null && params.status !== '') qs.set('status', params.status);

    const url = `${this.#httpBaseUrl}/messages${qs.size ? `?${qs}` : ''}`;
    const res = await this.#fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent list messages failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ListMessagesResponseSchema.parse(json);
  }

  async getSitemap(params?: { hide404?: boolean }): Promise<SitemapResponse> {
    const qs = new URLSearchParams();
    if (params?.hide404) qs.set('hide404', '1');
    const url = `${this.#httpBaseUrl}/sitemap${qs.size ? `?${qs}` : ''}`;
    const res = await this.#fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent get sitemap failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return SitemapResponseSchema.parse(json);
  }

  async getMessage(id: string): Promise<GetMessageResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/messages/${encodeURIComponent(id)}`, {
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`Agent get message failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return GetMessageResponseSchema.parse(json);
  }

  async listWsFrames(
    connectionId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<ListWsFramesResponse> {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));

    const url = `${this.#httpBaseUrl}/ws/${encodeURIComponent(connectionId)}/frames${
      qs.size ? `?${qs}` : ''
    }`;
    const res = await this.#fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent list ws frames failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ListWsFramesResponseSchema.parse(json);
  }

  async replay(messageId: string, overrides?: ReplayOverrides): Promise<ReplayResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId, overrides }),
    });
    if (!res.ok) {
      throw new Error(`Agent replay failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ReplayResponseSchema.parse(json);
  }

  async replayBatch(items: Array<{ messageId: string; overrides?: ReplayOverrides }>): Promise<ReplayBatchResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/replay/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      throw new Error(`Agent replay batch failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ReplayBatchResponseSchema.parse(json);
  }

  async fuzzCampaign(input: FuzzCampaignRequest): Promise<FuzzCampaignResponse> {
    const payload = FuzzCampaignRequestSchema.parse(input);
    const res = await this.#fetch(`${this.#httpBaseUrl}/fuzzer/campaign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Agent fuzz campaign failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return FuzzCampaignResponseSchema.parse(json);
  }

  async runScanner(input?: ScannerRunRequest): Promise<ScannerRunResponse> {
    const payload = ScannerRunRequestSchema.parse(input);
    const res = await this.#fetch(`${this.#httpBaseUrl}/scanner/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Agent scanner run failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ScannerRunResponseSchema.parse(json);
  }

  async runContractAudit(input: ContractAuditRunRequest): Promise<ContractAuditRunResponse> {
    const payload = ContractAuditRunRequestSchema.parse(input);
    const res = await this.#fetch(`${this.#httpBaseUrl}/audit/contracts/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Agent contract audit run failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ContractAuditRunResponseSchema.parse(json);
  }

  async listScannerFindings(params?: {
    limit?: number;
    offset?: number;
  }): Promise<ListScannerFindingsResponse> {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));

    const url = `${this.#httpBaseUrl}/scanner/findings${qs.size ? `?${qs}` : ''}`;
    const res = await this.#fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent list scanner findings failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ListScannerFindingsResponseSchema.parse(json);
  }

  async listFindings(params?: {
    limit?: number;
    offset?: number;
  }): Promise<ListFindingsResponse> {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));

    const url = `${this.#httpBaseUrl}/findings${qs.size ? `?${qs}` : ''}`;
    const res = await this.#fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent list findings failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ListFindingsResponseSchema.parse(json);
  }

  async createFinding(input: CreateFindingRequest): Promise<CreateFindingResponse> {
    const payload = CreateFindingRequestSchema.parse(input);
    const res = await this.#fetch(`${this.#httpBaseUrl}/findings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Agent create finding failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return CreateFindingResponseSchema.parse(json);
  }

  async updateFinding(id: string, input: UpdateFindingRequest): Promise<UpdateFindingResponse> {
    const payload = UpdateFindingRequestSchema.parse(input);
    const res = await this.#fetch(`${this.#httpBaseUrl}/findings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Agent update finding failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return UpdateFindingResponseSchema.parse(json);
  }

  async exportCaseFile(): Promise<ArrayBuffer> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/case/export`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent case export failed: ${res.status} ${res.statusText}`);
    }
    return await res.arrayBuffer();
  }

  async importCaseFile(zip: ArrayBuffer | Uint8Array): Promise<CaseImportResponse> {
    const u8 = zip instanceof Uint8Array ? zip : new Uint8Array(zip);
    // DOM's BufferSource type only accepts views over ArrayBuffer (not SharedArrayBuffer).
    // Normalize to a standalone ArrayBuffer for compatibility across runtimes.
    const body = (() => {
      if (u8.buffer instanceof ArrayBuffer) {
        return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
          ? u8.buffer
          : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      }
      const copy = new Uint8Array(u8.byteLength);
      copy.set(u8);
      return copy.buffer;
    })();
    const res = await this.#fetch(`${this.#httpBaseUrl}/case/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Agent case import failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return CaseImportResponseSchema.parse(json);
  }

  async listContracts(): Promise<ListContractsResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/contracts`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent list contracts failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ListContractsResponseSchema.parse(json);
  }

  async getContract(id: string): Promise<UpsertContractResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/contracts/${encodeURIComponent(id)}`, {
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`Agent get contract failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return UpsertContractResponseSchema.parse(json);
  }

  async upsertContract(body: UpsertContractRequest): Promise<UpsertContractResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/contracts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Agent upsert contract failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return UpsertContractResponseSchema.parse(json);
  }

  async deleteContract(id: string): Promise<DeleteContractResponse> {
    const res = await this.#fetch(`${this.#httpBaseUrl}/contracts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw new Error(`Agent delete contract failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return DeleteContractResponseSchema.parse(json);
  }

  async chatWithAgent(input: AiChatRequest): Promise<AiChatResponse> {
    const payload = AiChatRequestSchema.parse(input);
    const res = await this.#fetch(`${this.#httpBaseUrl}/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`Agent AI chat failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return AiChatResponseSchema.parse(json);
  }

  async listDecodedContracts(params?: {
    limit?: number;
    offset?: number;
  }): Promise<ListDecodedContractsResponse> {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));

    const url = `${this.#httpBaseUrl}/contracts/decoded${qs.size ? `?${qs}` : ''}`;
    const res = await this.#fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Agent decoded contracts failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    return ListDecodedContractsResponseSchema.parse(json);
  }

  connectEvents(handlers: {
    onEvent: (evt: AgentEvent) => void;
    onError?: (err: unknown) => void;
  }): WebSocket {
    const ws = new WebSocket(`${this.#wsBaseUrl}/events`);

    ws.addEventListener('message', (msg) => {
      try {
        const text = toUtf8String((msg as MessageEvent).data);
        const parsed = AgentEventSchema.parse(JSON.parse(text));
        handlers.onEvent(parsed);
      } catch (err) {
        handlers.onError?.(err);
      }
    });

    ws.addEventListener('error', (evt) => {
      handlers.onError?.(evt);
    });

    return ws;
  }
}
