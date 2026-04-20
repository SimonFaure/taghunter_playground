import { useState, useMemo } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Copy, Check, Globe, Server } from 'lucide-react';
import { apiEndpoints } from '../data/apiEndpoints';

export function ApiDocsPage() {
  const [expandedEndpoints, setExpandedEndpoints] = useState<Set<string>>(new Set());
  const [copiedSections, setCopiedSections] = useState<Set<string>>(new Set());

  // Group endpoints by base URL
  const groupedEndpoints = useMemo(() => {
    const groups: Record<string, typeof apiEndpoints> = {
      'External API (https://admin.taghunter.fr)': [],
      'Local API (http://localhost:3000)': []
    };

    apiEndpoints.forEach(endpoint => {
      if (endpoint.path.startsWith('/backend/')) {
        groups['External API (https://admin.taghunter.fr)'].push(endpoint);
      } else if (endpoint.path.startsWith('/api/')) {
        groups['Local API (http://localhost:3000)'].push(endpoint);
      }
    });

    return groups;
  }, []);

  const toggleEndpoint = (id: string) => {
    const newExpanded = new Set(expandedEndpoints);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedEndpoints(newExpanded);
  };

  const copyToClipboard = (text: string, sectionId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSections(new Set(copiedSections).add(sectionId));
    setTimeout(() => {
      setCopiedSections(prev => {
        const newSet = new Set(prev);
        newSet.delete(sectionId);
        return newSet;
      });
    }, 2000);
  };

  const getMethodColor = (method: string) => {
    switch (method) {
      case 'GET':
        return 'bg-blue-600 text-white';
      case 'POST':
        return 'bg-green-600 text-white';
      case 'PUT':
        return 'bg-yellow-600 text-white';
      case 'DELETE':
        return 'bg-red-600 text-white';
      default:
        return 'bg-slate-600 text-white';
    }
  };

  const getStatusColor = (code: number) => {
    if (code >= 200 && code < 300) return 'text-green-400';
    if (code >= 400 && code < 500) return 'text-yellow-400';
    if (code >= 500) return 'text-red-400';
    return 'text-slate-400';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white py-8">
      <div className="container mx-auto px-6 max-w-6xl">
        <div className="flex items-center gap-3 mb-8">
          <BookOpen className="text-blue-400" size={32} />
          <h1 className="text-3xl font-bold">API Documentation</h1>
        </div>

        <div className="mb-8 bg-slate-800/50 rounded-lg p-6 border border-slate-700">
          <h2 className="text-xl font-semibold mb-3">Overview</h2>
          <p className="text-slate-300 mb-4">
            This documentation describes the available API endpoints for the Taghunter Playground system.
            These endpoints handle scenario management, game sessions, and gameplay data.
          </p>
          <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700">
            <h3 className="text-lg font-semibold text-white mb-2">Base URLs</h3>
            <ul className="space-y-1 text-slate-400">
              <li><strong>External API:</strong> https://admin.taghunter.fr</li>
              <li><strong>Local API:</strong> http://localhost:3000/api</li>
            </ul>
          </div>
        </div>

        <div className="space-y-8">
          {Object.entries(groupedEndpoints).map(([groupName, endpoints]) => (
            <div key={groupName} className="space-y-4">
              <div className="flex items-center gap-3 pb-3 border-b border-slate-700">
                {groupName.includes('External') ? (
                  <Globe className="text-blue-400" size={24} />
                ) : (
                  <Server className="text-green-400" size={24} />
                )}
                <h2 className="text-2xl font-bold text-white">{groupName}</h2>
                <span className="text-sm text-slate-400">({endpoints.length} endpoints)</span>
              </div>

              {endpoints.map((endpoint, index) => {
                const endpointId = `${groupName}-${index}`;
                const isExpanded = expandedEndpoints.has(endpointId);
                const requestCopyId = `request-${endpointId}`;
                const responseCopyId = `response-${endpointId}`;

                return (
                  <div
                    key={endpointId}
                    className="bg-slate-800/50 rounded-lg overflow-hidden border border-slate-700"
                  >
                    <button
                      onClick={() => toggleEndpoint(endpointId)}
                      className="w-full px-6 py-4 flex items-center justify-between hover:bg-slate-700/30 transition-colors"
                    >
                      <div className="flex items-center gap-4 flex-1 text-left">
                        <span className={`px-3 py-1 rounded text-xs font-bold ${getMethodColor(endpoint.method)}`}>
                          {endpoint.method}
                        </span>
                        <div className="flex-1">
                          <h3 className="font-semibold text-lg text-white">{endpoint.name}</h3>
                          <p className="text-sm text-slate-400 font-mono mt-1">{endpoint.path}</p>
                        </div>
                      </div>
                      {isExpanded ? (
                        <ChevronDown className="text-slate-400" size={20} />
                      ) : (
                        <ChevronRight className="text-slate-400" size={20} />
                      )}
                    </button>

                    {isExpanded && (
                      <div className="px-6 pb-6 space-y-6">
                        <div>
                          <h4 className="text-sm font-semibold text-slate-300 mb-2">Description</h4>
                          <p className="text-slate-400">{endpoint.description}</p>
                        </div>

                        {endpoint.parameters.length > 0 && (
                          <div>
                            <h4 className="text-sm font-semibold text-slate-300 mb-3">Parameters</h4>
                            <div className="space-y-2">
                              {endpoint.parameters.map((param, paramIndex) => (
                                <div
                                  key={paramIndex}
                                  className="bg-slate-900/50 rounded-lg p-4 border border-slate-700"
                                >
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="font-mono text-blue-400">{param.name}</span>
                                    <span className="text-xs px-2 py-0.5 bg-slate-700 rounded text-slate-300">
                                      {param.type}
                                    </span>
                                    {param.required && (
                                      <span className="text-xs px-2 py-0.5 bg-red-500/20 text-red-400 rounded border border-red-500/30">
                                        required
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-sm text-slate-400">{param.description}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-sm font-semibold text-slate-300">Example Request</h4>
                            <button
                              onClick={() => copyToClipboard(endpoint.exampleRequest, requestCopyId)}
                              className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
                            >
                              {copiedSections.has(requestCopyId) ? (
                                <>
                                  <Check size={14} className="text-green-400" />
                                  <span className="text-green-400">Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={14} />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="bg-slate-900 rounded-lg p-4 overflow-x-auto border border-slate-700">
                            <code className="text-sm text-slate-300">
                              {endpoint.exampleRequest}
                            </code>
                          </pre>
                        </div>

                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-sm font-semibold text-slate-300">Example Response</h4>
                            <button
                              onClick={() => copyToClipboard(endpoint.exampleResponse, responseCopyId)}
                              className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
                            >
                              {copiedSections.has(responseCopyId) ? (
                                <>
                                  <Check size={14} className="text-green-400" />
                                  <span className="text-green-400">Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={14} />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="bg-slate-900 rounded-lg p-4 overflow-x-auto border border-slate-700">
                            <code className="text-sm text-green-300">
                              {endpoint.exampleResponse}
                            </code>
                          </pre>
                        </div>

                        <div>
                          <h4 className="text-sm font-semibold text-slate-300 mb-3">Status Codes</h4>
                          <div className="space-y-2">
                            {endpoint.statusCodes.map((status, statusIndex) => (
                              <div
                                key={statusIndex}
                                className="flex items-center gap-3 text-sm"
                              >
                                <span className={`font-mono font-semibold ${getStatusColor(status.code)}`}>
                                  {status.code}
                                </span>
                                <span className="text-slate-400">{status.description}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="mt-8 bg-slate-800/50 rounded-lg p-6 border border-slate-700">
          <h3 className="text-lg font-semibold text-white mb-3">Local Scenario Storage</h3>
          <p className="text-slate-300 mb-3">
            Scenarios are stored locally on the computer at the following locations:
          </p>
          <ul className="list-disc list-inside space-y-1 text-slate-400">
            <li><strong>Windows:</strong> C:\ProgramData\Taghunter\scenarios\scenarios.json</li>
            <li><strong>macOS:</strong> /Library/Application Support/Taghunter/scenarios/scenarios.json</li>
            <li><strong>Linux:</strong> /usr/share/taghunter/scenarios/scenarios.json</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
