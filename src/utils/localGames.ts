import * as scenarioStore from '../services/scenarioStore';

// Returns the uniqids of scenarios fully downloaded to the local SQLite/FS
// store — i.e. those with `scenarios.local_version IS NOT NULL`.
export async function getLocalGameIds(): Promise<string[]> {
  try {
    const rows = await scenarioStore.list({ downloaded: true });
    return rows.map((r) => r.uniqid);
  } catch (error) {
    console.error('[localGames] failed to read scenarioStore:', error);
    return [];
  }
}
