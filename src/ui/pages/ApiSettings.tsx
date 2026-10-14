import { useState } from 'react';
import type { ApiSettings as Apis } from '../../core/types';
import { DEFAULT_APIS } from '../../core/wallet/defaults';
import { api } from '../lib/api';
import { back } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, Field, TopBar } from '../components/ui';
import { Icon } from '../components/Icon';

type Form = Required<Apis>;

const URL_FIELDS: { key: 'lifiUrl' | 'jupiterUrl' | 'pricesUrl'; label: string }[] = [
  { key: 'lifiUrl', label: 'LI.FI API URL' },
  { key: 'jupiterUrl', label: 'Jupiter API URL' },
  { key: 'pricesUrl', label: 'Prices API URL' },
];

export function ApiSettings() {
  const { state, refresh, toast } = useWallet();
  const [f, setF] = useState<Form>(() => {
    const a = state.settings.apis;
    return { ...a, lifiApiKey: a.lifiApiKey ?? '', jupiterApiKey: a.jupiterApiKey ?? '' };
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    const problems = URL_FIELDS.filter((u) => !/^https?:\/\/\S+$/.test(f[u.key].trim())).map(
      (u) => `${u.label} must be a full URL starting with https://`,
    );
    if (!f.lifiIntegrator.trim()) problems.push('Integrator name is required by LI.FI. Use "duo-wallet" if unsure.');
    setErrors(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      // Empty strings (not undefined) so cleared keys survive the JSON message to the background.
      await api.updateSettings({
        apis: {
          lifiUrl: f.lifiUrl.trim().replace(/\/$/, ''),
          lifiApiKey: f.lifiApiKey.trim(),
          lifiIntegrator: f.lifiIntegrator.trim(),
          jupiterUrl: f.jupiterUrl.trim().replace(/\/$/, ''),
          jupiterApiKey: f.jupiterApiKey.trim(),
          solanaSwapProvider: f.solanaSwapProvider,
          pricesUrl: f.pricesUrl.trim().replace(/\/$/, ''),
        },
      });
      await refresh();
      toast('Provider settings saved');
      back('/settings');
    } catch (e) {
      setErrors([(e as Error).message]);
      setSaving(false);
    }
  };

  return (
    <div className="screen">
      <TopBar title="Swap & data providers" />
      <form
        style={{ display: 'contents' }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="screen-body">
          <div className="stack">
            <h2 className="section" style={{ marginBottom: -6 }}>
              LI.FI
            </h2>
            <div className="small muted">Swaps on EVM networks and bridges between all networks.</div>
            <Field label="API URL" htmlFor="lifi-url">
              <input id="lifi-url" className="input" value={f.lifiUrl} onChange={(e) => set('lifiUrl', e.target.value)} />
            </Field>
            <Field label="API key" htmlFor="lifi-key" hint="Optional. Raises rate limits.">
              <SecretInput id="lifi-key" value={f.lifiApiKey} onChange={(v) => set('lifiApiKey', v)} />
            </Field>
            <Field label="Integrator" htmlFor="lifi-integrator" hint="Identifies this wallet to LI.FI.">
              <input id="lifi-integrator" className="input" value={f.lifiIntegrator} onChange={(e) => set('lifiIntegrator', e.target.value)} />
            </Field>

            <h2 className="section" style={{ marginBottom: -6 }}>
              Jupiter
            </h2>
            <div className="small muted">Swaps on Solana and Solana token info.</div>
            <Field label="API URL" htmlFor="jup-url">
              <input id="jup-url" className="input" value={f.jupiterUrl} onChange={(e) => set('jupiterUrl', e.target.value)} />
            </Field>
            <Field label="API key" htmlFor="jup-key" hint="Optional. Needed for api.jup.ag; lite-api.jup.ag works without one.">
              <SecretInput id="jup-key" value={f.jupiterApiKey} onChange={(v) => set('jupiterApiKey', v)} />
            </Field>
            <Field label="Solana swaps use">
              <div className="segmented" role="radiogroup" aria-label="Solana swap provider">
                {(['jupiter', 'lifi'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={f.solanaSwapProvider === p}
                    className={f.solanaSwapProvider === p ? 'active' : ''}
                    onClick={() => set('solanaSwapProvider', p)}
                  >
                    {p === 'jupiter' ? 'Jupiter' : 'LI.FI'}
                  </button>
                ))}
              </div>
            </Field>

            <h2 className="section" style={{ marginBottom: -6 }}>
              Prices
            </h2>
            <Field label="DefiLlama prices URL" htmlFor="prices-url" hint="Used for USD values of coins and tokens.">
              <input id="prices-url" className="input" value={f.pricesUrl} onChange={(e) => set('pricesUrl', e.target.value)} />
            </Field>

            {errors.length > 0 && (
              <div className="notice error" role="alert">
                {errors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}

            <div>
              <button
                type="button"
                className="link-btn small"
                onClick={() => {
                  // Keys are kept: they're the user's own and aren't part of the defaults.
                  setF((p) => ({ ...p, ...DEFAULT_APIS }));
                  setErrors([]);
                  toast('Defaults filled in. Save to apply them.');
                }}
              >
                Restore defaults
              </button>
              <div className="small muted">Resets the URLs, integrator and Solana swap provider. Your API keys are kept.</div>
            </div>
          </div>
        </div>
        <div className="screen-footer">
          <Button type="submit" loading={saving}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}

function SecretInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-group">
      <input
        id={id}
        className="input mono"
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="suffix">
        <button type="button" className="icon-btn" aria-label={shown ? 'Hide key' : 'Show key'} onClick={() => setShown((s) => !s)}>
          <Icon name={shown ? 'eyeOff' : 'eye'} size={16} />
        </button>
      </span>
    </div>
  );
}
