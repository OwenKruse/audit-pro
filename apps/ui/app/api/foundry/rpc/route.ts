type RpcBody = {
  method?: unknown;
  params?: unknown;
};

type AgentRpcSuccess = {
  ok: true;
  result: unknown;
};

type AgentRpcError = {
  ok: false;
  error?: {
    code?: unknown;
    message?: unknown;
    rpcCode?: unknown;
    data?: unknown;
  };
};

type AgentStatusResponse = {
  ok?: unknown;
  foundry?: {
    startupError?: unknown;
  };
};

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

function normalizeParams(input: unknown): unknown[] {
  if (input == null) return [];
  if (Array.isArray(input)) return input;
  return [input];
}

function parseBody(raw: unknown): { method: string; params: unknown[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as RpcBody;
  if (typeof body.method !== 'string') return null;
  return {
    method: body.method.trim(),
    params: normalizeParams(body.params),
  };
}

async function readAgentStartupError(): Promise<string | null> {
  try {
    const res = await fetch(`${agentHttpUrl}/evm/status`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as AgentStatusResponse | null;
    if (!json || json.ok !== true || !json.foundry) return null;
    const startupError = json.foundry.startupError;
    if (typeof startupError === 'string' && startupError.trim()) return startupError;
    return null;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    // #region agent log
    fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'foundry/rpc/route.ts:parse-error',message:'bad json body',data:{},timestamp:Date.now(),hypothesisId:'H-C'})}).catch(()=>{});
    // #endregion
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Invalid JSON body.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const body = parseBody(rawBody);
  if (!body) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'method is required.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!body.method) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'method cannot be empty.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${agentHttpUrl}/evm/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: body.method, params: body.params }),
      cache: 'no-store',
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'upstream_unreachable',
          message: err instanceof Error ? err.message : 'Failed to reach Foundry RPC endpoint.',
        },
      },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  const json = (await upstream.json().catch(() => null)) as AgentRpcSuccess | AgentRpcError | null;
  if (!json || typeof json !== 'object' || !('ok' in json) || typeof json.ok !== 'boolean') {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'agent_invalid_response',
          message: `Agent returned invalid response (${upstream.status}).`,
        },
      },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (json.ok) {
    // #region agent log
    fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'foundry/rpc/route.ts:ok',message:'rpc ok',data:{method:body.method,params:body.params,result:String(json.result).slice(0,80)},timestamp:Date.now(),hypothesisId:'H-B,H-C'})}).catch(()=>{});
    // #endregion
    return Response.json(
      { ok: true, result: json.result },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const errorCode =
    typeof json.error?.code === 'string' && json.error.code.trim()
      ? json.error.code
      : 'agent_rpc_failed';
  const errorMessage =
    typeof json.error?.message === 'string' && json.error.message.trim()
      ? json.error.message
      : `Agent RPC failed (${upstream.status}).`;
  const startupHint = errorCode === 'evm_unavailable' ? await readAgentStartupError() : null;

  // #region agent log
  fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'foundry/rpc/route.ts:error',message:'rpc error',data:{method:body.method,errorCode,errorMessage,startupHint},timestamp:Date.now(),hypothesisId:'H-C,H-D'})}).catch(()=>{});
  // #endregion
  return Response.json(
    {
      ok: false,
      error: {
        code: errorCode,
        message: startupHint ? `${errorMessage} Foundry startup error: ${startupHint}` : errorMessage,
        data: json.error?.data,
      },
    },
    { status: errorCode === 'evm_unavailable' ? 503 : 502, headers: { 'cache-control': 'no-store' } },
  );
}
