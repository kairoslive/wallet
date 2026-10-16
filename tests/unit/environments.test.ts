import { describe, expect, it } from 'vitest';
import { KAIROS_ENVIRONMENTS, kairosEnvironment } from '../../src/core/predictions/environments';
import { DEFAULT_APIS } from '../../src/core/wallet/defaults';

describe('kairosEnvironment', () => {
  it('recognizes the presets, ignoring case and trailing slashes', () => {
    expect(kairosEnvironment(DEFAULT_APIS)).toBe('staging');
    expect(kairosEnvironment(KAIROS_ENVIRONMENTS.production)).toBe('production');
    expect(kairosEnvironment({ ...KAIROS_ENVIRONMENTS.production, kairosExecutionUrl: 'https://Execution.kairos.trade/' })).toBe(
      'production',
    );
  });

  it('calls a mix of hosts custom', () => {
    expect(
      kairosEnvironment({ ...KAIROS_ENVIRONMENTS.staging, kairosDataUrl: KAIROS_ENVIRONMENTS.production.kairosDataUrl }),
    ).toBe('custom');
  });

  it('keeps the partner id out of the presets', () => {
    for (const preset of Object.values(KAIROS_ENVIRONMENTS)) expect(preset).not.toHaveProperty('kairosPartnerId');
  });
});
