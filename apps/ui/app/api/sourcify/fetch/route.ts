const SOURCIFY_SERVER_URL =
  process.env.SOURCIFY_SERVER_URL ?? 'https://sourcify.dev/server';

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function isHexAddress(value: string): boolean {
  return HEX_ADDRESS_RE.test(value);
}

function parseChainId(value: string): number | null {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const chainIdParam = url.searchParams.get('chainId') ?? '';
  const addressParam = (url.searchParams.get('address') ?? '').trim();

  const chainId = parseChainId(chainIdParam);
  if (chainId === null) {
    return Response.json(
      {
        ok: false,
        error: { code: 'bad_request', message: 'Invalid or missing chainId.' },
      },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!addressParam || !isHexAddress(addressParam)) {
    return Response.json(
      {
        ok: false,
        error: { code: 'bad_request', message: 'Invalid or missing address (must be 0x + 40 hex chars).' },
      },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const sourcifyUrl = `${SOURCIFY_SERVER_URL.replace(/\/$/, '')}/v2/contract/${chainId}/${addressParam}?fields=all`;

  let upstream: Response;
  try {
    upstream = await fetch(sourcifyUrl, { cache: 'no-store' });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'sourcify_unreachable',
          message: 'Failed to fetch from Sourcify.',
        },
      },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (upstream.status === 404) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'not_found',
          message: 'Contract not verified on Sourcify.',
        },
      },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!upstream.ok) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'sourcify_error',
          message: 'Failed to fetch from Sourcify.',
        },
      },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  let json: unknown;
  try {
    json = await upstream.json();
  } catch {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'sourcify_error',
          message: 'Invalid response from Sourcify.',
        },
      },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  const obj = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  const abi = obj?.abi;

  if (!Array.isArray(abi) || abi.length === 0) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'invalid_abi',
          message: 'Sourcify returned no valid ABI.',
        },
      },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  return Response.json(
    { ok: true, abi },
    { headers: { 'cache-control': 'no-store' } },
  );
}
