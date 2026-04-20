let cachedGameTypes: string[] | null = null;

export async function getGameTypesFromScenarios(): Promise<string[]> {
  if (cachedGameTypes !== null) {
    return cachedGameTypes;
  }

  try {
    const data = await window.electron.scenarios.load();
    const gameTypesSet = new Set<string>();

    for (const scenario of data.scenarios) {
      if (scenario.game_type && typeof scenario.game_type === 'string') {
        gameTypesSet.add(scenario.game_type);
      }
    }

    cachedGameTypes = Array.from(gameTypesSet);
    return cachedGameTypes;
  } catch (error) {
    console.error('Error loading game types from scenarios:', error);
    return [];
  }
}

export function clearGameTypesCache(): void {
  cachedGameTypes = null;
}
