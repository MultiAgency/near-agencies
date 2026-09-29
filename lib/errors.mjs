// Error responses that do not repeat what went wrong. Failures from GitHub and
// NEAR carry the upstream's response text, so they are logged and the client
// gets a fixed message instead.

/** Express error middleware, mounted after every route. */
export function errorHandler(error, request, response, next) {
  if (response.headersSent) return next(error);
  const status = error.status ?? error.statusCode;
  // Client errors Express raises itself (malformed JSON, body too large) are
  // safe to explain.
  if (Number.isInteger(status) && status >= 400 && status < 500 && error.expose) {
    return response.status(status).json({ error: error.message });
  }
  console.error(`${request.method} ${request.path}: ${error.stack ?? error.message}`);
  response.status(500).json({ error: "internal error" });
}

/**
 * Answer a failed read: 404 with `notFound` for an unknown engagement or a
 * GitHub 404 (the status github.mjs writes after the path), 502 for anything else.
 */
export function readFailure(response, error, notFound) {
  if (/not an engagement|: 404 /.test(error.message)) return response.status(404).json({ error: notFound || "not found" });
  console.error(`read failed: ${error.message}`);
  response.status(502).json({ error: "upstream request failed" });
}
