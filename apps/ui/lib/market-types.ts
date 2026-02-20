export type MarketNetwork = {
  id: string;
  name: string | null;
  coingeckoAssetPlatformId: string | null;
};

export type MarketToken = {
  id: string;
  address: string | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  imageUrl: string | null;
  coingeckoCoinId: string | null;
};

export type MarketDex = {
  id: string;
  name: string | null;
};

export type MarketPool = {
  id: string;
  networkId: string | null;
  address: string;
  name: string | null;
  poolName: string | null;
  poolFeePercentage: string | null;
  poolCreatedAt: string | null;
  fdvUsd: string | null;
  marketCapUsd: string | null;
  baseTokenPriceUsd: string | null;
  quoteTokenPriceUsd: string | null;
  reserveUsd: string | null;
  lockedLiquidityPercentage: string | null;
  priceChangePercentage: Record<string, string> | null;
  transactions: Record<string, unknown> | null;
  volumeUsd: Record<string, string> | null;
  baseToken: MarketToken | null;
  quoteToken: MarketToken | null;
  dex: MarketDex | null;
};

export type MarketTrade = {
  id: string;
  blockNumber: number | null;
  blockTimestamp: string | null;
  txHash: string | null;
  txFromAddress: string | null;
  kind: string | null;
  volumeUsd: string | null;
  fromTokenAddress: string | null;
  toTokenAddress: string | null;
  fromTokenAmount: string | null;
  toTokenAmount: string | null;
  priceFromUsd: string | null;
  priceToUsd: string | null;
};

