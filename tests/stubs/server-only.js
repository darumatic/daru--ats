// Next.js resolves the real `server-only` package through its bundler; under
// Vitest it is unresolvable, so route modules that import it (via lib/demo-config)
// cannot be loaded without this stub. It is intentionally empty - the real
// package only exists to make a build fail when server code reaches the client.
export {};
