'use strict';

/**
 * Rewrite request headers for hot-swap forwarding.
 *
 * When an old proxy enters forwarding mode, it must rewrite the x-api-key
 * header to match the new proxy's expected key format (deepclaude-<PORT>).
 * Otherwise the new proxy's single-tenant enforcement binds to the old key
 * and rejects the restarted CC session.
 *
 * Also strips authorization (Bearer) to prevent the old session's auth
 * from contaminating the new proxy's binding.
 */
export function buildHotSwapHeaders(
  originalHeaders: Record<string, string | string[] | undefined>,
  targetPort: number,
): Record<string, string | string[] | undefined> {
  const newKey = 'deepclaude-' + targetPort;
  const fwd: Record<string, string | string[] | undefined> = {
    ...originalHeaders,
    host: '127.0.0.1:' + targetPort,
    'x-api-key': newKey,
  };
  if (fwd['authorization']) {
    delete fwd['authorization'];
  }
  return fwd;
}
