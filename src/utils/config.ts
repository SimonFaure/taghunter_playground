export interface AppConfig {
  usbPort: string;
  language: 'english' | 'french';
  email?: string;
  fullscreenOnLaunch?: boolean;
  autoLaunch?: boolean;
  onboardingCompleted?: boolean;
  billingUpToDate?: boolean;
  licenseType?: string;
  lastBillingSyncDate?: string;
  lastSuccessfulSync?: string;
}

const isElectron = () => {
  return typeof window !== 'undefined' && (window as any).electron?.isElectron;
};

export const loadConfig = async (): Promise<AppConfig> => {
  try {
    if (isElectron()) {
      console.log('[Config] Loading config from Electron...');
      const config = await (window as any).electron.config.load();
      console.log('[Config] Loaded config:', config);

      if (!config) {
        console.log('[Config] No config file found, returning default');
        return {
          usbPort: '',
          language: 'english',
          email: ''
        };
      }

      return config;
    } else {
      const response = await fetch('/data/config.json');
      if (!response.ok) {
        throw new Error('Failed to load config file');
      }
      return await response.json();
    }
  } catch (error) {
    console.error('[Config] Error loading config:', error);
    const defaultConfig = {
      usbPort: '',
      language: 'english',
      email: ''
    };
    console.log('[Config] Returning default config:', defaultConfig);
    return defaultConfig;
  }
};

export const saveConfig = async (config: AppConfig): Promise<void> => {
  try {
    console.log('[Config] Saving config:', config);
    if (isElectron()) {
      console.log('[Config] Using Electron save...');
      await (window as any).electron.config.save(config);
      console.log('[Config] Electron save completed');
    } else {
      const { supabase } = await import('../lib/db');
      if (!supabase) {
        throw new Error('Database not configured');
      }

      const updates = [
        supabase.from('configuration').upsert(
          { key: 'usb_port', value: config.usbPort, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        ),
        supabase.from('configuration').upsert(
          { key: 'language', value: config.language, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        )
      ];

      if (config.email !== undefined) {
        updates.push(
          supabase.from('configuration').upsert(
            { key: 'email', value: config.email, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
        );
      }

      if (config.fullscreenOnLaunch !== undefined) {
        updates.push(
          supabase.from('configuration').upsert(
            { key: 'fullscreen_on_launch', value: config.fullscreenOnLaunch.toString(), updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
        );
      }

      if (config.autoLaunch !== undefined) {
        updates.push(
          supabase.from('configuration').upsert(
            { key: 'auto_launch', value: config.autoLaunch.toString(), updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
        );
      }

      if (config.onboardingCompleted !== undefined) {
        updates.push(
          supabase.from('configuration').upsert(
            { key: 'onboarding_completed', value: config.onboardingCompleted.toString(), updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
        );
      }

      if (config.billingUpToDate !== undefined) {
        updates.push(
          supabase.from('configuration').upsert(
            { key: 'billing_up_to_date', value: config.billingUpToDate.toString(), updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
        );
      }

      if (config.licenseType !== undefined) {
        updates.push(
          supabase.from('configuration').upsert(
            { key: 'license_type', value: config.licenseType, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
        );
      }

      if (config.lastBillingSyncDate !== undefined) {
        updates.push(
          supabase.from('configuration').upsert(
            { key: 'last_billing_sync_date', value: config.lastBillingSyncDate, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
        );
      }

      if (config.lastSuccessfulSync !== undefined) {
        updates.push(
          supabase.from('configuration').upsert(
            { key: 'last_successful_sync', value: config.lastSuccessfulSync, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          )
        );
      }

      await Promise.all(updates);
    }
  } catch (error) {
    console.error('Error saving config:', error);
    throw error;
  }
};
