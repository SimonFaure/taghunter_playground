import { useEffect, useState } from 'react';
import { Activity, ChevronDown, ChevronRight, RefreshCw, Trash2 } from 'lucide-react';

interface ApiLog {
  endpoint: string;
  method: string;
  request_params: Record<string, unknown>;
  request_body?: Record<string, unknown>;
  request_headers?: Record<string, string>;
  response_data: unknown;
  response_headers?: Record<string, string>;
  status_code: number;
  error_message?: string;
  timestamp: string;
}

export function ApiLogsPage() {
  const [logs, setLogs] = useState<ApiLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadLogs = async () => {
    if (!window.electron?.apiLogs) {
      setError('API logs not available');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await window.electron.apiLogs.read();

      if (!result.success) {
        throw new Error(result.error || 'Failed to load logs');
      }

      const sortedLogs = (result.logs || []).sort((a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      setLogs(sortedLogs);
    } catch (err) {
      console.error('Error loading API logs:', err);
      setError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      setIsLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!window.electron?.apiLogs) return;

    if (!confirm('Are you sure you want to clear all API logs?')) {
      return;
    }

    try {
      const result = await window.electron.apiLogs.clear();

      if (!result.success) {
        throw new Error(result.error || 'Failed to clear logs');
      }

      setLogs([]);
    } catch (err) {
      console.error('Error clearing logs:', err);
      setError(err instanceof Error ? err.message : 'Failed to clear logs');
    }
  };

  useEffect(() => {
    loadLogs();
  }, []);

  const toggleLog = (id: number) => {
    const newExpanded = new Set(expandedLogs);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedLogs(newExpanded);
  };

  const getStatusColor = (statusCode: number) => {
    if (statusCode >= 200 && statusCode < 300) {
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    } else if (statusCode >= 400 && statusCode < 500) {
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    } else if (statusCode >= 500) {
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    }
    return 'bg-slate-500/20 text-slate-400 border-slate-500/30';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white py-8">
      <div className="container mx-auto px-6 max-w-6xl">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Activity className="text-blue-400" size={32} />
            <h1 className="text-3xl font-bold">API Logs</h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={loadLogs}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button
              onClick={clearLogs}
              disabled={isLoading || logs.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 size={16} />
              Clear All
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg p-4">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="text-center py-12 text-slate-400">
            <RefreshCw className="animate-spin mx-auto mb-4" size={32} />
            Loading API logs...
          </div>
        ) : logs.length === 0 ? (
          <div className="bg-slate-800/50 rounded-lg p-12 text-center">
            <Activity className="mx-auto mb-4 text-slate-600" size={48} />
            <p className="text-slate-400 text-lg">No API logs yet</p>
            <p className="text-slate-500 text-sm mt-2">
              Logs will appear here when API calls are made
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {logs.map((log, index) => {
              const logId = index;
              const isExpanded = expandedLogs.has(logId);
              const hasError = log.error_message || log.status_code >= 400;

              return (
                <div
                  key={logId}
                  className={`bg-slate-800/50 rounded-lg overflow-hidden border ${
                    hasError ? 'border-red-500/30' : 'border-slate-700'
                  }`}
                >
                  <button
                    onClick={() => toggleLog(logId)}
                    className="w-full px-6 py-4 flex items-center justify-between hover:bg-slate-700/30 transition-colors"
                  >
                    <div className="flex items-center gap-4 flex-1">
                      <span className={`px-3 py-1 rounded text-xs font-bold ${
                        log.method === 'GET' ? 'bg-blue-600' : 'bg-green-600'
                      }`}>
                        {log.method}
                      </span>

                      <span className={`px-2 py-1 rounded text-xs font-semibold border ${getStatusColor(log.status_code)}`}>
                        {log.status_code}
                      </span>

                      <div className="flex-1 text-left">
                        <p className="font-mono text-sm text-slate-300">{log.endpoint}</p>
                        <p className="text-xs text-slate-500 mt-1">
                          {new Date(log.timestamp).toLocaleString()}
                        </p>
                      </div>

                      {hasError && (
                        <span className="px-2 py-1 bg-red-500/20 text-red-400 text-xs rounded border border-red-500/30">
                          Error
                        </span>
                      )}
                    </div>

                    {isExpanded ? (
                      <ChevronDown className="text-slate-400" size={20} />
                    ) : (
                      <ChevronRight className="text-slate-400" size={20} />
                    )}
                  </button>

                  {isExpanded && (
                    <div className="px-6 pb-6 space-y-4">
                      {log.request_headers && Object.keys(log.request_headers).length > 0 && (
                        <div>
                          <h4 className="text-sm font-semibold text-slate-300 mb-2">Request Headers</h4>
                          <pre className="bg-slate-900 rounded-lg p-4 overflow-x-auto border border-slate-700">
                            <code className="text-sm text-blue-300">
                              {JSON.stringify(log.request_headers, null, 2)}
                            </code>
                          </pre>
                        </div>
                      )}

                      {log.request_params && Object.keys(log.request_params).length > 0 && (
                        <div>
                          <h4 className="text-sm font-semibold text-slate-300 mb-2">Request Parameters</h4>
                          <pre className="bg-slate-900 rounded-lg p-4 overflow-x-auto border border-slate-700">
                            <code className="text-sm text-blue-300">
                              {JSON.stringify(log.request_params, null, 2)}
                            </code>
                          </pre>
                        </div>
                      )}

                      {log.request_body && Object.keys(log.request_body).length > 0 && (
                        <div>
                          <h4 className="text-sm font-semibold text-slate-300 mb-2">Request Body</h4>
                          <pre className="bg-slate-900 rounded-lg p-4 overflow-x-auto border border-slate-700">
                            <code className="text-sm text-blue-300">
                              {JSON.stringify(log.request_body, null, 2)}
                            </code>
                          </pre>
                        </div>
                      )}

                      {log.error_message ? (
                        <div>
                          <h4 className="text-sm font-semibold text-red-400 mb-2">Error Message</h4>
                          <div className="bg-red-500/10 rounded-lg p-4 border border-red-500/30">
                            <p className="text-red-300 text-sm">{log.error_message}</p>
                          </div>
                        </div>
                      ) : (
                        <>
                          {log.response_headers && Object.keys(log.response_headers).length > 0 && (
                            <div>
                              <h4 className="text-sm font-semibold text-slate-300 mb-2">Response Headers</h4>
                              <pre className="bg-slate-900 rounded-lg p-4 overflow-x-auto border border-slate-700">
                                <code className="text-sm text-green-300">
                                  {JSON.stringify(log.response_headers, null, 2)}
                                </code>
                              </pre>
                            </div>
                          )}

                          <div>
                            <h4 className="text-sm font-semibold text-slate-300 mb-2">Response Data</h4>
                            <pre className="bg-slate-900 rounded-lg p-4 overflow-x-auto border border-slate-700">
                              <code className="text-sm text-green-300">
                                {JSON.stringify(log.response_data, null, 2)}
                              </code>
                            </pre>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
