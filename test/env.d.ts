// Bindings the test runtime provides through vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
  }
}
