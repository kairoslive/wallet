import { useMemo, useState } from 'react';
import type { ChainType } from '../../core/types';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useMaybeWallet } from '../lib/store';
import { Button, ErrorNote, Field, TopBar } from '../components/ui';

type Step =
  | { kind: 'welcome' }
  | { kind: 'show-phrase'; mnemonic: string }
  | { kind: 'confirm-phrase'; mnemonic: string }
  | { kind: 'import-phrase' }
  | { kind: 'import-key' }
  | { kind: 'password'; mnemonic?: string; privateKey?: { chainType: ChainType; key: string }; backedUp: boolean }
  | { kind: 'done' };

export function WalletMark({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <rect width="128" height="128" rx="28" fill="#1A2233" />
      <circle cx="52" cy="64" r="26" fill="#3B82F6" />
      <circle cx="76" cy="64" r="26" fill="#A78BFA" fillOpacity=".9" />
    </svg>
  );
}

export function Onboarding() {
  const [step, setStep] = useState<Step>({ kind: 'welcome' });
  const { state } = useMaybeWallet();

  // A wallet already exists (e.g. the onboarding tab was reopened): don't offer to create another.
  if (state?.initialized && step.kind !== 'done') return <Done />;

  switch (step.kind) {
    case 'welcome':
      return (
        <div className="screen">
          <div className="screen-body stack" style={{ justifyContent: 'center' }}>
            <div className="stack" style={{ gap: 12, marginBottom: 28 }}>
              <WalletMark size={72} />
              <h1 style={{ margin: 0, fontSize: 30, letterSpacing: '-0.03em', lineHeight: 1.1 }}>
                One wallet for Ethereum and Solana
              </h1>
              <p className="ink2" style={{ margin: 0 }}>
                Hold, send, swap and bridge across EVM networks and Solana from a single recovery phrase. Your keys stay
                encrypted on this device.
              </p>
            </div>
            <Button block onClick={async () => setStep({ kind: 'show-phrase', mnemonic: await api.generateMnemonic(12) })}>
              Create a new wallet
            </Button>
            <Button block variant="secondary" onClick={() => setStep({ kind: 'import-phrase' })}>
              Import recovery phrase
            </Button>
            <button className="link-btn" style={{ alignSelf: 'center' }} onClick={() => setStep({ kind: 'import-key' })}>
              Import a private key instead
            </button>
          </div>
        </div>
      );
    case 'show-phrase':
      return <ShowPhrase mnemonic={step.mnemonic} onBack={() => setStep({ kind: 'welcome' })} onNext={() => setStep({ kind: 'confirm-phrase', mnemonic: step.mnemonic })} />;
    case 'confirm-phrase':
      return (
        <ConfirmPhrase
          mnemonic={step.mnemonic}
          onBack={() => setStep({ kind: 'show-phrase', mnemonic: step.mnemonic })}
          onNext={() => setStep({ kind: 'password', mnemonic: step.mnemonic, backedUp: true })}
        />
      );
    case 'import-phrase':
      return (
        <ImportPhrase
          onBack={() => setStep({ kind: 'welcome' })}
          onNext={(mnemonic) => setStep({ kind: 'password', mnemonic, backedUp: true })}
        />
      );
    case 'import-key':
      return (
        <ImportKey
          onBack={() => setStep({ kind: 'welcome' })}
          onNext={(privateKey) => setStep({ kind: 'password', privateKey, backedUp: true })}
        />
      );
    case 'password':
      return <CreatePassword step={step} onBack={() => setStep({ kind: 'welcome' })} onDone={() => setStep({ kind: 'done' })} />;
    case 'done':
      return <Done />;
  }
}

function ShowPhrase({ mnemonic, onBack, onNext }: { mnemonic: string; onBack: () => void; onNext: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const [saved, setSaved] = useState(false);
  const words = mnemonic.split(' ');
  return (
    <div className="screen">
      <TopBar title="Your recovery phrase" onBack={onBack} />
      <div className="screen-body stack">
        <p className="ink2" style={{ margin: 0 }}>
          Write these 12 words down in order and keep them offline. Anyone with this phrase can take your funds, and it's the only
          way to recover your wallet.
        </p>
        <div style={{ position: 'relative' }}>
          <div className={`phrase-grid ${revealed ? '' : 'blurred'}`} data-testid="phrase-grid">
            {words.map((w, i) => (
              <div key={i} className="word">
                <span>{i + 1}</span>
                {w}
              </div>
            ))}
          </div>
          {!revealed && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Button variant="secondary" small icon="eye" onClick={() => setRevealed(true)}>
                Reveal phrase
              </Button>
            </div>
          )}
        </div>
        {revealed && (
          <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => navigator.clipboard.writeText(mnemonic)}>
            Copy to clipboard
          </button>
        )}
        <label className="row small ink2" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved my recovery phrase somewhere safe
        </label>
      </div>
      <div className="screen-footer">
        <Button onClick={onNext} disabled={!revealed || !saved}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/** Asks for three random words to make sure the phrase was written down. */
function ConfirmPhrase({ mnemonic, onBack, onNext }: { mnemonic: string; onBack: () => void; onNext: () => void }) {
  const words = mnemonic.split(' ');
  const positions = useMemo(() => {
    const idx = new Set<number>();
    while (idx.size < 3) idx.add(Math.floor(Math.random() * words.length));
    return [...idx].sort((a, b) => a - b);
  }, [words.length]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const correct = positions.every((p) => answers[p]?.trim().toLowerCase() === words[p]);
  const touched = positions.every((p) => answers[p]?.trim());
  return (
    <div className="screen">
      <TopBar title="Confirm your phrase" onBack={onBack} />
      <form
        className="screen-body stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (correct) onNext();
        }}
      >
        <p className="ink2" style={{ margin: 0 }}>
          Enter the requested words from your recovery phrase.
        </p>
        {positions.map((p, i) => (
          <Field key={p} label={`Word #${p + 1}`} htmlFor={`confirm-${p}`}>
            <input
              id={`confirm-${p}`}
              className="input"
              autoFocus={i === 0}
              autoComplete="off"
              value={answers[p] ?? ''}
              onChange={(e) => setAnswers({ ...answers, [p]: e.target.value })}
            />
          </Field>
        ))}
        {touched && !correct && <ErrorNote error="Those words don't match your phrase. Check the order and spelling." />}
        <Button type="submit" disabled={!correct}>
          Continue
        </Button>
      </form>
    </div>
  );
}

function ImportPhrase({ onBack, onNext }: { onBack: () => void; onNext: (m: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <div className="screen">
      <TopBar title="Import recovery phrase" onBack={onBack} />
      <form
        className="screen-body stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await api.validateMnemonic(text)) onNext(text.trim().toLowerCase().split(/\s+/).join(' '));
          else setError('This isn\'t a valid recovery phrase. Check each word is spelled correctly and in order.');
        }}
      >
        <Field label="Recovery phrase" hint={`${wordCount} words · 12 or 24 words separated by spaces`} error={error} htmlFor="import-phrase">
          <textarea
            id="import-phrase"
            className="textarea"
            rows={5}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(undefined);
            }}
          />
        </Field>
        <div className="notice info">Accounts are derived on the standard paths used by MetaMask (EVM) and Phantom (Solana).</div>
        <Button type="submit" disabled={![12, 15, 18, 21, 24].includes(wordCount)}>
          Continue
        </Button>
      </form>
    </div>
  );
}

function ImportKey({ onBack, onNext }: { onBack: () => void; onNext: (k: { chainType: ChainType; key: string }) => void }) {
  const [chainType, setChainType] = useState<ChainType>('evm');
  const [key, setKey] = useState('');
  return (
    <div className="screen">
      <TopBar title="Import private key" onBack={onBack} />
      <form
        className="screen-body stack"
        onSubmit={(e) => {
          e.preventDefault();
          onNext({ chainType, key: key.trim() });
        }}
      >
        <div className="segmented">
          <button type="button" className={chainType === 'evm' ? 'active' : ''} onClick={() => setChainType('evm')}>
            EVM
          </button>
          <button type="button" className={chainType === 'solana' ? 'active' : ''} onClick={() => setChainType('solana')}>
            Solana
          </button>
        </div>
        <Field
          label="Private key"
          hint={chainType === 'evm' ? '64 hex characters, with or without 0x' : 'Base58 string or a JSON byte array'}
          htmlFor="import-key"
        >
          <textarea
            id="import-key"
            className="textarea mono"
            rows={4}
            spellCheck={false}
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <div className="notice">A private-key account only works on {chainType === 'evm' ? 'EVM networks' : 'Solana'}. You can add a recovery phrase later.</div>
        <Button type="submit" disabled={!key.trim()}>
          Continue
        </Button>
      </form>
    </div>
  );
}

function CreatePassword({ step, onBack, onDone }: { step: Extract<Step, { kind: 'password' }>; onBack: () => void; onDone: () => void }) {
  const { refresh } = useMaybeWallet();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <div className="screen">
      <TopBar title="Create a password" onBack={onBack} />
      <form
        className="screen-body stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await api.createWallet({ password, mnemonic: step.mnemonic, privateKey: step.privateKey, backedUp: step.backedUp });
            await refresh();
            onDone();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <p className="ink2" style={{ margin: 0 }}>
          This password unlocks the wallet on this device. It can't be recovered, but your recovery phrase can always restore the wallet.
        </p>
        <Field label="Password" error={tooShort ? 'Use at least 8 characters' : undefined} htmlFor="new-password">
          <input id="new-password" className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" error={mismatch ? "Passwords don't match" : undefined} htmlFor="confirm-password">
          <input id="confirm-password" className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={password.length < 8 || password !== confirm}>
          Create wallet
        </Button>
      </form>
    </div>
  );
}

function Done() {
  const inTab = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab') === '1';
  return (
    <div className="screen">
      <div className="screen-body stack" style={{ justifyContent: 'center' }}>
        <WalletMark size={64} />
        <h1 style={{ margin: 0, fontSize: 26, letterSpacing: '-0.02em' }}>Your wallet is ready</h1>
        <p className="ink2" style={{ margin: 0 }}>
          Open it any time from the toolbar. Pin the extension so it's one click away.
        </p>
        <Button block onClick={() => navigate('/', inTab ? { tab: '1' } : undefined, true)}>
          Open wallet
        </Button>
      </div>
    </div>
  );
}
