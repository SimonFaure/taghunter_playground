import { logApiCall } from './apiLogger';

export interface BillingStatus {
  billing_up_to_date: boolean;
  license_type: string;
}

export interface CardsVersion {
  version: number;
}

export interface Pattern {
  slug: string;
  version: number;
  type: 'default' | 'user';
  download_url: string;
  name: string;
  game_type?: string;
}

export interface Layout {
  id?: number;
  game_type: string;
  version: number | string;
  download_url?: string;
}

export interface PatternsResponse {
  patterns: Pattern[];
}

export interface LayoutsResponse {
  layouts: Layout[];
}

export interface ScenarioInfo {
  name: string;
  slug: string;
  uniqid: string;
  version: string;
  game_type: string;
}

export interface PatternInfo {
  name: string;
  game_type: string;
  version: string;
  uniqid: string;
}

export interface UserDataUpdate {
  custom_scenarios: ScenarioInfo[];
  product_scenarios: ScenarioInfo[];
  default_patterns: PatternInfo[];
  custom_patterns: PatternInfo[];
  cards_version: number;
  has_on_demand_cards: boolean;
  layouts: Layout[];
  billing_up_to_date: boolean;
  license_type: string;
}

export async function getBillingStatus(apiUrl: string, email: string): Promise<BillingStatus> {
  const url = `${apiUrl}?action=get_billing_status&email=${encodeURIComponent(email)}`;
  const startTime = Date.now();

  try {
    const response = await fetch(url);
    const duration = Date.now() - startTime;

    if (!response.ok) {
      await logApiCall({
        endpoint: url,
        method: 'GET',
        statusCode: response.status,
        requestParams: { action: 'get_billing_status', email },
        errorMessage: `HTTP ${response.status}: ${response.statusText}`,
      });
      throw new Error(`Failed to fetch billing status: ${response.statusText}`);
    }

    const data = await response.json();

    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: response.status,
      requestParams: { action: 'get_billing_status', email },
      responseData: data,
    });

    return data;
  } catch (error) {
    const duration = Date.now() - startTime;
    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: 0,
      requestParams: { action: 'get_billing_status', email },
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function getCardsVersion(apiUrl: string, email: string): Promise<CardsVersion> {
  const url = `${apiUrl}?action=get_cards_version&email=${encodeURIComponent(email)}`;
  const startTime = Date.now();

  try {
    const response = await fetch(url);
    const duration = Date.now() - startTime;

    if (!response.ok) {
      await logApiCall({
        endpoint: url,
        method: 'GET',
        statusCode: response.status,
        requestParams: { action: 'get_cards_version', email },
        errorMessage: `HTTP ${response.status}: ${response.statusText}`,
      });
      throw new Error(`Failed to fetch cards version: ${response.statusText}`);
    }

    const data = await response.json();

    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: response.status,
      requestParams: { action: 'get_cards_version', email },
      responseData: data,
    });

    return data;
  } catch (error) {
    const duration = Date.now() - startTime;
    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: 0,
      requestParams: { action: 'get_cards_version', email },
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function getPatterns(apiUrl: string, email: string): Promise<PatternsResponse> {
  const url = `${apiUrl}?action=get_patterns&email=${encodeURIComponent(email)}`;
  const startTime = Date.now();

  console.log(`[ResourceSync] Fetching patterns`);
  console.log(`[ResourceSync] URL: ${url}`);

  try {
    const response = await fetch(url);
    const duration = Date.now() - startTime;

    if (!response.ok) {
      console.error(`[ResourceSync] Failed to fetch patterns: ${response.status} ${response.statusText}`);
      await logApiCall({
        endpoint: url,
        method: 'GET',
        statusCode: response.status,
        requestParams: { action: 'get_patterns', email },
        errorMessage: `HTTP ${response.status}: ${response.statusText}`,
      });
      throw new Error(`Failed to fetch patterns: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`[ResourceSync] Patterns response:`, data);
    console.log(`[ResourceSync] Found ${data.patterns?.length || 0} patterns`);

    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: response.status,
      requestParams: { action: 'get_patterns', email },
      responseData: data,
    });

    return data;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[ResourceSync] Error fetching patterns:`, error);
    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: 0,
      requestParams: { action: 'get_patterns', email },
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function getLayouts(apiUrl: string, email: string): Promise<LayoutsResponse> {
  const url = `${apiUrl}?action=get_layouts&email=${encodeURIComponent(email)}`;
  const startTime = Date.now();

  console.log(`[ResourceSync] Fetching layouts`);
  console.log(`[ResourceSync] URL: ${url}`);

  try {
    const response = await fetch(url);
    const duration = Date.now() - startTime;

    if (!response.ok) {
      console.error(`[ResourceSync] Failed to fetch layouts: ${response.status} ${response.statusText}`);
      await logApiCall({
        endpoint: url,
        method: 'GET',
        statusCode: response.status,
        requestParams: { action: 'get_layouts', email },
        errorMessage: `HTTP ${response.status}: ${response.statusText}`,
      });
      throw new Error(`Failed to fetch layouts: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`[ResourceSync] Layouts response:`, data);
    console.log(`[ResourceSync] Found ${data.layouts?.length || 0} layouts`);

    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: response.status,
      requestParams: { action: 'get_layouts', email },
      responseData: data,
    });

    return data;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[ResourceSync] Error fetching layouts:`, error);
    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: 0,
      requestParams: { action: 'get_layouts', email },
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function downloadCardsFile(apiUrl: string, email: string, version: number): Promise<string> {
  const url = `${apiUrl}?action=download_cards&email=${encodeURIComponent(email)}&version=${version}`;
  const startTime = Date.now();

  console.log(`[ResourceSync] Downloading cards file v${version}`);
  console.log(`[ResourceSync] URL: ${url}`);

  try {
    const response = await fetch(url);
    const duration = Date.now() - startTime;

    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: response.status,
      requestParams: { action: 'download_cards', email, version },
      duration,
      success: response.ok,
    });

    if (!response.ok) {
      throw new Error(`Failed to download cards file: ${response.statusText}`);
    }

    const content = await response.text();
    console.log(`[ResourceSync] Cards file downloaded successfully, size: ${content.length} bytes`);
    return content;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[ResourceSync] Error downloading cards file:`, error);
    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: 0,
      requestParams: { action: 'download_cards', email, version },
      duration,
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function downloadOnDemandCards(apiUrl: string, email: string): Promise<string> {
  const url = `${apiUrl}?action=get_on_demand_cards&email=${encodeURIComponent(email)}`;
  const startTime = Date.now();

  console.log(`[ResourceSync] Downloading on-demand cards`);
  console.log(`[ResourceSync] URL: ${url}`);

  try {
    const response = await fetch(url);
    const duration = Date.now() - startTime;

    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: response.status,
      requestParams: { action: 'get_on_demand_cards', email },
      duration,
      success: response.ok,
    });

    if (!response.ok) {
      throw new Error(`Failed to download on-demand cards: ${response.statusText}`);
    }

    const content = await response.text();
    console.log(`[ResourceSync] On-demand cards downloaded successfully, size: ${content.length} bytes`);
    return content;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[ResourceSync] Error downloading on-demand cards:`, error);
    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: 0,
      requestParams: { action: 'get_on_demand_cards', email },
      duration,
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function downloadPattern(apiUrl: string, email: string, patternUniqid: string): Promise<string> {
  const url = `${apiUrl}?action=download_pattern&email=${encodeURIComponent(email)}&pattern_uniqid=${patternUniqid}`;
  const startTime = Date.now();

  console.log(`[ResourceSync] Downloading pattern: ${patternUniqid}`);
  console.log(`[ResourceSync] URL: ${url}`);

  try {
    const response = await fetch(url);
    const duration = Date.now() - startTime;

    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: response.status,
      requestParams: { action: 'download_pattern', email, pattern_uniqid: patternUniqid },
      duration,
      success: response.ok,
    });

    if (!response.ok) {
      throw new Error(`Failed to download pattern: ${response.statusText}`);
    }

    const content = await response.text();
    console.log(`[ResourceSync] Pattern downloaded successfully, size: ${content.length} bytes`);
    return content;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[ResourceSync] Error downloading pattern:`, error);
    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: 0,
      requestParams: { action: 'download_pattern', email, pattern_uniqid: patternUniqid },
      duration,
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function downloadLayout(apiUrl: string, email: string, layoutId: number): Promise<string> {
  const url = `${apiUrl}?action=download_layout&email=${encodeURIComponent(email)}&layout_id=${layoutId}`;
  const startTime = Date.now();

  console.log(`[ResourceSync] Downloading layout ID: ${layoutId}`);
  console.log(`[ResourceSync] URL: ${url}`);

  try {
    const response = await fetch(url);
    const duration = Date.now() - startTime;

    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: response.status,
      requestParams: { action: 'download_layout', email, layout_id: layoutId },
      duration,
      success: response.ok,
    });

    if (!response.ok) {
      throw new Error(`Failed to download layout: ${response.statusText}`);
    }

    const content = await response.text();
    console.log(`[ResourceSync] Layout downloaded successfully, size: ${content.length} bytes`);
    return content;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[ResourceSync] Error downloading layout:`, error);
    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: 0,
      requestParams: { action: 'download_layout', email, layout_id: layoutId },
      duration,
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function getUserDataUpdate(apiUrl: string, email: string): Promise<UserDataUpdate> {
  const url = `${apiUrl}?action=get_user_data_update&email=${encodeURIComponent(email)}`;
  const startTime = Date.now();

  console.log('[ResourceSync] Fetching user data update');
  console.log('[ResourceSync] URL:', url);

  try {
    const response = await fetch(url);
    const duration = Date.now() - startTime;

    if (!response.ok) {
      console.error(`[ResourceSync] Failed to fetch user data update: ${response.status} ${response.statusText}`);
      await logApiCall({
        endpoint: url,
        method: 'GET',
        statusCode: response.status,
        requestParams: { action: 'get_user_data_update', email },
        errorMessage: `HTTP ${response.status}: ${response.statusText}`,
        duration,
      });
      throw new Error(`Failed to fetch user data update: ${response.statusText}`);
    }

    const rawData = await response.json();
    console.log('[ResourceSync] User data update response:', {
      billingUpToDate: rawData.billing_up_to_date,
      licenseType: rawData.license_type,
      customScenarios: rawData.custom_scenarios?.length || 0,
      productScenarios: rawData.product_scenarios?.length || 0,
      defaultPatterns: rawData.default_patterns?.length || 0,
      customPatterns: rawData.custom_patterns?.length || 0,
      cardsVersion: rawData.cards_version,
      layouts: rawData.layouts?.length || 0,
    });

    const transformScenario = (scenario: any): ScenarioInfo => ({
      name: scenario.title || scenario.name,
      slug: scenario.slug,
      uniqid: scenario.uniqid,
      version: scenario.version,
      game_type: scenario.game_type,
    });

    const transformPattern = (pattern: any): PatternInfo => {
      // API returns pattern_uniqid field, not uniqid
      const patternUniqid = pattern.pattern_uniqid || pattern.uniqid || '';
      if (!patternUniqid) {
        console.warn('[ResourceSync] Pattern missing pattern_uniqid:', pattern);
      }
      return {
        name: pattern.name,
        game_type: pattern.game_type,
        version: pattern.version,
        uniqid: patternUniqid,
      };
    };

    const data: UserDataUpdate = {
      custom_scenarios: (rawData.custom_scenarios || []).map(transformScenario),
      product_scenarios: (rawData.product_scenarios || []).map(transformScenario),
      default_patterns: (rawData.default_patterns || []).map(transformPattern),
      custom_patterns: (rawData.custom_patterns || []).map(transformPattern),
      cards_version: rawData.cards_version,
      has_on_demand_cards: rawData.has_on_demand_cards,
      layouts: rawData.layouts || [],
      billing_up_to_date: rawData.billing_up_to_date,
      license_type: rawData.license_type,
    };

    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: response.status,
      requestParams: { action: 'get_user_data_update', email },
      responseData: rawData,
      duration,
    });

    return data;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('[ResourceSync] Error fetching user data update:', error);
    await logApiCall({
      endpoint: url,
      method: 'GET',
      statusCode: 0,
      requestParams: { action: 'get_user_data_update', email },
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      duration,
    });
    throw error;
  }
}
