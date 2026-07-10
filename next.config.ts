import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle so the Docker image can run the app
  // without node_modules (see Dockerfile).
  output: 'standalone',
  eslint: {
      ignoreDuringBuilds: true,
  }, typescript: {
      ignoreBuildErrors: true
    }
};

export default nextConfig;
