import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Screenshots taken by the verifier should show the page, not the dev overlay badge.
  devIndicators: false,
};

export default nextConfig;
