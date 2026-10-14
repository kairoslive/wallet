import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ChainType } from '../../core/types';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, CopyButton, ErrorNote, Field, Spinner, TopBar } from '../components/ui';
import { PhraseGrid } from '../components/sheets';
import { Icon, type IconName } from '../components/Icon';

type Mode = 'derive' | 'create' | 'import' | 'key';

const TITLES: Record<Mode, string> = {
  derive: 'New account',
  create: 'New recovery phrase',
  import: 'Import recovery phrase',
  key: 'Import private key',
};

export function AddAccount() {
  const { state } = useWallet();
  const [mode, setMode] = useState<Mode>();
  const seeds = state.seeds;

  return (
    <div className="screen">
      <TopBar title={mode ? TITLES[mode] : 'Add account'} onBack={mode ? () => setMode(undefined) : undefined} />
      {!mode && (
        <div className="screen-body">
          <div className="list">
            {seeds.length > 0 && (
              <Option
                icon="plus"
                title={seeds.length === 1 ? `New account in ${seeds[0].name}` : 'New account'}
                sub={seeds.length === 1 ? 'Uses your existing recovery phrase' : 'Pick which wallet to add it to'}
                onClick={() => setMode('derive')}
              />
            )}
            <Option icon="layers" title="Create a new recovery phrase" sub="A separate wallet with its own backup" onClick={() => setMode('create')} />
            <Option icon="receive" title="Import recovery phrase" sub="12 or 24 words from another wallet" onClick={() => setMode('import')} />
            <Option icon="key" title="Import private key" sub="A single EVM or Solana account" onClick={() => setMode('key')} />
          </div>
        </div>
      )}
      {mode === 'derive' && <DeriveForm />}
      {mode === 'create' && <CreateForm />}
      {mode === 'import' && <ImportPhraseForm />}
      {mode === 'key' && <ImportKeyForm />}
    </div>
  );
}

function Option({ icon, title, sub, onClick }: { icon: IconName; title: string; sub: string; onClick: () => void }) {
  return (
    <button className="list-item" onClick={onClick}>
      <span className="row" style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--surface)', justifyContent: 'center' }}>
        <Icon name={icon} size={18} />
      </span>
      <div className="main">
        <div className="title">{title}</div>
        <div className="sub">{sub}</div>
      </div>
      <Icon name="chevronRight" size={16} />
    </button>
  );
}

/** Shared submit handling: runs the action, then toasts, refreshes and returns home. */
function useSubmit() {
  const { refresh, toast } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    try {
      const msg = await fn();
      await refresh();
      toast(msg);
      navigate('/');
    } catch (e) {
      setError(friendlyError((e as Error).message));
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function friendlyError(msg: string): string {
  if (msg === 'Invalid EVM private key') return "That isn't a valid EVM private key. It should be 64 hex characters, with or without 0x.";
  if (msg.startsWith('Invalid Solana private key')) {
    return "That isn't a valid Solana private key. Paste the full 64-byte key as base58 text or a JSON byte array.";
  }
  if (msg === 'Invalid recovery phrase') return "That recovery phrase isn't valid. Check the spelling and order of each word.";
  return msg;
}

function FormScreen({ children, footer, onSubmit }: { children: ReactNode; footer: ReactNode; onSubmit: () => void }) {
  return (
    <form
      style={{ display: 'contents' }}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="screen-body">
        <div className="stack">{children}</div>
      </div>
      <div className="screen-footer">{footer}</div>
    </form>
  );
}

function NameField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <Field label="Name (optional)" htmlFor="acct-name">
      <input id="acct-name" className="input" maxLength={40} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function DeriveForm() {
  const { state } = useWallet();
  const [seedId, setSeedId] = useState(state.seeds[0]?.id ?? '');
  const [name, setName] = useState('');
  const { busy, error, run } = useSubmit();
  return (
    <FormScreen
      onSubmit={() =>
        run(async () => {
          const a = await api.addAccount({ seedId, name });
          return `${a.name} added`;
        })
      }
      footer={
        <Button type="submit" loading={busy} disabled={!seedId}>
          Add account
        </Button>
      }
    >
      {state.seeds.length > 1 && (
        <Field label="Wallet" htmlFor="seed-select">
          <select id="seed-select" className="select" value={seedId} onChange={(e) => setSeedId(e.target.value)}>
            {state.seeds.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <NameField value={name} onChange={setName} placeholder={`Account ${state.accounts.length + 1}`} />
      <div className="notice info">The new account comes from the same recovery phrase, so your existing backup covers it too.</div>
      <ErrorNote error={error} />
    </FormScreen>
  );
}

function CreateForm() {
  const { state } = useWallet();
  const [words, setWords] = useState<12 | 24>(12);
  const [phrase, setPhrase] = useState<string>();
  const [hidden, setHidden] = useState(true);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState('');
  const { busy, error, setError, run } = useSubmit();

  useEffect(() => {
    let stale = false;
    setPhrase(undefined);
    setSaved(false);
    api
      .generateMnemonic(words)
      .then((m) => !stale && setPhrase(m))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [words, setError]);

  return (
    <FormScreen
      onSubmit={() =>
        phrase &&
        run(async () => {
          const { seed } = await api.addSeed({ mnemonic: phrase, name, backedUp: true });
          return `${seed.name} created`;
        })
      }
      footer={
        <Button type="submit" loading={busy} disabled={!phrase || !saved}>
          Create wallet
        </Button>
      }
    >
      <div className="segmented" role="radiogroup" aria-label="Number of words">
        {([12, 24] as const).map((n) => (
          <button key={n} type="button" role="radio" aria-checked={words === n} className={words === n ? 'active' : ''} onClick={() => setWords(n)}>
            {n} words
          </button>
        ))}
      </div>
      <div className="notice">Write these words down in order and keep them somewhere safe and offline. They're the only way to recover this wallet.</div>
      {phrase ? (
        <>
          <PhraseGrid phrase={phrase} hidden={hidden} onReveal={() => setHidden(false)} />
          <div className="row" style={{ justifyContent: 'center', gap: 2 }}>
            <CopyButton text={phrase} label="Copy recovery phrase" />
            <span className="small muted">Copy to clipboard</span>
          </div>
        </>
      ) : (
        <div className="center" style={{ padding: 24 }}>
          <Spinner />
        </div>
      )}
      <label className="row small" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
        <input type="checkbox" checked={saved} disabled={hidden} onChange={(e) => setSaved(e.target.checked)} style={{ marginTop: 2 }} />
        <span>I saved these words somewhere safe</span>
      </label>
      <NameField value={name} onChange={setName} placeholder={`Wallet ${state.seeds.length + 1}`} />
      <ErrorNote error={error} />
    </FormScreen>
  );
}

function ImportPhraseForm() {
  const { state } = useWallet();
  const [phrase, setPhrase] = useState('');
  const [name, setName] = useState('');
  const { busy, error, setError, run } = useSubmit();
  const count = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;

  const submit = () =>
    run(async () => {
      if (count !== 12 && count !== 24) throw new Error(`Enter 12 or 24 words separated by spaces. You entered ${count}.`);
      if (!(await api.validateMnemonic(phrase))) throw new Error('Invalid recovery phrase');
      const { seed } = await api.addSeed({ mnemonic: phrase, name });
      return `${seed.name} imported`;
    });

  return (
    <FormScreen
      onSubmit={submit}
      footer={
        <Button type="submit" loading={busy} disabled={!count}>
          Import
        </Button>
      }
    >
      <Field label="Recovery phrase" htmlFor="import-phrase" hint={count ? `${count} words` : 'Separate words with spaces.'}>
        <textarea
          id="import-phrase"
          className="textarea mono"
          rows={5}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={phrase}
          onChange={(e) => {
            setPhrase(e.target.value);
            setError(undefined);
          }}
        />
      </Field>
      <NameField value={name} onChange={setName} placeholder={`Wallet ${state.seeds.length + 1}`} />
      <ErrorNote error={error} />
    </FormScreen>
  );
}

function ImportKeyForm() {
  const { state } = useWallet();
  const [chainType, setChainType] = useState<ChainType>('evm');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const { busy, error, setError, run } = useSubmit();
  const importedCount = state.accounts.filter((a) => a.kind === 'privateKey').length;

  return (
    <FormScreen
      onSubmit={() =>
        run(async () => {
          const a = await api.importPrivateKey({ chainType, privateKey: key, name });
          return `${a.name} imported`;
        })
      }
      footer={
        <Button type="submit" loading={busy} disabled={!key.trim()}>
          Import
        </Button>
      }
    >
      <div className="segmented" role="radiogroup" aria-label="Chain">
        {(['evm', 'solana'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={chainType === t}
            className={chainType === t ? 'active' : ''}
            onClick={() => {
              setChainType(t);
              setError(undefined);
            }}
          >
            {t === 'evm' ? 'EVM' : 'Solana'}
          </button>
        ))}
      </div>
      <Field
        label="Private key"
        htmlFor="import-key"
        hint={
          chainType === 'evm'
            ? '64 hex characters, with or without 0x.'
            : 'Base58 text (as exported from Phantom or Solflare) or a JSON byte array like [12,34,…] from solana-keygen.'
        }
      >
        <textarea
          id="import-key"
          className="textarea mono"
          rows={4}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setError(undefined);
          }}
        />
      </Field>
      <NameField value={name} onChange={setName} placeholder={`Imported ${importedCount + 1}`} />
      <div className="notice info">
        Imported accounts aren't covered by your recovery phrase. Keep a copy of this key in case you need to restore it.
      </div>
      <ErrorNote error={error} />
    </FormScreen>
  );
}
