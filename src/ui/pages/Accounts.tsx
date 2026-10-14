import { useState } from 'react';
import type { Account, SeedMeta } from '../../core/types';
import { shortAddress } from '../../core/format';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useWallet } from '../lib/store';
import { Avatar, Button, ErrorNote, Field, Sheet, TopBar } from '../components/ui';
import { ConfirmSheet, RevealPhraseSheet } from '../components/sheets';
import { Icon } from '../components/Icon';

type SeedSheet = { seed: SeedMeta; mode: 'menu' | 'rename' | 'reveal' | 'remove' };

export function Accounts() {
  const { state } = useWallet();
  const [sheet, setSheet] = useState<SeedSheet>();
  const imported = state.accounts.filter((a) => a.kind === 'privateKey');

  return (
    <div className="screen">
      <TopBar title="Accounts" />
      <div className="screen-body">
        {state.seeds.map((seed) => (
          <SeedGroup
            key={seed.id}
            seed={seed}
            accounts={state.accounts.filter((a) => a.seedId === seed.id)}
            onManage={(mode) => setSheet({ seed, mode })}
          />
        ))}
        {imported.length > 0 && (
          <div>
            <h2 className="section">Imported</h2>
            <AccountRows accounts={imported} />
          </div>
        )}
      </div>
      <div className="screen-footer">
        <Button icon="plus" onClick={() => navigate('/accounts/add')}>
          Add or import
        </Button>
      </div>
      {sheet && <SeedSheets sheet={sheet} setSheet={setSheet} />}
    </div>
  );
}

function SeedGroup({
  seed,
  accounts,
  onManage,
}: {
  seed: SeedMeta;
  accounts: Account[];
  onManage: (mode: SeedSheet['mode']) => void;
}) {
  const { refresh, toast } = useWallet();
  const [adding, setAdding] = useState(false);
  const add = async () => {
    setAdding(true);
    try {
      const a = await api.addAccount({ seedId: seed.id });
      await refresh();
      toast(`${a.name} added`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setAdding(false);
    }
  };
  return (
    <div>
      <div className="row" style={{ gap: 6, margin: '12px 0 2px' }}>
        <h2 className="section ellipsis" style={{ margin: 0 }}>
          {seed.name}
        </h2>
        {!seed.backedUp && (
          <span className="tag" style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}>
            Not backed up
          </span>
        )}
        <div className="spacer" />
        <button className="icon-btn" aria-label={`Manage ${seed.name}`} title="Manage wallet" onClick={() => onManage('menu')}>
          <Icon name="edit" size={16} />
        </button>
      </div>
      {!seed.backedUp && (
        <div className="notice" style={{ marginBottom: 4 }}>
          Back up this recovery phrase so you can restore these accounts if you lose this device.{' '}
          <button className="link-btn" onClick={() => onManage('reveal')}>
            Back up now
          </button>
        </div>
      )}
      <AccountRows accounts={accounts} />
      <button className="link-btn small" style={{ padding: '4px 0' }} onClick={add} disabled={adding}>
        {adding ? 'Adding…' : `Add account to ${seed.name}`}
      </button>
    </div>
  );
}

function AccountRows({ accounts }: { accounts: Account[] }) {
  const { state } = useWallet();
  return (
    <div className="list">
      {accounts.map((a) => (
        <button
          key={a.id}
          className="list-item"
          style={a.hidden ? { opacity: 0.55 } : undefined}
          onClick={() => navigate('/account', { id: a.id })}
        >
          <Avatar seed={a.evmAddress ?? a.solanaAddress ?? a.id} />
          <div className="main">
            <div className="title row" style={{ gap: 6 }}>
              <span className="ellipsis">{a.name}</span>
              {a.hidden && <span className="tag">Hidden</span>}
              {a.id === state.selectedAccountId && <span className="tag">Active</span>}
            </div>
            <div className="sub">
              {[a.evmAddress && shortAddress(a.evmAddress), a.solanaAddress && shortAddress(a.solanaAddress)]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          <Icon name="chevronRight" size={16} />
        </button>
      ))}
    </div>
  );
}

function SeedSheets({ sheet, setSheet }: { sheet: SeedSheet; setSheet: (s?: SeedSheet) => void }) {
  const { state, refresh, toast } = useWallet();
  const { seed } = sheet;
  const close = () => setSheet(undefined);
  const count = state.accounts.filter((a) => a.seedId === seed.id).length;

  if (sheet.mode === 'reveal') return <RevealPhraseSheet seed={seed} onClose={close} />;
  if (sheet.mode === 'rename') return <RenameSeedSheet seed={seed} onClose={close} />;
  if (sheet.mode === 'remove') {
    return (
      <ConfirmSheet
        title={`Remove ${seed.name}?`}
        confirmLabel="Remove wallet"
        onClose={close}
        onConfirm={async () => {
          await api.removeSeed(seed.id);
          await refresh();
          toast(`${seed.name} removed`);
          close();
        }}
      >
        <p style={{ margin: 0 }}>
          This removes the recovery phrase and its {count === 1 ? 'account' : `${count} accounts`} from this device. Funds stay
          on-chain, but you can only get these accounts back by importing the recovery phrase again.
        </p>
        {!seed.backedUp && (
          <div className="notice error">
            You haven't backed up this recovery phrase. If you remove it now, these accounts are lost for good.
          </div>
        )}
      </ConfirmSheet>
    );
  }
  return (
    <Sheet title={seed.name} onClose={close}>
      <div className="list">
        <button className="list-item" onClick={() => setSheet({ seed, mode: 'rename' })}>
          <Icon name="edit" />
          <div className="main title">Rename wallet</div>
        </button>
        <button className="list-item" onClick={() => setSheet({ seed, mode: 'reveal' })}>
          <Icon name="key" />
          <div className="main">
            <div className="title">Show recovery phrase</div>
            {!seed.backedUp && <div className="sub">Not backed up yet</div>}
          </div>
        </button>
        <button className="list-item" style={{ color: 'var(--neg)' }} onClick={() => setSheet({ seed, mode: 'remove' })}>
          <Icon name="trash" />
          <div className="main title">Remove wallet</div>
        </button>
      </div>
    </Sheet>
  );
}

function RenameSeedSheet({ seed, onClose }: { seed: SeedMeta; onClose: () => void }) {
  const { refresh, toast } = useWallet();
  const [name, setName] = useState(seed.name);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="Rename wallet" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await api.renameSeed(seed.id, name);
            await refresh();
            toast('Wallet renamed');
            onClose();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <Field label="Name" htmlFor="seed-name">
          <input
            id="seed-name"
            className="input"
            autoFocus
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" block loading={busy} disabled={!name.trim()}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}
