/// <reference types="vite/client" />

/** Build-time configuration. See .env.example for what each one is for. */
interface ImportMetaEnv {
  /** Base URL of the Group Network HTTP API (SAM output `HttpApiUrl`). */
  readonly VITE_API_BASE?: string;
  /** Realtime endpoint (SAM output `WebSocketUrl`). Realtime is off when unset. */
  readonly VITE_WS_URL?: string;
  /** Google Identity Services client id. Google sign-in is hidden when unset. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Cloudflare Turnstile site key. Unattributed posting is off when unset. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
