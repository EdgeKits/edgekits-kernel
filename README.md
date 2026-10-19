# @edgekits/kernel

`@edgekits/kernel` is the core of the EdgeKits SaaS Kit for Cloudflare Workers: tenancy, policy and entitlements, billing events, provider ports, admin contracts, blueprint configuration, and the Astro and Hono middleware that wires them into an app. It has no runtime dependencies and no Cloudflare runtime dependencies beyond types.

The package is consumed through subpaths only: `@edgekits/kernel/tenancy`, `/policy`, `/events`, `/ports`, `/admin`, `/config`, `/astro` and `/hono`. The package root exports nothing. Inside the package, each subpath lives in `src/<name>/` with its public entry at `src/<name>/index.ts` and private code under `src/<name>/internal/`; a file may import its own subpath relatively, but reaches a sibling only as `@edgekits/kernel/<name>`. ESLint enforces this boundary.
