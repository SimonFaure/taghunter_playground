import { createClient } from '@supabase/supabase-js';
import gamesData from '../../data/games.json';
import { createDbAdapter } from './db-adapter';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

console.log('🔧 Database initialization:', {
  hasUrl: !!supabaseUrl,
  hasKey: !!supabaseKey,
  url: supabaseUrl ? `${supabaseUrl.substring(0, 30)}...` : 'missing',
  isElectron: typeof window !== 'undefined' && (window as any).electron?.isElectron
});

let supabaseClient: any = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabaseClient = createClient(supabaseUrl, supabaseKey);
    console.log('✓ Supabase client created successfully');
  } catch (error) {
    console.error('✗ Failed to create Supabase client:', error);
  }
} else {
  console.warn('⚠ Supabase credentials missing - will use MySQL in Electron or fail in browser');
}

export const supabase = createDbAdapter(supabaseClient);

export const db = {
  getGameTypes: async () => {
    return gamesData.game_types;
  },
  getScenarios: async (gameTypeId?: string) => {
    if (gameTypeId) {
      return gamesData.scenarios.filter(s => s.game_type_id === gameTypeId);
    }
    return gamesData.scenarios;
  },
};
