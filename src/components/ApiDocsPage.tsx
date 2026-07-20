import { useState, useMemo } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Copy, Check, Globe, Server } from 'lucide-react';
import { apiEndpoints } from '../data/apiEndpoints';

export function ApiDocsPage() {
  const [expandedEndpoints, setExpandedEndpoints] = useState<Set<string>>(new Set());
  const [copiedSections, setCopiedSections] = useState<Set<string>>(new Set());

  // Group endpoints by base URL
  const groupedEndpoints = useMemo(() => {
    const groups: Record<string, typeof apiEndpoints> = {
      'External API (https://studio.taghunter.fr)': [],
      'Local API (http://localhost:3000)': []
    };

    apiEndpoints.forEach(endpoint => {
      if (endpoint.path.startsWith('/backend/')) {
        groups['External API (https://studio.taghunter.fr)'].push(endpoint);
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
        return 'bg-[var(--pg-surface-3)] text-[var(--pg-text)]';
    }
  };

  const getStatusColor = (code: number) => {
    if (code >= 200 && code < 300) return 'text-green-400';
    if (code >= 400 && code < 500) return 'text-yellow-400';
    if (code >= 500) return 'text-red-400';
    return 'text-[var(--pg-text-dim)]';
  };

  return (
    <div className="min-h-screen pg-app-bg text-[var(--pg-text)] py-8">
      <div className="container mx-auto px-6 max-w-6xl">
        <div className="flex items-center gap-3 mb-8">
          <BookOpen className="text-[var(--pg-accent-bright)]" size={32} />
          <h1 className="text-3xl font-bold">API Documentation</h1>
        </div>

        <div className="mb-8 bg-[var(--pg-surface)] rounded-[var(--pg-radius-md)] p-6 border border-[var(--pg-line)]">
          <h2 className="text-xl font-semibold mb-3">Overview</h2>
          <p className="text-[var(--pg-text-muted)] mb-4">
            This documentation describes the available API endpoints for the Taghunter Playground system.
            These endpoints handle scenario management, game sessions, and gameplay data.
          </p>
          <div className="bg-[var(--pg-bg)] rounded-[var(--pg-radius-md)] p-4 border border-[var(--pg-line)]">
            <h3 className="text-lg font-semibold text-[var(--pg-text)] mb-2">Base URLs</h3>
            <ul className="space-y-1 text-[var(--pg-text-dim)]">
              <li><strong>External API:</strong> https://studio.taghunter.fr</li>
              <li><strong>Local API:</strong> http://localhost:3000/api</li>
            </ul>
          </div>
        </div>

        <div className="space-y-8">
          {Object.entries(groupedEndpoints).map(([groupName, endpoints]) => (
            <div key={groupName} className="space-y-4">
              <div className="flex items-center gap-3 pb-3 border-b border-[var(--pg-line)]">
                {groupName.includes('External') ? (
                  <Globe className="text-blue-400" size={24} />
                ) : (
                  <Server className="text-green-400" size={24} />
                )}
                <h2 className="text-2xl font-bold text-[var(--pg-text)]">{groupName}</h2>
                <span className="text-sm text-[var(--pg-text-dim)]">({endpoints.length} endpoints)</span>
              </div>

              {endpoints.map((endpoint, index) => {
                const endpointId = `${groupName}-${index}`;
                const isExpanded = expandedEndpoints.has(endpointId);
                const requestCopyId = `request-${endpointId}`;
                const responseCopyId = `response-${endpointId}`;

                return (
                  <div
                    key={endpointId}
                    className="bg-[var(--pg-surface)] rounded-[var(--pg-radius-md)] overflow-hidden border border-[var(--pg-line)]"
                  >
                    <button
                      onClick={() => toggleEndpoint(endpointId)}
                      className="w-full px-6 py-4 flex items-center justify-between hover:bg-[var(--pg-surface-2)] transition-colors"
                    >
                      <div className="flex items-center gap-4 flex-1 text-left">
                        <span className={`px-3 py-1 rounded text-xs font-bold ${getMethodColor(endpoint.method)}`}>
                          {endpoint.method}
                        </span>
                        <div className="flex-1">
                          <h3 className="font-semibold text-lg text-[var(--pg-text)]">{endpoint.name}</h3>
                          <p className="text-sm text-[var(--pg-text-dim)] font-mono mt-1">{endpoint.path}</p>
                        </div>
                      </div>
                      {isExpanded ? (
                        <ChevronDown className="text-[var(--pg-text-dim)]" size={20} />
                      ) : (
                        <ChevronRight className="text-[var(--pg-text-dim)]" size={20} />
                      )}
                    </button>

                    {isExpanded && (
                      <div className="px-6 pb-6 space-y-6">
                        <div>
                          <h4 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-2">Description</h4>
                          <p className="text-[var(--pg-text-dim)]">{endpoint.description}</p>
                        </div>

                        {endpoint.parameters.length > 0 && (
                          <div>
                            <h4 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-3">Parameters</h4>
                            <div className="space-y-2">
                              {endpoint.parameters.map((param, paramIndex) => (
                                <div
                                  key={paramIndex}
                                  className="bg-[var(--pg-bg)] rounded-[var(--pg-radius-md)] p-4 border border-[var(--pg-line)]"
                                >
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="font-mono text-[var(--pg-accent-bright)]">{param.name}</span>
                                    <span className="text-xs px-2 py-0.5 bg-[var(--pg-surface-3)] rounded text-[var(--pg-text-muted)]">
                                      {param.type}
                                    </span>
                                    {param.required && (
                                      <span className="text-xs px-2 py-0.5 bg-red-500/20 text-red-400 rounded border border-red-500/30">
                                        required
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-sm text-[var(--pg-text-dim)]">{param.description}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-sm font-semibold text-[var(--pg-text-muted)]">Example Request</h4>
                            <button
                              onClick={() => copyToClipboard(endpoint.exampleRequest, requestCopyId)}
                              className="flex items-center gap-1 text-xs text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] transition-colors"
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
                          <pre className="bg-[var(--pg-bg)] rounded-[var(--pg-radius-md)] p-4 overflow-x-auto border border-[var(--pg-line)]">
                            <code className="text-sm text-[var(--pg-text-muted)]">
                              {endpoint.exampleRequest}
                            </code>
                          </pre>
                        </div>

                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-sm font-semibold text-[var(--pg-text-muted)]">Example Response</h4>
                            <button
                              onClick={() => copyToClipboard(endpoint.exampleResponse, responseCopyId)}
                              className="flex items-center gap-1 text-xs text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] transition-colors"
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
                          <pre className="bg-[var(--pg-bg)] rounded-[var(--pg-radius-md)] p-4 overflow-x-auto border border-[var(--pg-line)]">
                            <code className="text-sm text-green-300">
                              {endpoint.exampleResponse}
                            </code>
                          </pre>
                        </div>

                        <div>
                          <h4 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-3">Status Codes</h4>
                          <div className="space-y-2">
                            {endpoint.statusCodes.map((status, statusIndex) => (
                              <div
                                key={statusIndex}
                                className="flex items-center gap-3 text-sm"
                              >
                                <span className={`font-mono font-semibold ${getStatusColor(status.code)}`}>
                                  {status.code}
                                </span>
                                <span className="text-[var(--pg-text-dim)]">{status.description}</span>
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

        <div className="mt-8 bg-[var(--pg-surface)] rounded-[var(--pg-radius-md)] p-6 border border-[var(--pg-line)]">
          <h3 className="text-lg font-semibold text-[var(--pg-text)] mb-3">Local Scenario Storage</h3>
          <p className="text-[var(--pg-text-muted)] mb-3">
            Scenarios are stored locally on the computer at the following locations:
          </p>
          <ul className="list-disc list-inside space-y-1 text-[var(--pg-text-dim)]">
            <li><strong>Windows:</strong> C:\ProgramData\Taghunter\scenarios\scenarios.json</li>
            <li><strong>macOS:</strong> /Library/Application Support/Taghunter/scenarios/scenarios.json</li>
            <li><strong>Linux:</strong> /usr/share/taghunter/scenarios/scenarios.json</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
