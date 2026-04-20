import { useState, useEffect } from 'react';
import { Settings, Save, X, Monitor, Eye, EyeOff } from 'lucide-react';
import { supabase } from '../lib/db';

interface LaunchedGameConfigModalProps {
  gameId: number;
  gameName: string;
  onClose: () => void;
  onSave: () => void;
}

interface MetaField {
  id: number;
  meta_name: string;
  meta_value: string | null;
}

interface Device {
  id: number;
  device_id: string;
  connected: boolean;
  last_connexion_attempt: string;
}

interface RawData {
  id: number;
  device_id: string;
  raw_data: any;
  created_at: string;
}


export function LaunchedGameConfigModal({ gameId, gameName, onClose, onSave }: LaunchedGameConfigModalProps) {
  const [metaFields, setMetaFields] = useState<MetaField[]>([]);
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [rawData, setRawData] = useState<Record<string, RawData[]>>({});
  const [showRawData, setShowRawData] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadMetaFields();
    loadDevices();
  }, [gameId]);

  const loadMetaFields = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('launched_game_meta')
      .select('*')
      .eq('launched_game_id', gameId);

    if (error) {
      console.error('Error loading meta fields:', error);
    } else {
      const filteredData = (data || []).filter(field => field.meta_name !== 'firstChipIndex');
      setMetaFields(filteredData);

      const initialValues: Record<string, string> = {};
      filteredData.forEach(field => {
        initialValues[field.meta_name] = field.meta_value || '';
      });
      setEditedValues(initialValues);
    }
    setLoading(false);
  };

  const loadDevices = async () => {
    const { data, error } = await supabase
      .from('launched_game_devices')
      .select('*')
      .eq('launched_game_id', gameId);

    if (error) {
      console.error('Error loading devices:', error);
    } else {
      setDevices(data || []);
      await loadRawDataForDevices(data || []);
    }
  };

  const loadRawDataForDevices = async (devicesList: Device[]) => {
    const rawDataMap: Record<string, RawData[]> = {};

    for (const device of devicesList) {
      const { data, error } = await supabase
        .from('launched_game_raw_data')
        .select('*')
        .eq('launched_game_id', gameId)
        .eq('device_id', device.device_id)
        .order('created_at', { ascending: false });

      if (error) {
        console.error(`Error loading raw data for device ${device.device_id}:`, error);
      } else {
        rawDataMap[device.device_id] = data || [];
      }
    }

    setRawData(rawDataMap);
  };

  const toggleRawData = (deviceId: string) => {
    setShowRawData({
      ...showRawData,
      [deviceId]: !showRawData[deviceId]
    });
  };

  const handleSave = async () => {
    setSaving(true);

    for (const field of metaFields) {
      const newValue = editedValues[field.meta_name];
      if (newValue !== field.meta_value) {
        const { error } = await supabase
          .from('launched_game_meta')
          .update({ meta_value: newValue })
          .eq('id', field.id);

        if (error) {
          console.error(`Error updating ${field.meta_name}:`, error);
        }
      }
    }

    setSaving(false);
    onSave();
    onClose();
  };

  const getFieldLabel = (metaName: string): string => {
    const labels: Record<string, string> = {
      pattern: 'Pattern',
      duration: 'Duration (minutes)',
      messageDisplayDuration: 'Message Display Duration (seconds)',
      enigmaImageDisplayDuration: 'Enigma Image Display Duration (seconds)',
      colorblindMode: 'Colorblind Mode',
      autoResetTeam: 'Auto Reset Team',
      delayBeforeReset: 'Delay Before Reset (seconds)',
      victoryType: 'Victory Type',
    };
    return labels[metaName] || metaName;
  };

  const getFieldType = (metaName: string): 'text' | 'number' | 'checkbox' | 'victoryType' => {
    if (metaName === 'victoryType') return 'victoryType';
    if (metaName === 'colorblindMode' || metaName === 'autoResetTeam') {
      return 'checkbox';
    }
    if (metaName === 'duration' || metaName === 'messageDisplayDuration' ||
        metaName === 'enigmaImageDisplayDuration' || metaName === 'delayBeforeReset') {
      return 'number';
    }
    return 'text';
  };

  const handleValueChange = (metaName: string, value: string | boolean) => {
    const stringValue = typeof value === 'boolean' ? value.toString() : value;
    setEditedValues({
      ...editedValues,
      [metaName]: stringValue
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-slate-800 border-2 border-slate-700 rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-2xl font-bold text-white flex items-center gap-2">
            <Settings size={24} className="text-blue-500" />
            Game Configuration
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition"
            title="Close"
          >
            <X size={24} />
          </button>
        </div>

        <div className="mb-4 pb-4 border-b border-slate-700">
          <p className="text-slate-400 text-sm">Game: <span className="text-white font-semibold">{gameName}</span></p>
        </div>

        {loading ? (
          <div className="text-center py-8 text-slate-400">Loading configuration...</div>
        ) : (
          <div className="space-y-4">
            {metaFields.map((field) => {
              const fieldType = getFieldType(field.meta_name);
              const value = editedValues[field.meta_name] || '';

              return (
                <div key={field.id}>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    {getFieldLabel(field.meta_name)}
                  </label>
                  {fieldType === 'victoryType' ? (
                    <div className="grid grid-cols-2 gap-3">
                      {(['speed', 'score'] as const).map((vt) => (
                        <button
                          key={vt}
                          type="button"
                          onClick={() => handleValueChange(field.meta_name, vt)}
                          className={`relative p-3 rounded-lg border-2 text-left transition-all ${
                            value === vt
                              ? vt === 'speed' ? 'border-orange-500 bg-orange-500/10' : 'border-blue-500 bg-blue-500/10'
                              : 'border-slate-600 bg-slate-700 hover:border-slate-500'
                          }`}
                        >
                          <div className={`font-semibold text-sm ${value === vt ? (vt === 'speed' ? 'text-orange-400' : 'text-blue-400') : 'text-slate-300'}`}>
                            {vt === 'speed' ? 'Rapidite' : 'Score'}
                          </div>
                          {value === vt && (
                            <div className={`absolute top-2 right-2 w-2 h-2 rounded-full ${vt === 'speed' ? 'bg-orange-500' : 'bg-blue-500'}`} />
                          )}
                        </button>
                      ))}
                    </div>
                  ) : fieldType === 'checkbox' ? (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={value === 'true'}
                        onChange={(e) => handleValueChange(field.meta_name, e.target.checked)}
                        className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                      <span className="text-slate-400 text-sm">Enable</span>
                    </label>
                  ) : (
                    <input
                      type={fieldType}
                      value={value}
                      onChange={(e) => handleValueChange(field.meta_name, e.target.value)}
                      className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {devices.length > 0 && (
          <div className="mt-8 pt-6 border-t border-slate-700">
            <h4 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <Monitor size={20} className="text-green-500" />
              Connected Devices
            </h4>
            <div className="space-y-4">
              {devices.map((device) => (
                <div key={device.id} className="bg-slate-700/50 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${device.connected ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="text-white font-medium">{device.device_id}</span>
                    </div>
                    {rawData[device.device_id] && rawData[device.device_id].length > 0 && (
                      <button
                        onClick={() => toggleRawData(device.device_id)}
                        className="flex items-center gap-2 px-3 py-1 bg-slate-600 hover:bg-slate-500 text-white rounded text-sm transition"
                      >
                        {showRawData[device.device_id] ? <EyeOff size={16} /> : <Eye size={16} />}
                        {showRawData[device.device_id] ? 'Hide' : 'Show'} Raw Data ({rawData[device.device_id].length})
                      </button>
                    )}
                  </div>
                  <p className="text-slate-400 text-xs">
                    Last connection: {new Date(device.last_connexion_attempt).toLocaleString()}
                  </p>

                  {showRawData[device.device_id] && rawData[device.device_id] && (
                    <div className="mt-4 space-y-3">
                      <h5 className="text-sm font-semibold text-slate-300">Card Punch Data:</h5>
                      {rawData[device.device_id].map((data) => (
                        <div key={data.id} className="bg-slate-800/70 rounded p-3">
                          <div className="flex justify-between items-start mb-2">
                            <span className="text-xs text-slate-400">
                              {new Date(data.created_at).toLocaleString()}
                            </span>
                          </div>
                          <pre className="text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap">
                            {JSON.stringify(data.raw_data, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3 mt-6 pt-6 border-t border-slate-700">
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition"
          >
            <Save size={18} />
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-3 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 text-white rounded-lg font-medium transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
