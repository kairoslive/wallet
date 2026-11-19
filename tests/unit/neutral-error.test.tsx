import { expect, it } from 'vitest';
import { neutralError } from '../../src/ui/components/ui';

it('never names an exchange in an error shown to the user', () => {
  expect(neutralError('combos-rfq-api.polymarket.com returned HTTP 503')).toBe('the market service returned HTTP 503');
  expect(neutralError('the wallet has no Polymarket deposit wallet yet; run wallet.setup first')).toBe(
    'Set up prediction trading first.',
  );
  expect(neutralError('Predict.fun rejected the order')).toBe('the exchange rejected the order');
  expect(neutralError('Insufficient balance')).toBe('Insufficient balance');
});
