import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

type AbiItem = Record<string, unknown>;

type SourcifyLookup = {
  provider: 'sourcify';
  abi: AbiItem[] | null;
  proxyResolution: unknown | null;
  raw: unknown | null;
  error?: string;
  fallback?: 'etherscan' | 'blockscout';
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function toBool(value: string | null): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

async function fetchJson<T>(url: string, revalidateSeconds = 300): Promise<T> {
  const res = await fetch(url, {
    next: { revalidate: revalidateSeconds },
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fetch failed ${res.status} ${res.statusText}: ${text}`);
  }

  return (await res.json()) as T;
}

function firstImplementationAddress(proxyResolution: unknown): string | null {
  const proxy = asObject(proxyResolution);
  if (!proxy) return null;
  if (proxy.isProxy !== true) return null;
  const implementations = proxy.implementations;
  if (!Array.isArray(implementations) || implementations.length === 0) return null;
  const first = asObject(implementations[0]);
  if (!first) return null;
  const address = typeof first.address === 'string' ? first.address : '';
  return isHexAddress(address) ? address : null;
}

async function trySourcify(chainId: string, address: string): Promise<SourcifyLookup> {
  const base = process.env.SOURCIFY_BASE_URL || process.env.SOURCIFY_SERVER_URL || 'https://sourcify.dev/server';
  const normalizedAddress = address.toLowerCase();
  const url = `${base.replace(/\/+$/, '')}/v2/contract/${encodeURIComponent(chainId)}/${encodeURIComponent(normalizedAddress)}?fields=all`;
  try {
    const data = await fetchJson<unknown>(url, 300);
    const obj = asObject(data);
    const abiRaw = obj?.abi;
    const abi: AbiItem[] | null =
      Array.isArray(abiRaw) ? (abiRaw.filter((item) => asObject(item) !== null) as AbiItem[]) : null;
    const proxyResolution = obj?.proxyResolution ?? null;

    return { provider: 'sourcify', abi, proxyResolution, raw: data };
  } catch (err) {
    return {
      provider: 'sourcify',
      abi: null,
      proxyResolution: null,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function tryEtherscan(chainId: string, address: string): Promise<{
  provider: 'etherscan';
  abi: AbiItem[] | null;
  error?: { status: string; message: string; result: unknown };
} | null> {
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();
  if (!apiKey) return null;

  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', chainId);
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getabi');
  url.searchParams.set('address', address.toLowerCase());
  url.searchParams.set('apikey', apiKey);

  const payload = await fetchJson<unknown>(url.toString(), 300);
  const obj = asObject(payload);
  const status = typeof obj?.status === 'string' ? obj.status : '';
  const message = typeof obj?.message === 'string' ? obj.message : '';
  const result = obj?.result;

  if (status !== '1' || typeof result !== 'string') {
    return { provider: 'etherscan', abi: null, error: { status, message, result } };
  }

  let abi: AbiItem[] | null = null;
  try {
    const parsed = JSON.parse(result) as unknown;
    abi = Array.isArray(parsed) ? (parsed.filter((item) => asObject(item) !== null) as AbiItem[]) : null;
  } catch {
    abi = null;
  }

  return { provider: 'etherscan', abi };
}

async function tryBlockscout(
  blockscoutBaseUrl: string,
  address: string,
): Promise<{
  provider: 'blockscout';
  abi: AbiItem[] | null;
  error?: unknown;
}> {
  const url = new URL(`${blockscoutBaseUrl.replace(/\/+$/, '')}/api`);
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getabi');
  url.searchParams.set('address', address.toLowerCase());

  const payload = await fetchJson<unknown>(url.toString(), 300);
  const obj = asObject(payload);
  const status = typeof obj?.status === 'string' ? obj.status : '';
  const result = obj?.result;

  if (status !== '1') return { provider: 'blockscout', abi: null, error: payload };

  let abi: AbiItem[] | null = null;
  try {
    const parsed = typeof result === 'string' ? (JSON.parse(result) as unknown) : result;
    abi = Array.isArray(parsed) ? (parsed.filter((item) => asObject(item) !== null) as AbiItem[]) : null;
  } catch {
    abi = null;
  }

  return { provider: 'blockscout', abi };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url);

    const chainId = (searchParams.get('chainId') || '').trim();
    const address = (searchParams.get('address') || '').trim();
    const resolveProxy = toBool(searchParams.get('resolveProxy'));
    const blockscout = (searchParams.get('blockscout') || '').trim();

    if (!chainId || !/^\d+$/.test(chainId)) {
      return NextResponse.json(
        { ok: false, error: { message: 'Missing or invalid chainId' } },
        { status: 400 },
      );
    }

    if (!isHexAddress(address)) {
      return NextResponse.json(
        { ok: false, error: { message: 'Missing or invalid address' } },
        { status: 400 },
      );
    }

    let primary = await trySourcify(chainId, address);
    const providerErrors: Record<string, string> = {};
    if (primary.error) providerErrors.sourcify = primary.error;

    let implementation: Awaited<ReturnType<typeof trySourcify>> | null = null;
    const implementationAddress = firstImplementationAddress(primary.proxyResolution);
    if (resolveProxy && implementationAddress) {
      implementation = await trySourcify(chainId, implementationAddress);
      if (implementation.error) {
        providerErrors.sourcifyImplementation = implementation.error;
      }
    }

    if (!primary.abi) {
      try {
        const eth = await tryEtherscan(chainId, address);
        if (eth?.abi) {
          primary = { ...primary, abi: eth.abi, fallback: eth.provider };
        } else if (eth?.error) {
          providerErrors.etherscan = JSON.stringify(eth.error);
        }
      } catch (err) {
        providerErrors.etherscan = err instanceof Error ? err.message : String(err);
      }
    }

    if (!primary.abi && blockscout) {
      try {
        const bs = await tryBlockscout(blockscout, address);
        if (bs?.abi) {
          primary = { ...primary, abi: bs.abi, fallback: bs.provider };
        } else if (bs?.error != null) {
          providerErrors.blockscout = JSON.stringify(bs.error);
        }
      } catch (err) {
        providerErrors.blockscout = err instanceof Error ? err.message : String(err);
      }
    }

    return NextResponse.json(
      {
        ok: true,
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
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: { message: err instanceof Error ? err.message : 'Unknown error' },
      },
      { status: 500 },
    );
  }
}
