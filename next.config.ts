import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `onnxruntime-node` is a native N-API addon: it resolves a platform-specific
   * `.dylib`/`.so` and `.node` binary at require time, which a bundler cannot
   * trace. Bundling it breaks the FACE module's local face-recognition models at
   * runtime, so it has to stay external and be required from node_modules.
   * (`sharp` is already on Next's built-in external list.)
   */
  serverExternalPackages: ['onnxruntime-node'],
};

export default nextConfig;
