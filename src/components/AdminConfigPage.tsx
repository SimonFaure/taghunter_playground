import { useState, useEffect } from 'react';
import { ShieldCheck, Check, Loader2 } from 'lucide-react';

interface Client {
  id: string;
  name: string;
  email: string;
  url: string;
}

const DEFAULT_CLIENT: Client = {
  id: 'default',
  name: 'Default Server',
  email: 'default@taghunter.com',
  url: '192.168.129.250'
};

export function AdminConfigPage() {
  const [clients, setClients] = useState<Client[]>([DEFAULT_CLIENT]);
  const [selectedClientId, setSelectedClientId] = useState<string>('default');
  const [loading, setLoading] = useState(true);
  const [saveMessage, setSaveMessage] = useState('');
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    loadClients();
  }, []);

  const loadClients = async () => {
    const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

    if (isElectron) {
      try {
        const result = await (window as any).electron.clients.load();
        if (result.success && result.clients.length > 0) {
          setClients([DEFAULT_CLIENT, ...result.clients]);
        }

        const selectedResult = await (window as any).electron.clients.loadSelected();
        if (selectedResult.success && selectedResult.client) {
          setSelectedClientId(selectedResult.client.id);
        } else {
          setSelectedClientId('default');
        }
      } catch (error) {
        console.error('Error loading clients:', error);
      }
    }
    setLoading(false);
  };

  const handleClientSelect = async (client: Client) => {
    if (testingConnection) return;

    console.log('=== FRONTEND: Client selected ===');
    console.log('Client:', client);
    console.log('Client URL:', client.url);
    console.log('URL type:', typeof client.url);

    setSelectedClientId(client.id);
    setTestingConnection(true);
    setConnectionStatus(null);
    setSaveMessage('');

    const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;
    if (isElectron) {
      try {
        console.log('Calling electron.db.testConnection with URL:', client.url);
        const testResult = await (window as any).electron.db.testConnection(client.url);
        console.log('Database test connection result:', testResult);
        setConnectionStatus(testResult);

        if (testResult.success) {
          const result = await (window as any).electron.clients.saveSelected(client);
          console.log('Client saved:', result);
          if (result.success) {
            setSaveMessage('Client configuration saved successfully');
            setTimeout(() => setSaveMessage(''), 3000);
          }
        }
      } catch (error) {
        console.error('Error selecting client:', error);
        setConnectionStatus({ success: false, message: 'Failed to test connection' });
      } finally {
        setTestingConnection(false);
      }
    } else {
      setTestingConnection(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-6 py-8">
        <div className="bg-slate-800 rounded-xl shadow-lg p-6 border border-slate-700">
          <p className="text-slate-300">Loading...</p>
        </div>
      </div>
    );
  }


  return (
    <div className="container mx-auto px-6 py-8">
      <div className="bg-slate-800 rounded-xl shadow-lg p-6 border border-slate-700">
        <div className="flex items-center gap-3 mb-6">
          <ShieldCheck className="text-red-500" size={32} />
          <h2 className="text-2xl font-bold text-white">Admin Configuration</h2>
        </div>

        {saveMessage && (
          <div className="mb-4 p-3 bg-green-900/30 border border-green-700 rounded-lg text-green-400">
            {saveMessage}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label htmlFor="client-select" className="block text-lg font-semibold text-white mb-3">
              Select Client
            </label>
            <select
              id="client-select"
              value={selectedClientId ? clients.find(c => c.id === selectedClientId)?.name : ''}
              onChange={(e) => {
                const clientName = e.target.value;
                const client = clients.find(c => c.name === clientName);
                if (client) {
                  handleClientSelect(client);
                }
              }}
              disabled={testingConnection}
              className="w-full px-4 py-3 bg-slate-700 border-2 border-slate-600 rounded-lg text-white text-base focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {clients.map((client) => (
                <option key={client.id} value={client.name}>
                  {client.name} - {client.email} ({client.url})
                </option>
              ))}
            </select>
          </div>

          {selectedClientId && (
            <div className="p-4 bg-slate-700/50 rounded-lg border border-slate-600">
              {(() => {
                const selected = clients.find(c => c.id === selectedClientId);
                return selected ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Check size={16} className="text-blue-400" />
                      <span className="text-white font-semibold">{selected.name}</span>
                    </div>
                    <div className="text-slate-400 text-sm">{selected.email}</div>
                    <div className="text-slate-500 text-sm">Database: {selected.url}</div>
                  </div>
                ) : null;
              })()}
            </div>
          )}
        </div>

        {testingConnection && (
          <div className="mt-6 p-4 bg-blue-900/30 rounded-lg border border-blue-700 flex items-center gap-3">
            <Loader2 className="animate-spin text-blue-400" size={20} />
            <p className="text-blue-300 text-sm">Testing database connection...</p>
          </div>
        )}

        {connectionStatus && !testingConnection && (
          <div className={`mt-6 p-4 rounded-lg border flex items-center gap-3 ${
            connectionStatus.success
              ? 'bg-green-900/30 border-green-700'
              : 'bg-red-900/30 border-red-700'
          }`}>
            <div className={`w-3 h-3 rounded-full ${
              connectionStatus.success ? 'bg-green-400' : 'bg-red-400'
            }`} />
            <p className={`text-sm ${
              connectionStatus.success ? 'text-green-300' : 'text-red-300'
            }`}>
              {connectionStatus.message}
            </p>
          </div>
        )}

      </div>
    </div>
  );
}
