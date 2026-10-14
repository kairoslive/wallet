import { DEFAULT_NETWORKS } from '../networks';
import type { ApiSettings, Settings } from '../types';

export const DEFAULT_APIS: ApiSettings = {
  lifiUrl: 'https://li.quest',
  lifiIntegrator: 'duo-wallet',
  jupiterUrl: 'https://lite-api.jup.ag',
  solanaSwapProvider: 'jupiter',
  pricesUrl: 'https://coins.llama.fi',
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
