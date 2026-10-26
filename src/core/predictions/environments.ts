import type { ApiSettings } from '../types';

export type KairosEnvironment = 'staging' | 'production';

type EnvUrls = Pick<ApiSettings, 'kairosExecutionUrl' | 'kairosDataUrl' | 'kairosMarketDataUrl' | 'kairosStreamUrl'>;

/** Kairos endpoint presets. The partner id is left alone: it's issued per partner, not per environment. */
export const KAIROS_ENVIRONMENTS: Record<KairosEnvironment, EnvUrls> = {
  staging: {
    kairosExecutionUrl: 'https://staging-execution.kairos.trade',
    kairosDataUrl: 'https://staging-data.kairos.trade',
    kairosMarketDataUrl: 'https://staging-md.kairos.trade',
    kairosStreamUrl: 'wss://staging-stream.kairos.trade',
  },
  production: {
    kairosExecutionUrl: 'https://execution.kairos.trade',
    kairosDataUrl: 'https://data.kairos.trade',
    kairosMarketDataUrl: 'https://md.kairos.trade',
    kairosStreamUrl: 'wss://stream.kairos.trade',
  },
};

const norm = (u: string) => u.trim().replace(/\/$/, '').toLowerCase();

/** Which preset the settings match, or 'custom' when any Kairos URL was edited by hand. */
export function kairosEnvironment(apis: EnvUrls): KairosEnvironment | 'custom' {
  for (const env of ['staging', 'production'] as const) {
    const preset = KAIROS_ENVIRONMENTS[env];
    if ((Object.keys(preset) as (keyof EnvUrls)[]).every((k) => norm(apis[k]) === norm(preset[k]))) return env;
  }
  return 'custom';
}
