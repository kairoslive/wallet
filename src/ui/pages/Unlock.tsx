import { useState } from 'react';
import { api } from '../lib/api';
import { useMaybeWallet } from '../lib/store';
import { Button, Field } from '../components/ui';
import { WalletMark } from './Onboarding';

export function Unlock({ onUnlocked, subtitle }: { onUnlocked?: () => void; subtitle?: string }) {
  const { refresh } = useMaybeWallet();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.unlock(password);
      await refresh();
      onUnlocked?.();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <form className="screen-body stack" style={{ justifyContent: 'center', paddingTop: 0 }} onSubmit={submit}>
        <div className="center stack" style={{ alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <WalletMark size={64} />
          <h1 style={{ margin: 0, fontSize: 24, letterSpacing: '-0.02em' }}>Welcome back</h1>
          <div className="muted">{subtitle ?? 'Enter your password to unlock'}</div>
        </div>
        <Field error={error} htmlFor="unlock-password">
          <input
            id="unlock-password"
            className={`input ${error ? 'invalid' : ''}`}
            type="password"
            placeholder="Password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" block loading={busy} disabled={!password}>
          Unlock
        </Button>
      </form>
    </div>
  );
}
