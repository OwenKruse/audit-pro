import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@cipherscope/sdk', '@cipherscope/proto'],
};

export default nextConfig;
