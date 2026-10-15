import type { NextConfig } from "next";

const config: NextConfig = {
  // a second dev server (end-to-end tests) needs its own build directory
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // workspace packages ship TypeScript sources
  transpilePackages: ["@iara/protocol", "@iara/ui"],
  // loaded by Node at run time (optional native addons, large SDKs)
  serverExternalPackages: ["ssh2"],
  // the nav rail's bottom corner hosts the theme switch
  devIndicators: { position: "bottom-right" },
  experimental: {
    optimizePackageImports: ["@mui/material", "@mui/icons-material"],
  },
};

export default config;
