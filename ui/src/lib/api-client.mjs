export const STATUS_TIMEOUT_MS = 8_000;

// A public/static page must not discover or contact an API implicitly.
export function apiMode(location, document) {
  if (!/^https?:$/.test(location.protocol)) return 'offline';
  if (document.querySelector('meta[name="praktika-api"]')?.getAttribute('content') === 'same-origin') return 'hosted';
  return ['127.0.0.1', 'localhost'].includes(location.hostname) ? 'local' : 'offline';
}

export async function readApiStatus({signal, fetchImpl = globalThis.fetch, timeoutMs = STATUS_TIMEOUT_MS} = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, {once: true});
  const timer = setTimeout(() => controller.abort(new DOMException('Status check timed out', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetchImpl('/api/status', {
      signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) throw new Error('Service unavailable');
    const status = await response.json();
    if (!status || Array.isArray(status) || typeof status.ai !== 'boolean' ||
        (status.ai && (typeof status.provider !== 'string' || !status.provider.trim() || status.provider.length > 200))) {
      throw new Error('Invalid service status');
    }
    return {
      ai: status.ai, provider: status.ai ? status.provider.trim() : '',
      ...(Number.isSafeInteger(status.remaining) && status.remaining >= 0 ? {remaining: status.remaining} : {}),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
