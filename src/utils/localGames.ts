import { supabase } from '../lib/db';

export async function getLocalGameIds(): Promise<string[]> {
  const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

  if (!isElectron) {
    try {
      const { data: folders, error } = await supabase.storage
        .from('resources')
        .list('scenarios', { limit: 1000 });

      if (error) {
        console.error('Error fetching scenarios from storage:', error);
        return [];
      }

      const gameIds = folders?.map(f => f.name).filter(Boolean) || [];
      console.log('Browser storage games found:', gameIds);
      return gameIds;
    } catch (error) {
      console.error('Error reading games from Supabase storage:', error);
      return [];
    }
  }

  try {
    const localGameIds = await (window as any).electron.games.list();
    console.log('Local game folders found:', localGameIds);
    return localGameIds;
  } catch (error) {
    console.error('Error reading local games:', error);
    return [];
  }
}
