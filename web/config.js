window.GRAPH_CONFIG = Object.assign(
  {
    // Empty string means "use the same origin as the page". The Cloudflare
    // Worker (see src/worker.js) implements `/api/v1/public/*` directly, so
    // the SPA hosted at https://graph.skdev-371.workers.dev/ persists graph
    // nodes by talking to its own origin. Override this in a fork to point
    // at a different hosted API (e.g. the Fly.io Nest deployment).
    apiBaseUrl: '',
    brainUserId: 'local',
  },
  window.GRAPH_CONFIG || {},
);
