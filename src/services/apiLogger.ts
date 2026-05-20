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

// Phase 2: Electron's apiLogs IPC handler is gone, and Tauri has no
// equivalent disk-backed logger (telemetry's pending_writes is for outbound
// events, not API call traces). `logApiCall` is kept as a thin no-op so that
// the many `createApiLogger` call sites don't need updating; if a Tauri-side
// log viewer is wanted later, this is the one place to wire it.
export async function logApiCall(_data: ApiLogData): Promise<void> {
  // intentional no-op
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
