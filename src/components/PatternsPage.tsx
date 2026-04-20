import { useState, useEffect } from 'react';
import { Map, ChevronRight, Loader, FolderOpen, Upload, Radio, Trash2 } from 'lucide-react';
import { getPatternFolders, getPatternFilesFromStorage } from '../utils/patterns';
import { supabase } from '../lib/db';

const DEFAULT_FOLDERS = ['ado_adultes', 'kids', 'mini_kids'];

interface PatternMeta {
  id: string;
  game_type: string;
  name: string;
  pattern_uniqid: string;
  public: string;
}

interface PatternFolder {
  folder: string;
  meta: PatternMeta | null;
  source: 'static' | 'local';
  storageUniqid?: string;
  storagePath?: string;
  gameType?: string;
}

interface TagquestPatternItem {
  item_index: number;
  assignment_type: string;
  station_key_number: number;
}

function parseCSVRaw(csvContent: string): any[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const result: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = line.match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g) || [];
    const obj: any = {};
    headers.forEach((header, index) => {
      let value = values[index]?.trim() || '';
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      obj[header] = value;
    });
    result.push(obj);
  }
  return result;
}

async function readStaticPatternFile(gameType: string, folder: string, filename: string): Promise<string | null> {
  if ((window as any).electron?.patterns?.readFile) {
    try {
      return await (window as any).electron.patterns.readFile(gameType, folder, filename);
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(`/data/patterns/${gameType}/${folder}/${filename}`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractLocalPatternMeta(slug: string): PatternMeta | null {
  const raw = localStorage.getItem(`pattern_${slug}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return {
        id: parsed.id || '',
        game_type: parsed.game_type || parsed.gameType || '',
        name: parsed.name || parsed.title || '',
        pattern_uniqid: parsed.pattern_uniqid || parsed.uniqid || '',
        public: parsed.public || parsed.audience || '',
      };
    }
  } catch {}
  return null;
}

function VisuelBaliseGrid({ items }: { items: TagquestPatternItem[] }) {
  const quests = [...new Set(items.map(i => i.item_index))].sort((a, b) => a - b);
  const imageTypes = [...new Set(items.map(i => i.assignment_type))]
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ''), 10);
      const numB = parseInt(b.replace(/\D/g, ''), 10);
      return numA - numB;
    });

  const lookup = new Map<string, number>();
  for (const item of items) {
    lookup.set(`${item.item_index}-${item.assignment_type}`, item.station_key_number);
  }

  return (
    <div className="bg-slate-800/60 border-2 border-slate-700 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/80 flex items-center gap-2">
        <Radio size={14} className="text-cyan-400" />
        <p className="text-slate-300 text-sm font-medium">
          {quests.length} quest{quests.length !== 1 ? 's' : ''} — {imageTypes.length} image type{imageTypes.length !== 1 ? 's' : ''}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 bg-slate-800/60">
              <th className="text-left px-4 py-3 text-slate-400 font-semibold whitespace-nowrap">
                Quest
              </th>
              {imageTypes.map(type => (
                <th
                  key={type}
                  className="text-center px-3 py-3 text-slate-400 font-semibold whitespace-nowrap min-w-[80px]"
                >
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-slate-500 font-normal">station</span>
                    <span className="inline-flex items-center justify-center px-2 h-7 rounded-md bg-cyan-900/40 border border-cyan-700/50 text-cyan-300 font-mono font-bold text-xs">
                      {type}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {quests.map((quest, index) => (
              <tr
                key={quest}
                className={`border-b border-slate-700/50 transition hover:bg-slate-700/20 ${
                  index % 2 === 0 ? 'bg-transparent' : 'bg-slate-800/30'
                }`}
              >
                <td className="px-4 py-3">
                  <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-slate-700 border border-slate-600 text-white font-bold text-sm">
                    {quest}
                  </span>
                </td>
                {imageTypes.map(type => {
                  const station = lookup.get(`${quest}-${type}`);
                  return (
                    <td key={type} className="px-3 py-3 text-center">
                      {station !== undefined ? (
                        <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-slate-700 border border-slate-600 text-white font-mono font-bold text-sm hover:bg-cyan-900/40 hover:border-cyan-700/50 hover:text-cyan-200 transition cursor-default">
                          {station}
                        </span>
                      ) : (
                        <span className="text-slate-700 text-lg select-none">·</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PatternsPage() {
  const [gameType] = useState('mystery');
  const [patterns, setPatterns] = useState<PatternFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPattern, setSelectedPattern] = useState<PatternFolder | null>(null);
  const [items, setItems] = useState<TagquestPatternItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PatternFolder | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadPatterns();
  }, [gameType]);

  const loadPatterns = async () => {
    setLoading(true);
    setSelectedPattern(null);
    setItems([]);
    try {
      const folders = await getPatternFolders(gameType);
      const uploadedList: string[] = JSON.parse(localStorage.getItem('uploaded_patterns_list') || '[]');
      const storageFiles = await getPatternFilesFromStorage(gameType);

      const patternList: PatternFolder[] = [];
      for (const folder of folders) {
        const isLocal = !DEFAULT_FOLDERS.includes(folder) && uploadedList.includes(folder);
        let meta: PatternMeta | null = null;
        if (isLocal) {
          meta = extractLocalPatternMeta(folder);
        } else {
          const csv = await readStaticPatternFile(gameType, folder, 'pattern.csv');
          if (csv) {
            const rows = parseCSVRaw(csv);
            if (rows.length > 0) meta = rows[0] as PatternMeta;
          }
        }
        const storageMatch = storageFiles.find(f => f.slug === folder);
        patternList.push({
          folder,
          meta,
          source: isLocal ? 'local' : 'static',
          storageUniqid: storageMatch?.uniqid,
          storagePath: storageMatch?.storagePath,
          gameType,
        });
      }
      setPatterns(patternList);
    } catch (err) {
      console.error('Error loading patterns:', err);
    }
    setLoading(false);
  };

  const handleSelectPattern = async (pattern: PatternFolder) => {
    setSelectedPattern(pattern);
    setItems([]);
    setLoadingItems(true);
    try {
      if (pattern.storagePath) {
        const { data: urlData } = supabase.storage
          .from('resources')
          .getPublicUrl(pattern.storagePath);

        const resp = await fetch(urlData.publicUrl);
        if (resp.ok) {
          const json = await resp.json();
          if (Array.isArray(json?.pattern_data)) {
            const sorted = [...json.pattern_data].sort((a: TagquestPatternItem, b: TagquestPatternItem) =>
              a.item_index - b.item_index
            );
            setItems(sorted);
          }
        }
      }
    } catch (err) {
      console.error('Error loading pattern items:', err);
    }
    setLoadingItems(false);
  };

  const deletePattern = async (pattern: PatternFolder) => {
    setDeleting(true);
    try {
      localStorage.removeItem(`pattern_${pattern.folder}`);
      const list: string[] = JSON.parse(localStorage.getItem('uploaded_patterns_list') || '[]');
      const updated = list.filter(s => s !== pattern.folder);
      localStorage.setItem('uploaded_patterns_list', JSON.stringify(updated));

      if (pattern.storagePath) {
        await supabase.storage.from('resources').remove([pattern.storagePath]);
      }

      await supabase.from('patterns').delete().eq('slug', pattern.folder);

      if (selectedPattern?.folder === pattern.folder) {
        setSelectedPattern(null);
        setItems([]);
      }
      setConfirmDelete(null);
      await loadPatterns();
    } catch (err) {
      console.error('Error deleting pattern:', err);
    }
    setDeleting(false);
  };

  const displayName = (p: PatternFolder) =>
    p.meta?.name || p.folder.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-center gap-3 mb-8">
        <Map size={28} className="text-emerald-400" />
        <div>
          <h2 className="text-3xl font-bold text-white">Patterns</h2>
          <p className="text-slate-400 text-sm mt-0.5">Browse game patterns and their station assignments</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 text-slate-400 py-12">
          <Loader size={20} className="animate-spin" />
          <span>Loading patterns...</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <FolderOpen size={14} />
              {gameType} — {patterns.length} pattern{patterns.length !== 1 ? 's' : ''}
            </h3>

            {patterns.length === 0 && (
              <div className="text-slate-500 text-sm py-6 text-center">No patterns found.</div>
            )}

            {patterns.map(pattern => (
              <div key={pattern.folder} className="relative group/card">
                <button
                  onClick={() => handleSelectPattern(pattern)}
                  className={`w-full text-left p-4 rounded-xl border-2 transition group ${
                    selectedPattern?.folder === pattern.folder
                      ? 'bg-emerald-900/25 border-emerald-500'
                      : 'bg-slate-800/60 border-slate-700 hover:border-slate-500 hover:bg-slate-700/60'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 pr-6">
                      <p className="text-white font-semibold truncate">{displayName(pattern)}</p>
                      <p className="text-slate-400 text-xs mt-0.5 font-mono">{pattern.folder}</p>
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        {pattern.source === 'local' && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-400 border border-blue-800/50 font-medium flex items-center gap-1">
                            <Upload size={10} />
                            uploaded
                          </span>
                        )}
                        {pattern.meta?.game_type && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 font-medium">
                            {pattern.meta.game_type}
                          </span>
                        )}
                        {pattern.meta?.public && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-400 border border-emerald-800/50 font-medium">
                            {pattern.meta.public}
                          </span>
                        )}
                        {pattern.storageUniqid && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-900/40 text-cyan-400 border border-cyan-800/50 font-medium flex items-center gap-1">
                            <Radio size={10} />
                            in storage
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight
                      size={18}
                      className={`shrink-0 ml-3 transition-transform ${
                        selectedPattern?.folder === pattern.folder
                          ? 'text-emerald-400 translate-x-0.5'
                          : 'text-slate-500 group-hover:text-slate-300'
                      }`}
                    />
                  </div>
                </button>
                {pattern.source === 'local' && (
                  <button
                    onClick={e => { e.stopPropagation(); setConfirmDelete(pattern); }}
                    className="absolute top-3 right-3 p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-900/30 opacity-0 group-hover/card:opacity-100 transition"
                    title="Delete pattern"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="lg:col-span-2">
            {!selectedPattern ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center py-20">
                  <Map size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400 text-lg font-medium">Select a pattern</p>
                  <p className="text-slate-500 text-sm mt-1">Click a pattern on the left to view its station assignments</p>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-3 mb-5">
                  <Radio size={18} className="text-cyan-400 shrink-0" />
                  <div>
                    <h3 className="text-xl font-bold text-white">{displayName(selectedPattern)}</h3>
                    <p className="text-slate-400 text-xs mt-0.5 font-mono">{selectedPattern.folder}</p>
                  </div>
                </div>

                {loadingItems ? (
                  <div className="flex items-center gap-3 text-slate-400 py-12 justify-center">
                    <Loader size={20} className="animate-spin" />
                    <span>Loading station assignments...</span>
                  </div>
                ) : !selectedPattern.storagePath ? (
                  <div className="bg-slate-800/60 border-2 border-slate-700 rounded-xl p-10 text-center">
                    <Radio size={36} className="text-slate-600 mx-auto mb-3" />
                    <p className="text-slate-300 font-semibold mb-1">Pattern file not found in storage</p>
                    <p className="text-slate-500 text-sm">
                      Upload a pattern JSON file to view its station assignments.
                    </p>
                  </div>
                ) : items.length === 0 ? (
                  <div className="bg-slate-800/60 border-2 border-slate-700 rounded-xl p-10 text-center">
                    <Radio size={36} className="text-slate-600 mx-auto mb-3" />
                    <p className="text-slate-300 font-semibold mb-1">No station assignments found</p>
                    <p className="text-slate-500 text-sm">
                      The pattern file does not contain a <span className="font-mono text-slate-400">pattern_data</span> array.
                    </p>
                  </div>
                ) : (
                  <VisuelBaliseGrid items={items} />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-900 border-2 border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-red-900/40 border border-red-700/50">
                <Trash2 size={18} className="text-red-400" />
              </div>
              <div>
                <h3 className="text-white font-bold">Delete pattern</h3>
                <p className="text-slate-400 text-xs">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-slate-300 text-sm mb-1">
              Are you sure you want to delete{' '}
              <span className="font-semibold text-white">{displayName(confirmDelete)}</span>?
            </p>
            {confirmDelete.storagePath && (
              <p className="text-amber-400 text-xs mt-2 bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2">
                This will also remove the pattern file from storage.
              </p>
            )}
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => deletePattern(confirmDelete)}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 rounded-xl bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deleting ? (
                  <><Loader size={14} className="animate-spin" /> Deleting...</>
                ) : (
                  <><Trash2 size={14} /> Delete</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
