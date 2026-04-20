import { useState, useEffect } from 'react';
import { CreditCard, Download, RefreshCw, AlertCircle, Package, Layers } from 'lucide-react';
import { getUserDataUpdate, PatternInfo } from '../services/resourceSync';
import { loadConfig } from '../utils/config';

interface Client {
  id: string;
  name: string;
  email: string;
  url: string;
}

interface ClientData {
  cardsVersion: number;
  hasOnDemandCards: boolean;
  defaultPatterns: PatternInfo[];
  customPatterns: PatternInfo[];
  billingUpToDate: boolean;
  licenseType: string;
}

export default function ClientCardsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [clientData, setClientData] = useState<ClientData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadClients();
  }, []);

  const loadClients = async () => {
    try {
      const clientsData = await (window as any).electron.clients.getAll();
      setClients(clientsData);
      if (clientsData.length > 0) {
        setSelectedClient(clientsData[0]);
        await loadClientData(clientsData[0].email);
      }
    } catch (err) {
      console.error('Failed to load clients:', err);
      setError('Failed to load clients');
    }
  };

  const loadClientData = async (email: string) => {
    setLoading(true);
    setError(null);
    try {
      const apiUrl = 'https://admin.taghunter.fr/backend/api/playground.php';
      const userData = await getUserDataUpdate(apiUrl, email);

      setClientData({
        cardsVersion: userData.cards_version,
        hasOnDemandCards: userData.has_on_demand_cards,
        defaultPatterns: userData.default_patterns,
        customPatterns: userData.custom_patterns,
        billingUpToDate: userData.billing_up_to_date,
        licenseType: userData.license_type,
      });
    } catch (err) {
      console.error('Failed to load client data:', err);
      setError('Failed to load client data');
    } finally {
      setLoading(false);
    }
  };

  const handleClientChange = async (clientId: string) => {
    const client = clients.find(c => c.id === clientId);
    if (client) {
      setSelectedClient(client);
      await loadClientData(client.email);
    }
  };

  const handleRefresh = () => {
    if (selectedClient) {
      loadClientData(selectedClient.email);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center space-x-3">
            <CreditCard className="w-8 h-8 text-slate-700" />
            <h1 className="text-3xl font-bold text-slate-900">Client Cards & Patterns</h1>
          </div>
          <button
            onClick={handleRefresh}
            disabled={loading || !selectedClient}
            className="flex items-center space-x-2 px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
          <label className="block text-sm font-medium text-slate-700 mb-2">
            Select Client
          </label>
          <select
            value={selectedClient?.id || ''}
            onChange={(e) => handleClientChange(e.target.value)}
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-500 focus:border-transparent"
          >
            {clients.map(client => (
              <option key={client.id} value={client.id}>
                {client.name} ({client.email})
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-medium text-red-900">Error</h3>
              <p className="text-red-700 text-sm mt-1">{error}</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl shadow-lg p-12 flex flex-col items-center justify-center">
            <RefreshCw className="w-12 h-12 text-slate-400 animate-spin mb-4" />
            <p className="text-slate-600">Loading client data...</p>
          </div>
        ) : clientData ? (
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-lg p-6">
              <h2 className="text-xl font-bold text-slate-900 mb-4 flex items-center space-x-2">
                <CreditCard className="w-6 h-6" />
                <span>Cards Information</span>
              </h2>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <p className="text-sm text-slate-600 mb-1">Cards Version</p>
                  <p className="text-2xl font-bold text-slate-900">{clientData.cardsVersion}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-600 mb-1">On-Demand Cards</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {clientData.hasOnDemandCards ? (
                      <span className="text-green-600">Yes</span>
                    ) : (
                      <span className="text-slate-400">No</span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-slate-600 mb-1">Billing Status</p>
                  <p className="text-2xl font-bold">
                    {clientData.billingUpToDate ? (
                      <span className="text-green-600">Up to Date</span>
                    ) : (
                      <span className="text-red-600">Pending</span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-slate-600 mb-1">License Type</p>
                  <p className="text-2xl font-bold text-slate-900">{clientData.licenseType}</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-lg p-6">
              <h2 className="text-xl font-bold text-slate-900 mb-4 flex items-center space-x-2">
                <Package className="w-6 h-6" />
                <span>Default Patterns ({clientData.defaultPatterns.length})</span>
              </h2>
              {clientData.defaultPatterns.length === 0 ? (
                <p className="text-slate-500 italic">No default patterns found</p>
              ) : (
                <div className="space-y-3">
                  {clientData.defaultPatterns.map((pattern, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200"
                    >
                      <div className="flex-1">
                        <h3 className="font-semibold text-slate-900">{pattern.name}</h3>
                        <div className="flex items-center space-x-4 mt-1 text-sm text-slate-600">
                          <span>Game Type: {pattern.game_type}</span>
                          <span>Version: {pattern.version}</span>
                          <span className="font-mono text-xs bg-slate-200 px-2 py-1 rounded">
                            {pattern.uniqid}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl shadow-lg p-6">
              <h2 className="text-xl font-bold text-slate-900 mb-4 flex items-center space-x-2">
                <Layers className="w-6 h-6" />
                <span>Custom Patterns ({clientData.customPatterns.length})</span>
              </h2>
              {clientData.customPatterns.length === 0 ? (
                <p className="text-slate-500 italic">No custom patterns found</p>
              ) : (
                <div className="space-y-3">
                  {clientData.customPatterns.map((pattern, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-4 bg-blue-50 rounded-lg border border-blue-200"
                    >
                      <div className="flex-1">
                        <h3 className="font-semibold text-slate-900">{pattern.name}</h3>
                        <div className="flex items-center space-x-4 mt-1 text-sm text-slate-600">
                          <span>Game Type: {pattern.game_type}</span>
                          <span>Version: {pattern.version}</span>
                          <span className="font-mono text-xs bg-blue-200 px-2 py-1 rounded">
                            {pattern.uniqid}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-lg p-12 text-center">
            <CreditCard className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500">Select a client to view their cards and patterns</p>
          </div>
        )}
      </div>
    </div>
  );
}
