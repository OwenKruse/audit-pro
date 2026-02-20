import type { MarketDex, MarketNetwork, MarketPool, MarketToken, MarketTrade } from '@/lib/market-types';

export const GECKO_BASE_URL = 'https://api.geckoterminal.com/api/v2';

type GeckoResource = {
  id?: unknown;
  type?: unknown;
  attributes?: unknown;
  relationships?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseNetworkFromId(id: string): string | null {
  const idx = id.indexOf('_');
  if (idx <= 0) return null;
  return id.slice(0, idx) || null;
}

function includedKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function buildIncludedMap(included: unknown): Map<string, GeckoResource> {
  const map = new Map<string, GeckoResource>();
  if (!Array.isArray(included)) return map;
  for (const raw of included) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const type = asString(rec.type);
    const id = asString(rec.id);
    if (!type || !id) continue;
    map.set(includedKey(type, id), rec as GeckoResource);
  }
  return map;
}

function readRelationshipId(resource: GeckoResource, relName: string): { type: string; id: string } | null {
  const rels = asRecord(resource.relationships);
  if (!rels) return null;
  const rel = asRecord(rels[relName]);
  if (!rel) return null;
  const data = asRecord(rel.data);
  if (!data) return null;
  const type = asString(data.type);
  const id = asString(data.id);
  if (!type || !id) return null;
  return { type, id };
}

function normalizeToken(resource: GeckoResource | null | undefined): MarketToken | null {
  const id = asString(resource?.id);
  if (!id) return null;
  const attrs = asRecord(resource?.attributes) ?? {};
  return {
    id,
    address: asString(attrs.address),
    name: asString(attrs.name),
    symbol: asString(attrs.symbol),
    decimals: asNumber(attrs.decimals),
    imageUrl: asString(attrs.image_url),
    coingeckoCoinId: asString(attrs.coingecko_coin_id),
  };
}

function normalizeDex(resource: GeckoResource | null | undefined): MarketDex | null {
  const id = asString(resource?.id);
  if (!id) return null;
  const attrs = asRecord(resource?.attributes) ?? {};
  return {
    id,
    name: asString(attrs.name),
  };
}

export function normalizeNetwork(resource: unknown): MarketNetwork | null {
  const rec = asRecord(resource) as GeckoResource | null;
  if (!rec) return null;
  const id = asString(rec.id);
  if (!id) return null;
  const attrs = asRecord(rec.attributes) ?? {};
  return {
    id,
    name: asString(attrs.name),
    coingeckoAssetPlatformId: asString(attrs.coingecko_asset_platform_id),
  };
}

export function normalizePools(payload: unknown): MarketPool[] {
  const root = asRecord(payload);
  if (!root) return [];
  const data = root.data;
  const included = root.included;
  const includedMap = buildIncludedMap(included);

  if (!Array.isArray(data)) return [];
  const out: MarketPool[] = [];
  for (const raw of data) {
    const pool = normalizePoolResource(raw, includedMap);
    if (pool) out.push(pool);
  }
  return out;
}

export function normalizePool(payload: unknown): MarketPool | null {
  const root = asRecord(payload);
  if (!root) return null;
  const includedMap = buildIncludedMap(root.included);
  return normalizePoolResource(root.data, includedMap);
}

function normalizePoolResource(raw: unknown, includedMap: Map<string, GeckoResource>): MarketPool | null {
  const resource = asRecord(raw) as GeckoResource | null;
  if (!resource) return null;
  const id = asString(resource.id);
  if (!id) return null;

  const attrs = asRecord(resource.attributes) ?? {};

  const address = asString(attrs.address);
  if (!address) return null;

  const baseRef = readRelationshipId(resource, 'base_token');
  const quoteRef = readRelationshipId(resource, 'quote_token');
  const dexRef = readRelationshipId(resource, 'dex');

  const baseToken = baseRef
    ? normalizeToken(includedMap.get(includedKey(baseRef.type, baseRef.id)))
    : null;
  const quoteToken = quoteRef
    ? normalizeToken(includedMap.get(includedKey(quoteRef.type, quoteRef.id)))
    : null;
  const dex = dexRef ? normalizeDex(includedMap.get(includedKey(dexRef.type, dexRef.id))) : null;

  const volumeUsdRec = asRecord(attrs.volume_usd);
  const volumeUsd: Record<string, string> | null =
    volumeUsdRec
      ? Object.fromEntries(
          Object.entries(volumeUsdRec)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
      : null;

  const priceChangeRec = asRecord(attrs.price_change_percentage);
  const priceChangePercentage: Record<string, string> | null =
    priceChangeRec
      ? Object.fromEntries(
          Object.entries(priceChangeRec)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
      : null;

  return {
    id,
    networkId: parseNetworkFromId(id),
    address,
    name: asString(attrs.name),
    poolName: asString(attrs.pool_name),
    poolFeePercentage: asString(attrs.pool_fee_percentage),
    poolCreatedAt: asString(attrs.pool_created_at),
    fdvUsd: asString(attrs.fdv_usd),
    marketCapUsd: asString(attrs.market_cap_usd),
    baseTokenPriceUsd: asString(attrs.base_token_price_usd),
    quoteTokenPriceUsd: asString(attrs.quote_token_price_usd),
    reserveUsd: asString(attrs.reserve_in_usd),
    lockedLiquidityPercentage: asString(attrs.locked_liquidity_percentage),
    priceChangePercentage,
    transactions: asRecord(attrs.transactions),
    volumeUsd,
    baseToken,
    quoteToken,
    dex,
  };
}

export function normalizeTrades(payload: unknown): MarketTrade[] {
  const root = asRecord(payload);
  if (!root) return [];
  const data = root.data;
  if (!Array.isArray(data)) return [];

  const out: MarketTrade[] = [];
  for (const raw of data) {
    const resource = asRecord(raw) as GeckoResource | null;
    if (!resource) continue;
    const id = asString(resource.id);
    if (!id) continue;
    const attrs = asRecord(resource.attributes) ?? {};
    out.push({
      id,
      blockNumber: asNumber(attrs.block_number),
      blockTimestamp: asString(attrs.block_timestamp),
      txHash: asString(attrs.tx_hash),
      txFromAddress: asString(attrs.tx_from_address),
      kind: asString(attrs.kind),
      volumeUsd: asString(attrs.volume_in_usd),
      fromTokenAddress: asString(attrs.from_token_address),
      toTokenAddress: asString(attrs.to_token_address),
      fromTokenAmount: asString(attrs.from_token_amount),
      toTokenAmount: asString(attrs.to_token_amount),
      priceFromUsd: asString(attrs.price_from_in_usd),
      priceToUsd: asString(attrs.price_to_in_usd),
    });
  }
  return out;
}
