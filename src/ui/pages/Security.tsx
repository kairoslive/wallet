import { useState } from 'react';
import type { SeedMeta } from '../../core/types';
import { api } from '../lib/api';
import { useWallet } from '../lib/store';
import { Button, ErrorNote, Field, TopBar } from '../components/ui';
import { PasswordSheet } from '../components/pickers';
import { RevealPhraseSheet } from '../components/sheets';
import { Icon } from '../components/Icon';

export function Security() {
  const { state } = useWallet();
  const [reveal, setReveal] = useState<SeedMeta>();
  const [resetting, setResetting] = useState(false);
  const hasImported = state.accounts.some((a) => a.kind === 'privateKey');

  return (
    <div className="screen">
      <TopBar title="Security & recovery" />
      <div className="screen-body">
        <ChangePassword />

        <h2 className="section">Recovery phrases</h2>
        {state.seeds.length === 0 && <div className="small muted">This wallet has no recovery phrases, only imported keys.</div>}
        <div className="list">
          {state.seeds.map((s) => {
            const count = state.accounts.filter((a) => a.seedId === s.id).length;
            return (
              <button key={s.id} className="list-item" onClick={() => setReveal(s)}>
                <Icon name="key" />
                <div className="main">
                  <div className="title row" style={{ gap: 6 }}>
                    <span className="ellipsis">{s.name}</span>
                    {!s.backedUp && (
                      <span className="tag" style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}>
                        Not backed up
                      </span>
                    )}
                  </div>
                  <div className="sub">
                    {count} account{count === 1 ? '' : 's'} · Show recovery phrase
                  </div>
                </div>
                <Icon name="chevronRight" size={16} />
              </button>
            );
          })}
        </div>
        {hasImported && (
          <div className="small muted">To back up an imported account, open it from Accounts and show its private key.</div>
        )}

        <h2 className="section">Reset wallet</h2>
        <div className="stack" style={{ gap: 10 }}>
          <div className="small ink2">
            Deletes all accounts, keys and settings from this browser. Your funds stay on-chain, but you'll need your recovery
            phrases and private keys to get them back.
          </div>
          <Button variant="danger" block icon="trash" onClick={() => setResetting(true)}>
            Reset wallet
          </Button>
        </div>
      </div>

      {reveal && <RevealPhraseSheet seed={reveal} onClose={() => setReveal(undefined)} />}
      {resetting && <ResetSheet onClose={() => setResetting(false)} />}
    </div>
  );
}

function ChangePassword() {
  const { toast } = useWallet();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && confirm !== next;

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (next.length < 8 || next !== confirm) return;
        setBusy(true);
        setError(undefined);
        try {
          await api.changePassword(current, next);
          setCurrent('');
          setNext('');
          setConfirm('');
          toast('Password changed');
        } catch (err) {
          const msg = (err as Error).message;
          setError(msg === 'Incorrect password' ? 'Current password is incorrect. Try again.' : msg);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="section" style={{ marginBottom: -6 }}>
        Change password
      </h2>
      <Field label="Current password" htmlFor="pw-current">
        <input
          id="pw-current"
          className="input"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field
        label="New password"
        htmlFor="pw-new"
        error={tooShort ? 'Use at least 8 characters.' : undefined}
        hint="At least 8 characters."
      >
        <input
          id="pw-new"
          className="input"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <Field label="Confirm new password" htmlFor="pw-confirm-new" error={mismatch ? "Passwords don't match." : undefined}>
        <input
          id="pw-confirm-new"
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <Button type="submit" variant="secondary" block loading={busy} disabled={!current || next.length < 8 || next !== confirm}>
        Change password
      </Button>
    </form>
  );
}

function ResetSheet({ onClose }: { onClose: () => void }) {
  const { state, refresh } = useWallet();
  const unbacked = state.seeds.filter((s) => !s.backedUp);
  return (
    <PasswordSheet
      title="Reset wallet?"
      confirmLabel="Reset wallet"
      danger
      onClose={onClose}
      onSubmit={async (pw) => {
        await api.verifyPassword(pw);
        await api.resetWallet();
        // App sends us to onboarding once the state reports no wallet.
        await refresh();
      }}
    >
      <div className="notice error">
        This permanently deletes every account and key in this browser. It can't be undone.
        {unbacked.length > 0 &&
          ` ${unbacked.map((s) => s.name).join(', ')} ${unbacked.length === 1 ? "hasn't" : "haven't"} been backed up.`}
      </div>
      <label className="row small" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
        <input type="checkbox" required style={{ marginTop: 2 }} />
        <span>I have my recovery phrases and private keys saved, or I don't need these accounts.</span>
      </label>
    </PasswordSheet>
  );
}
