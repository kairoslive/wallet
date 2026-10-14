import { useState } from 'react';
import type { Account, ChainType, Network } from '../../core/types';
import { explorerAddressUrl } from '../../core/networks';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { Avatar, Button, CopyButton, Empty, ErrorNote, Sheet, Toggle, TopBar } from '../components/ui';
import { PasswordSheet } from '../components/pickers';
import { ConfirmSheet, openTab } from '../components/sheets';
import { Icon } from '../components/Icon';

const CHAIN_LABEL: Record<ChainType, string> = { evm: 'EVM', solana: 'Solana' };

/** Explorer links go to a mainnet the user has enabled, falling back to any network of that type. */
function explorerNetwork(networks: Network[], type: ChainType): Network | undefined {
  const ofType = networks.filter((n) => n.type === type && n.explorerUrl);
  return ofType.find((n) => n.enabled && !n.testnet) ?? ofType.find((n) => !n.testnet) ?? ofType[0];
}

export function AccountDetails() {
  const { state, networks, refresh, toast } = useWallet();
  const id = useRoute().query.get('id');
  const account = state.accounts.find((a) => a.id === id);
  const [revealChain, setRevealChain] = useState<ChainType>();
  const [secret, setSecret] = useState<{ chain: ChainType; key: string }>();
  const [removing, setRemoving] = useState(false);

  if (!account) {
    return (
      <div className="screen">
        <TopBar title="Account" />
        <Empty title="Account not found">It may have been removed.</Empty>
      </div>
    );
  }

  const seed = state.seeds.find((s) => s.id === account.seedId);
  const chains: { type: ChainType; address: string }[] = [];
  if (account.evmAddress) chains.push({ type: 'evm', address: account.evmAddress });
  if (account.solanaAddress) chains.push({ type: 'solana', address: account.solanaAddress });
  const isOnly = state.accounts.length === 1;

  const setHidden = async (hidden: boolean) => {
    try {
      await api.setAccountHidden(account.id, hidden);
      await refresh();
      toast(hidden ? 'Account hidden' : 'Account visible again');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="screen">
      <TopBar title="Account" />
      <div className="screen-body">
        <NameEditor account={account} />

        <h2 className="section">Addresses</h2>
        <div className="list">
          {chains.map((c) => {
            const n = explorerNetwork(networks, c.type);
            return (
              <div key={c.type} className="list-item">
                <div className="main">
                  <div className="title">{CHAIN_LABEL[c.type]}</div>
                  <div className="mono muted">{c.address}</div>
                </div>
                <CopyButton text={c.address} label={`Copy ${CHAIN_LABEL[c.type]} address`} />
                {n && (
                  <button
                    className="icon-btn"
                    aria-label={`View on ${n.name} explorer`}
                    title={`View on ${n.name} explorer`}
                    onClick={() => openTab(explorerAddressUrl(n, c.address))}
                  >
                    <Icon name="external" size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <h2 className="section">Details</h2>
        <div className="panel">
          {account.kind === 'seed' && account.index !== undefined ? (
            <>
              <div className="kv">
                <span>Wallet</span>
                <span>{seed?.name ?? 'Unknown'}</span>
              </div>
              <div className="kv">
                <span>Index</span>
                <span className="num">{account.index}</span>
              </div>
              <div className="kv">
                <span>EVM path</span>
                <span className="mono">m/44'/60'/0'/0/{account.index}</span>
              </div>
              <div className="kv">
                <span>Solana path</span>
                <span className="mono">m/44'/501'/{account.index}'/0'</span>
              </div>
            </>
          ) : (
            <div className="kv">
              <span>Type</span>
              <span>Imported private key</span>
            </div>
          )}
        </div>

        <h2 className="section">Private keys</h2>
        <div className="list">
          {chains.map((c) => (
            <button key={c.type} className="list-item" onClick={() => setRevealChain(c.type)}>
              <Icon name="key" />
              <div className="main title">Show {CHAIN_LABEL[c.type]} private key</div>
              <Icon name="chevronRight" size={16} />
            </button>
          ))}
        </div>

        <h2 className="section">Visibility</h2>
        <div className="list-item">
          <div className="main">
            <div className="title">Hide account</div>
            <div className="sub">Hidden accounts stay in your wallet but don't appear in the account switcher.</div>
          </div>
          <Toggle on={!!account.hidden} onChange={setHidden} label="Hide account" />
        </div>

        <div style={{ marginTop: 18 }}>
          <Button variant="danger" block icon="trash" disabled={isOnly} onClick={() => setRemoving(true)}>
            Remove account
          </Button>
          {isOnly && (
            <div className="small muted center" style={{ marginTop: 6 }}>
              This is your only account, so it can't be removed.
            </div>
          )}
        </div>
      </div>

      {revealChain && (
        <PasswordSheet
          title={`Show ${CHAIN_LABEL[revealChain]} private key`}
          confirmLabel="Show key"
          onClose={() => setRevealChain(undefined)}
          onSubmit={async (pw) => {
            const key = await api.revealPrivateKey(account.id, revealChain, pw);
            setRevealChain(undefined);
            setSecret({ chain: revealChain, key });
          }}
        >
          <div className="notice">Anyone with this key has full control of this account's {CHAIN_LABEL[revealChain]} funds.</div>
        </PasswordSheet>
      )}

      {secret && (
        <Sheet title={`${CHAIN_LABEL[secret.chain]} private key`} onClose={() => setSecret(undefined)}>
          <div className="stack">
            <div className="notice error">
              Never share this key or paste it into a website. Anyone who has it can take your funds.
            </div>
            <div className="panel row" style={{ alignItems: 'flex-start' }}>
              <span className="mono" style={{ flex: 1 }} data-testid="private-key">
                {secret.key}
              </span>
              <CopyButton text={secret.key} label="Copy private key" />
            </div>
            {secret.chain === 'solana' && <div className="small muted">Base58 format, accepted by Phantom and Solflare.</div>}
            <Button variant="secondary" block onClick={() => setSecret(undefined)}>
              Done
            </Button>
          </div>
        </Sheet>
      )}

      {removing && (
        <ConfirmSheet
          title={`Remove ${account.name}?`}
          confirmLabel="Remove account"
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            await api.removeAccount(account.id);
            // Leave first so this page doesn't flash "not found" once the account is gone.
            navigate('/');
            toast(`${account.name} removed`);
            await refresh();
          }}
        >
          <RemoveExplanation account={account} seedName={seed?.name} />
        </ConfirmSheet>
      )}
    </div>
  );
}

function RemoveExplanation({ account, seedName }: { account: Account; seedName?: string }) {
  if (account.kind === 'privateKey') {
    return (
      <>
        <p style={{ margin: 0 }}>The private key for this account is deleted from this wallet. Funds stay on-chain.</p>
        <div className="notice error">Make sure you've saved the private key. Without it you can't get this account back.</div>
      </>
    );
  }
  return (
    <>
      <p style={{ margin: 0 }}>
        This account comes from the recovery phrase of {seedName ?? 'its wallet'}, so its funds stay safe on-chain and it can be
        derived again from that phrase.
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        Just want it out of the way? Hide it instead.
      </p>
    </>
  );
}

function NameEditor({ account }: { account: Account }) {
  const { refresh, toast } = useWallet();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <div className="row" style={{ padding: '8px 0' }}>
        <Avatar seed={account.evmAddress ?? account.solanaAddress ?? account.id} size={40} />
        <div className="ellipsis" style={{ flex: 1, fontSize: 18, fontWeight: 700 }}>
          {account.name}
        </div>
        <button
          className="icon-btn"
          aria-label="Rename account"
          title="Rename"
          onClick={() => {
            setName(account.name);
            setEditing(true);
          }}
        >
          <Icon name="edit" size={16} />
        </button>
      </div>
    );
  }

  return (
    <form
      className="stack"
      style={{ padding: '8px 0', gap: 8 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
          await api.renameAccount(account.id, name);
          await refresh();
          toast('Account renamed');
          setEditing(false);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          aria-label="Account name"
          autoFocus
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" small loading={busy} disabled={!name.trim()}>
          Save
        </Button>
        <Button type="button" variant="ghost" small onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}
