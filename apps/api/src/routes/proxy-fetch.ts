// Proxy Fetch API route - Proxies arbitrary HTTP requests to avoid CORS in web mode

import { Hono } from 'hono';
import { getOptionalAuth, optionalAuthMiddleware } from '../middlewares/auth';
import type { HonoContext } from '../types/context';

const proxyFetch = new Hono<HonoContext>();

interface ProxyFetchRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * POST /api/proxy-fetch
 * Proxy an HTTP request to an external URL (used by web mode to bypass CORS)
 */
proxyFetch.post('/', optionalAuthMiddleware, async (c) => {
  const deviceId = c.req.header('X-Device-ID');
  if (!deviceId) {
    return c.json({ error: 'Missing X-Device-ID header' }, 400);
  }

  const auth = getOptionalAuth(c);

  let requestBody: ProxyFetchRequest;
  try {
    requestBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!requestBody.url || typeof requestBody.url !== 'string') {
    return c.json({ error: 'Missing or invalid url parameter' }, 400);
  }

  // Validate URL
  try {
    const parsedUrl = new URL(requestBody.url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return c.json({ error: 'URL must use http or https protocol' }, 400);
    }
  } catch {
    return c.json({ error: 'Invalid URL format' }, 400);
  }

  const method = requestBody.method?.toUpperCase() || 'GET';

  try {
    const fetchHeaders: Record<string, string> = { ...(requestBody.headers || {}) };

    // Forward device ID and auth for rate limiting/logging
    fetchHeaders['x-talkcody-device-id'] = deviceId;
    if (auth?.userId) {
      fetchHeaders['x-talkcody-user-id'] = auth.userId;
    }

    const response = await fetch(requestBody.url, {
      method,
      headers: fetchHeaders,
      body: method !== 'GET' && method !== 'HEAD' ? requestBody.body : undefined,
    });

    const responseBody = await response.text();

    // Collect response headers (exclude hop-by-hop headers)
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower !== 'transfer-encoding' &&
        lower !== 'connection' &&
        lower !== 'keep-alive' &&
        lower !== 'content-encoding' &&
        lower !== 'content-length'
      ) {
        responseHeaders[key] = value;
      }
    });

    return c.json(
      {
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      },
      200
    );
  } catch (error) {
    console.error('[Proxy Fetch] Error:', error);
    return c.json(
      {
        status: 0,
        headers: {},
        body: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      200
    );
  }
});

export default proxyFetch;
