/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the void plugin during `vp dev`. Gates dev-only ingest paths. */
  readonly VITE_IS_DEV_SERVER?: string;
  /** Optional build-time origin for the vendored trace viewer. */
  readonly VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";
