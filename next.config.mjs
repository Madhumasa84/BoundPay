import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Fabric Gateway is a Node-only runtime dependency. Bundling it pulls in
  // pkcs11js native bindings that are optional for the X.509 signer used here.
  serverExternalPackages: ['@hyperledger/fabric-gateway', '@grpc/grpc-js'],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(__dirname, 'src'),
    };
    return config;
  },
};

export default nextConfig;
