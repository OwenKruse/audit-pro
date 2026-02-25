const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(): Promise<Response> {
  return Response.json(
    { walletRpcUrl: `${agentHttpUrl}/evm/jsonrpc` },
    { headers: { 'cache-control': 'no-store' } },
  );
}
