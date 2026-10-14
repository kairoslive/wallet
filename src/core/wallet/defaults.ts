import { DEFAULT_NETWORKS } from '../networks';
import type { ApiSettings, Settings } from '../types';

export const DEFAULT_APIS: ApiSettings = {
  lifiUrl: 'https://li.quest',
  lifiIntegrator: 'duo-wallet',
  jupiterUrl: 'https://lite-api.jup.ag',
  solanaSwapProvider: 'jupiter',
  pricesUrl: 'https://coins.llama.fi',
  // Staging for the pilot; production is execution/data/md.kairos.trade with a production partner id.
  kairosEnabled: true,
  kairosExecutionUrl: 'https://staging-execution.kairos.trade',
  kairosDataUrl: 'https://staging-data.kairos.trade',
  kairosMarketDataUrl: 'https://staging-md.kairos.trade',
  kairosPartnerId: 'wallet-pilot',
};

export function defaultSettings(): Settings {
  return {
    networks: structuredClone(DEFAULT_NETWORKS),
    selectedNetworkId: 'all',
    autoLockMinutes: 15,
    showTestnets: false,
    slippageBps: 50,
    apis: { ...DEFAULT_APIS },
    hideZeroBalances: false,
  };
}
