type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
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

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

function normalizeParams(input: unknown): unknown[] {
  if (input == null) return [];
  if (Array.isArray(input)) return input;
  return [input];
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: id ?? null,
      error: data === undefined ? { code, message } : { code, message, data },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: Request): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }

  const method = typeof body.method === 'string' ? body.method.trim() : '';
  if (!method) {
    return jsonRpcError(body.id ?? null, -32600, 'Invalid Request: method is required');
  }
  const params = normalizeParams(body.params);

  let upstream: Response;
  try {
    upstream = await fetch(`${agentHttpUrl}/evm/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      cache: 'no-store',
    });
  } catch (err) {
    return jsonRpcError(
      body.id ?? null,
      -32000,
      err instanceof Error ? err.message : 'Agent RPC unreachable',
    );
  }

  const json = (await upstream.json().catch(() => null)) as AgentRpcSuccess | AgentRpcError | null;
  if (!json || typeof json !== 'object' || !('ok' in json)) {
    return jsonRpcError(body.id ?? null, -32000, `Agent returned invalid response (${upstream.status}).`);
  }

  if (json.ok) {
    // #region agent log
    fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'foundry/wallet-rpc/route.ts:ok',message:'wallet-rpc hit',data:{method,params:params.slice(0,2),result:String(json.result).slice(0,80)},timestamp:Date.now(),hypothesisId:'H-A'})}).catch(()=>{});
    // #endregion
    return Response.json(
      {
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: json.result,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const rpcCode =
    typeof json.error?.rpcCode === 'number' ? json.error.rpcCode
    : typeof json.error?.code === 'number' ? json.error.code
    : -32000;
  const message =
    typeof json.error?.message === 'string' && json.error.message.trim()
      ? json.error.message
      : `Agent RPC failed (${upstream.status}).`;

  // #region agent log
  fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'foundry/wallet-rpc/route.ts:rpc-error',message:'wallet-rpc error',data:{method,rpcCode,message},timestamp:Date.now(),hypothesisId:'H-A'})}).catch(()=>{});
  // #endregion
  return jsonRpcError(body.id ?? null, rpcCode, message, json.error?.data);
}
