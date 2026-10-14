import { useState, type ReactNode } from 'react';
import type { SeedMeta } from '../../core/types';
import { api } from '../lib/api';
import { useWallet } from '../lib/store';
import { Button, CopyButton, ErrorNote, Sheet } from './ui';
import { PasswordSheet } from './pickers';

/** Numbered recovery-phrase words. Blurred until the user taps, to guard against shoulder-surfing. */
export function PhraseGrid({ phrase, hidden, onReveal }: { phrase: string; hidden?: boolean; onReveal?: () => void }) {
  const words = phrase.trim().split(/\s+/);
  return (
    <div style={{ position: 'relative' }}>
      <div className={`phrase-grid ${hidden ? 'blurred' : ''}`} data-testid="phrase-grid" aria-hidden={hidden}>
        {words.map((w, i) => (
          <div key={i} className="word">
            <span>{i + 1}</span>
            {w}
          </div>
        ))}
      </div>
      {hidden && (
        <div className="row" style={{ position: 'absolute', inset: 0, justifyContent: 'center' }}>
          <Button variant="secondary" small icon="eye" onClick={onReveal}>
            Show words
          </Button>
        </div>
      )}
    </div>
  );
}

/** Generic confirmation for destructive or hard-to-undo actions. */
export function ConfirmSheet({
  title,
  confirmLabel,
  onConfirm,
  onClose,
  danger = true,
  children,
}: {
  title: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack">
        {children}
        <ErrorNote error={error} />
        <div className="row">
          <Button variant="secondary" style={{ flex: 1 }} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            style={{ flex: 1 }}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await onConfirm();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** Password prompt, then the wallet's recovery phrase, with an option to mark it as backed up. */
export function RevealPhraseSheet({ seed, onClose }: { seed: SeedMeta; onClose: () => void }) {
  const { refresh, toast } = useWallet();
  const [phrase, setPhrase] = useState<string>();
  const [hidden, setHidden] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!phrase) {
    return (
      <PasswordSheet
        title="Show recovery phrase"
        confirmLabel="Show phrase"
        onClose={onClose}
        onSubmit={async (pw) => setPhrase(await api.revealMnemonic(seed.id, pw))}
      >
        <div className="notice">
          Anyone with the recovery phrase for {seed.name} can take every account in it. Make sure nobody can see your screen.
        </div>
      </PasswordSheet>
    );
  }

  const markBackedUp = async () => {
    setBusy(true);
    try {
      await api.markSeedBackedUp(seed.id);
      await refresh();
      toast(`${seed.name} is marked as backed up`);
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };

  return (
    <Sheet title={`${seed.name} recovery phrase`} onClose={onClose}>
      <div className="stack">
        <div className="notice">Write these words down in order and keep them offline. Never type them into a website.</div>
        <PhraseGrid phrase={phrase} hidden={hidden} onReveal={() => setHidden(false)} />
        <div className="row" style={{ justifyContent: 'center', gap: 2 }}>
          <CopyButton text={phrase} label="Copy recovery phrase" />
          <span className="small muted">Copy to clipboard</span>
        </div>
        {seed.backedUp ? (
          <Button variant="secondary" block onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button block loading={busy} disabled={hidden} onClick={markBackedUp}>
            I've backed it up
          </Button>
        )}
      </div>
    </Sheet>
  );
}

/** Opens a URL in a new browser tab (popup links don't navigate on their own). */
export function openTab(url: string) {
  void chrome.tabs.create({ url });
}
