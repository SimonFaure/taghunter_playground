export interface ApiLogData {
  endpoint: string;
  method: string;
  requestParams?: Record<string, unknown>;
  requestBody?: Record<string, unknown>;
  requestHeaders?: Record<string, string>;
  responseData?: unknown;
  responseHeaders?: Record<string, string>;
  statusCode: number;
  errorMessage?: string;
}

function safeStringify(obj: unknown, maxDepth: number = 3): unknown {
  const seen = new WeakSet();

  function stringify(value: unknown, depth: number): unknown {
    if (depth > maxDepth) {
      return '[Max Depth Reached]';
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (seen.has(value as object)) {
      return '[Circular Reference]';
    }

    seen.add(value as object);

    if (Array.isArray(value)) {
      if (value.length > 100) {
        return `[Array with ${value.length} items]`;
      }
      return value.map(item => stringify(item, depth + 1));
    }

    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length > 100) {
      return `[Object with ${entries.length} keys]`;
    }

    for (const [key, val] of entries) {
      result[key] = stringify(val, depth + 1);
    }

    return result;
  }

  return stringify(obj, 0);
}

export async function logApiCall(data: ApiLogData): Promise<void> {
  try {
    if (window.electron?.apiLogs) {
      await window.electron.apiLogs.write({
        endpoint: data.endpoint,
        method: data.method,
        request_params: data.requestParams || {},
        request_body: data.requestBody || {},
        request_headers: data.requestHeaders || {},
        response_data: safeStringify(data.responseData),
        response_headers: data.responseHeaders || {},
        status_code: data.statusCode,
        error_message: data.errorMessage || null
      });
    }
  } catch (err) {
    console.error('Error in API logger:', err);
  }
}

export async function createApiLogger(baseUrl: string = '') {
  return {
    async fetch(url: string, options?: RequestInit): Promise<Response> {
      const fullUrl = baseUrl ? `${baseUrl}${url}` : url;
      const method = options?.method || 'GET';
      const startTime = Date.now();

      let response: Response | null = null;
      let error: Error | null = null;

      try {
        response = await fetch(fullUrl, options);

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const requestHeaders: Record<string, string> = {};
        if (options?.headers) {
          if (options.headers instanceof Headers) {
            options.headers.forEach((value, key) => {
              requestHeaders[key] = value;
            });
          } else if (typeof options.headers === 'object') {
            Object.entries(options.headers).forEach(([key, value]) => {
              requestHeaders[key] = value as string;
            });
          }
        }

        let responseData: unknown = null;
        const contentType = response.headers.get('content-type');

        if (contentType?.includes('application/json')) {
          responseData = await response.clone().json();
        } else if (contentType?.includes('text')) {
          responseData = await response.clone().text();
        }

        let requestBody: Record<string, unknown> = {};
        if (options?.body) {
          try {
            requestBody = typeof options.body === 'string'
              ? JSON.parse(options.body)
              : options.body as Record<string, unknown>;
          } catch {
            requestBody = { raw: String(options.body) };
          }
        }

        const urlObj = new URL(fullUrl);
        const requestParams: Record<string, unknown> = {};
        urlObj.searchParams.forEach((value, key) => {
          requestParams[key] = value;
        });

        await logApiCall({
          endpoint: urlObj.pathname + urlObj.search,
          method,
          requestParams,
          requestBody,
          requestHeaders,
          responseData,
          responseHeaders,
          statusCode: response.status
        });

        return response;
      } catch (err) {
        error = err as Error;

        const urlObj = new URL(fullUrl);
        const requestParams: Record<string, unknown> = {};
        urlObj.searchParams.forEach((value, key) => {
          requestParams[key] = value;
        });

        let requestBody: Record<string, unknown> = {};
        if (options?.body) {
          try {
            requestBody = typeof options.body === 'string'
              ? JSON.parse(options.body)
              : options.body as Record<string, unknown>;
          } catch {
            requestBody = { raw: String(options.body) };
          }
        }

        const requestHeaders: Record<string, string> = {};
        if (options?.headers) {
          if (options.headers instanceof Headers) {
            options.headers.forEach((value, key) => {
              requestHeaders[key] = value;
            });
          } else if (typeof options.headers === 'object') {
            Object.entries(options.headers).forEach(([key, value]) => {
              requestHeaders[key] = value as string;
            });
          }
        }

        await logApiCall({
          endpoint: urlObj.pathname + urlObj.search,
          method,
          requestParams,
          requestBody,
          requestHeaders,
          statusCode: 0,
          errorMessage: error.message
        });

        throw error;
      }
    }
  };
}
