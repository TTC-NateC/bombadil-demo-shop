import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for the single-container image: emits .next/standalone with a
  // minimal server.js and only the traced dependencies. See specs/01 §10.
  output: "standalone",

  // Pin the tracing root to this project. Without it Next walks up looking for
  // a lockfile, finds an unrelated one in the user's home directory, and emits
  // standalone output under a mangled nested path — which breaks the Docker
  // COPY in the runner stage.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
