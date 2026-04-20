import { logApiCall } from '../services/apiLogger';

export async function checkInternetConnection(): Promise<boolean> {
  const startTime = Date.now();

  try {
    const hasWifi = await window.electron.checkWifi();
    const duration = Date.now() - startTime;

    await logApiCall({
      endpoint: 'connectivity-check',
      method: 'GET',
      statusCode: hasWifi ? 200 : 0,
      duration,
      success: hasWifi,
      errorMessage: hasWifi ? undefined : 'No internet connection detected',
    });

    return hasWifi;
  } catch (error) {
    const duration = Date.now() - startTime;

    await logApiCall({
      endpoint: 'connectivity-check',
      method: 'GET',
      statusCode: 0,
      duration,
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });

    return false;
  }
}
