import { DownloadItem, DownloadItemType } from '../types/downloadQueue';

export class DownloadQueueManager {
  private queue: DownloadItem[] = [];

  addItem(item: DownloadItem): void {
    this.queue.push(item);
  }

  addItems(items: DownloadItem[]): void {
    this.queue.push(...items);
  }

  getQueue(): DownloadItem[] {
    return this.deduplicateAndPrioritize([...this.queue]);
  }

  clear(): void {
    this.queue = [];
  }

  getCount(): number {
    return this.deduplicateAndPrioritize(this.queue).length;
  }

  private deduplicateAndPrioritize(items: DownloadItem[]): DownloadItem[] {
    const uniqueMap = new Map<string, DownloadItem>();

    for (const item of items) {
      const key = this.getItemKey(item);
      const existing = uniqueMap.get(key);

      if (!existing || item.version > existing.version) {
        uniqueMap.set(key, item);
      }
    }

    const uniqueItems = Array.from(uniqueMap.values());

    uniqueItems.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return (a.name || '').localeCompare(b.name || '');
    });

    return uniqueItems;
  }

  private getItemKey(item: DownloadItem): string {
    if (item.type === 'cards') {
      return `cards`;
    }
    if (item.type === 'pattern') {
      return `pattern_${item.gameType}_${item.name}`;
    }
    if (item.type === 'layout') {
      return `layout_${item.gameType}`;
    }
    if (item.type === 'scenario') {
      return `scenario_${item.uniqid || item.name}`;
    }
    return `${item.type}_${item.name}`;
  }
}

export function getPriorityForType(type: DownloadItemType): number {
  const priorityMap: Record<DownloadItemType, number> = {
    cards: 1,
    pattern: 2,
    layout: 3,
    scenario: 4,
  };
  return priorityMap[type] || 99;
}
