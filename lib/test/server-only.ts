// Vitest runs in Node outside the Next.js module resolver. Next.js replaces
// the `server-only` package during application builds, so tests alias it to
// this inert module while preserving the production import boundary.
export {};
