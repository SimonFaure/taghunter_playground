export type DownloadItemType = 'cards' | 'on_demand_cards' | 'pattern' | 'layout' | 'scenario';

export interface DownloadItem {
  type: DownloadItemType;
  name: string;
  version: number;
  gameType?: string;
  uniqid?: string;
  patternUniqid?: string;
  layoutId?: number;
  priority: number;
  downloadUrl: string;
  targetPath: string;
}

export interface DownloadProgress {
  current: number;
  total: number;
  currentItem: DownloadItem | null;
}
