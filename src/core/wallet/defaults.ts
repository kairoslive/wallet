import { DEFAULT_NETWORKS } from '../networks';
import { KAIROS_ENVIRONMENTS } from '../predictions/environments';
import type { ApiSettings, Settings } from '../types';

export const DEFAULT_APIS: ApiSettings = {
  lifiUrl: 'https://li.quest',
  lifiIntegrator: 'duo-wallet',
  jupiterUrl: 'https://lite-api.jup.ag',
  solanaSwapProvider: 'jupiter',
  pricesUrl: 'https://coins.llama.fi',
  // Production by default; staging is under Settings → Swap & data providers → Environment.
  kairosEnabled: true,
  ...KAIROS_ENVIRONMENTS.production,
  kairosPartnerId: 'wallet-pilot',
  hallidayUrl: 'https://v2.prod.halliday.xyz',
  // Publishable key (pk_), intended for client-side use.
  hallidayApiKey: 'pk_02f60f87-9dba-44a0-9d27-0b8412dab142',
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
