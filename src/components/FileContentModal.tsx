import { X, FileJson, FileText, Download } from 'lucide-react';

interface FileContentModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  content: string | null;
  loading: boolean;
  error: string | null;
}

export function FileContentModal({ isOpen, onClose, fileName, content, loading, error }: FileContentModalProps) {
  if (!isOpen) return null;

  const isJson = fileName.endsWith('.json');
  const isCsv = fileName.endsWith('.csv');

  const formatContent = (raw: string): string => {
    if (isJson) {
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return raw;
      }
    }
    return raw;
  };

  const handleDownload = () => {
    if (!content) return;
    const blob = new Blob([content], { type: isJson ? 'application/json' : 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderCsvTable = (csv: string) => {
    const lines = csv.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    const parseRow = (line: string): string[] => {
      const result: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    };

    const headers = parseRow(lines[0]);
    const rows = lines.slice(1).map(parseRow);

    return (
      <div className="overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-slate-700/80 sticky top-0">
              {headers.map((h, i) => (
                <th key={i} className="px-3 py-2 text-left text-slate-300 font-semibold border-b border-slate-600 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? 'bg-slate-800/40' : 'bg-slate-800/20'}>
                {headers.map((_, ci) => (
                  <td key={ci} className="px-3 py-1.5 text-slate-300 border-b border-slate-700/50 whitespace-nowrap max-w-xs truncate">
                    {row[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {isJson ? (
              <FileJson className="w-5 h-5 text-blue-400 shrink-0" />
            ) : (
              <FileText className="w-5 h-5 text-emerald-400 shrink-0" />
            )}
            <span className="font-semibold text-slate-100 truncate">{fileName}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            {content && (
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded-lg transition-colors"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto min-h-0">
          {loading && (
            <div className="flex items-center justify-center h-48 text-slate-400">
              <div className="w-6 h-6 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin mr-3" />
              Loading file...
            </div>
          )}
          {error && (
            <div className="p-6 text-red-400 text-sm">{error}</div>
          )}
          {!loading && !error && content && (
            isCsv ? (
              renderCsvTable(content)
            ) : (
              <pre className="p-6 text-xs text-slate-300 font-mono whitespace-pre overflow-auto leading-relaxed">
                {formatContent(content)}
              </pre>
            )
          )}
        </div>
      </div>
    </div>
  );
}
