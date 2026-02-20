export type DbWriteMetrics = {
  writesTotal: number;
  lastWriteMs: number | null;
  avgWriteMs: number | null;
};

export type AgentMetrics = {
  httpRequestsTotal: number;
  wsMessagesTotal: number;
  uptimeSeconds: number;
  httpRequestsPerSecond: number;
  wsMessagesPerSecond: number;
  db: DbWriteMetrics;
};

export function createMetrics(): {
  incHttpRequest: () => void;
  incWsMessage: () => void;
  recordDbWrite: (ms: number) => void;
  snapshot: () => AgentMetrics;
} {
  const startedAtMs = Date.now();
  let httpRequestsTotal = 0;
  let wsMessagesTotal = 0;
  let writesTotal = 0;
  let lastWriteMs: number | null = null;
  let avgWriteMs: number | null = null;

  return {
    incHttpRequest() {
      httpRequestsTotal += 1;
    },
    incWsMessage() {
      wsMessagesTotal += 1;
    },
    recordDbWrite(ms: number) {
      writesTotal += 1;
      lastWriteMs = ms;
      avgWriteMs = avgWriteMs == null ? ms : avgWriteMs * 0.9 + ms * 0.1;
    },
    snapshot() {
      const uptimeSeconds = Math.max(0, (Date.now() - startedAtMs) / 1000);
      const denom = uptimeSeconds > 0 ? uptimeSeconds : 1;
      return {
        httpRequestsTotal,
        wsMessagesTotal,
        uptimeSeconds,
        httpRequestsPerSecond: httpRequestsTotal / denom,
        wsMessagesPerSecond: wsMessagesTotal / denom,
        db: { writesTotal, lastWriteMs, avgWriteMs },
      };
    },
  };
}

export type MetricsHandle = ReturnType<typeof createMetrics>;
