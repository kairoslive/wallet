import { useEffect, useState, type ReactNode } from 'react';
import type { ApprovalRequest } from '../../core/dapp/types';
import type { Account, EvmNetwork, Network, Token } from '../../core/types';
import { formatAmount, shortAddress } from '../../core/format';
import { bg } from '../lib/api';
import { useWallet } from '../lib/store';
import { Avatar, Button, Empty, NetworkDot, Spinner, TokenIcon } from '../components/ui';
import { Unlock } from './Unlock';
import { hostname } from '../../shared/url';
import type { DecodedCall } from '../../core/dapp/controller';

export function Approve() {
  const { state } = useWallet();
  const [requests, setRequests] = useState<ApprovalRequest[]>();

  useEffect(() => {
    let alive = true;
    const poll = () =>
      bg('approvals.list')
        .then((r) => alive && setRequests(r))
        .catch(() => alive && setRequests([]));
    void poll();
    // Polling also keeps the service worker awake while a request is open.
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!requests) {
    return (
      <div className="screen" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size={24} />
      </div>
    );
  }
  const current = requests[0];
  if (!current) {
    return (
      <div className="screen">
        <div className="screen-body" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <Empty title="No pending requests">Requests from websites will appear here.</Empty>
          <Button variant="secondary" onClick={() => window.close()}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  if (!state.unlocked) return <Unlock subtitle={`Unlock to review a request from ${hostname(current.origin)}`} />;

  const resolve = async (approved: boolean, data?: Record<string, unknown>) => {
    await bg('approvals.resolve', current.id, { approved, data });
    setRequests((r) => r?.filter((x) => x.id !== current.id));
  };

  return <RequestView key={current.id} request={current} queued={requests.length - 1} onResolve={resolve} />;
}

function RequestView({
  request,
  queued,
  onResolve,
}: {
  request: ApprovalRequest;
  queued: number;
  onResolve: (approved: boolean, data?: Record<string, unknown>) => Promise<void>;
}) {
  const { state, networks } = useWallet();
  const [busy, setBusy] = useState(false);
  // Briefly ignore clicks on a freshly shown request, so a double-click can't approve the next one in the queue.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 800);
    return () => clearTimeout(t);
  }, []);
  const p = request.payload;
  const account = state.accounts.find((a) => a.id === p.accountId);
  const [selected, setSelected] = useState<string[]>(() => {
    if (request.type !== 'connect') return [];
    const existing = (p.existingAccountIds as string[]) ?? [];
    return existing.length ? existing : [String(p.selectedAccountId ?? state.selectedAccountId)];
  });

  const approve = async () => {
    setBusy(true);
    await onResolve(true, request.type === 'connect' ? { accountIds: selected } : undefined);
    setBusy(false);
  };
  const reject = async () => {
    setBusy(true);
    await onResolve(false);
    setBusy(false);
  };

  let title = '';
  let body: ReactNode = null;
  let approveLabel = 'Approve';
  switch (request.type) {
    case 'connect': {
      const chain = p.chain as 'evm' | 'solana';
      const eligible = state.accounts.filter((a) => !a.hidden && (chain === 'evm' ? a.evmAddress : a.solanaAddress));
      title = 'Connect to this site';
      approveLabel = 'Connect';
      body = (
        <>
          <p className="ink2" style={{ margin: 0 }}>
            The site will see the addresses of the accounts you choose and can ask you to approve transactions. It can't move
            funds without your approval.
          </p>
          <div className="list">
            {eligible.map((a) => (
              <label key={a.id} className="list-item clickable">
                <Avatar seed={a.evmAddress ?? a.solanaAddress ?? a.id} />
                <div className="main">
                  <div className="title">{a.name}</div>
                  <div className="sub">{shortAddress((chain === 'evm' ? a.evmAddress : a.solanaAddress) ?? '')}</div>
                </div>
                <input
                  type="checkbox"
                  checked={selected.includes(a.id)}
                  onChange={(e) => setSelected((s) => (e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id)))}
                />
              </label>
            ))}
          </div>
          {!eligible.length && (
            <div className="notice error">None of your accounts has a {chain === 'evm' ? 'EVM' : 'Solana'} address.</div>
          )}
        </>
      );
      break;
    }
    case 'evmSignMessage':
    case 'solanaSignMessage':
      title = 'Sign message';
      approveLabel = 'Sign';
      body = (
        <>
          <AccountRow account={account} address={p.address as string} />
          <div className="field-label">Message</div>
          <pre className="panel mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 220, overflow: 'auto' }}>
            {String(p.message)}
          </pre>
          <div className="small muted">
            Signing a message doesn't cost fees or send a transaction. Only sign messages from sites you trust.
          </div>
        </>
      );
      break;
    case 'evmSignTypedData': {
      const td = p.typedData as { domain?: Record<string, unknown>; primaryType?: string; message?: unknown };
      const chainId = td.domain?.chainId !== undefined ? Number(td.domain.chainId) : undefined;
      const net = networks.find((n) => n.type === 'evm' && n.chainId === chainId);
      title = 'Sign typed data';
      approveLabel = 'Sign';
      body = (
        <>
          <AccountRow account={account} address={p.address as string} />
          <div className="panel">
            {td.domain?.name !== undefined && <KV k="Contract">{String(td.domain.name)}</KV>}
            {td.domain?.verifyingContract !== undefined && (
              <KV k="Verifying contract">{shortAddress(String(td.domain.verifyingContract))}</KV>
            )}
            {chainId !== undefined && <KV k="Network">{net?.name ?? `Chain ${chainId}`}</KV>}
            <KV k="Type">{td.primaryType}</KV>
          </div>
          <div className="field-label">Message</div>
          <pre className="panel mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 200, overflow: 'auto' }}>
            {JSON.stringify(td.message, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}
          </pre>
          {td.primaryType === 'Permit' || td.primaryType === 'PermitSingle' || td.primaryType === 'PermitBatch' ? (
            <div className="notice">
              This signature lets the spender move your tokens without another approval. Only sign it on sites you trust.
            </div>
          ) : null}
        </>
      );
      break;
    }
    case 'evmSendTransaction': {
      const net = networks.find((n) => n.id === p.networkId) as EvmNetwork | undefined;
      const decimals = net?.nativeCurrency.decimals ?? 18;
      const symbol = net?.nativeCurrency.symbol ?? 'ETH';
      const data = String(p.data ?? '0x');
      title = 'Review transaction';
      approveLabel = 'Confirm';
      body = (
        <>
          <AccountRow account={account} address={p.from as string} />
          {p.decoded ? (
            <DecodedCallView
              call={p.decoded as DecodedCall}
              token={p.token as { symbol: string; decimals: number } | undefined}
            />
          ) : null}
          <div className="panel">
            <KV k="Network">
              <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                <NetworkDot network={net} /> {net?.name}
              </span>
            </KV>
            <KV k="To">{p.to ? shortAddress(String(p.to), 6) : 'New contract'}</KV>
            <KV k="Amount">
              {formatAmount(String(p.value ?? '0'), decimals)} {symbol}
            </KV>
            <KV k="Network fee (max)">{p.fee ? `${formatAmount(String(p.fee), decimals)} ${symbol}` : '—'}</KV>
            {data !== '0x' && <KV k="Function">{data.slice(0, 10)}</KV>}
          </div>
          {p.estimateError ? (
            <div className="notice error">This transaction is likely to fail: {String(p.estimateError)}</div>
          ) : null}
          {data !== '0x' && (
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                Transaction data ({(data.length - 2) / 2} bytes)
              </summary>
              <pre className="panel mono" style={{ whiteSpace: 'pre-wrap', marginTop: 8, maxHeight: 140, overflow: 'auto' }}>
                {data}
              </pre>
            </details>
          )}
        </>
      );
      break;
    }
    case 'evmAddNetwork': {
      const n = p.network as Network & { chainId: number };
      title = 'Add network';
      approveLabel = 'Add network';
      body = (
        <>
          <div className="notice">
            Only add networks you trust. A malicious RPC can show false balances or track your activity.
          </div>
          <div className="panel">
            <KV k="Name">{n.name}</KV>
            <KV k="Chain ID">{n.chainId}</KV>
            <KV k="RPC URL">{n.rpcUrl}</KV>
            <KV k="Currency">
              {n.nativeCurrency.symbol} ({n.nativeCurrency.decimals} decimals)
            </KV>
            {n.explorerUrl && <KV k="Explorer">{n.explorerUrl}</KV>}
          </div>
        </>
      );
      break;
    }
    case 'evmWatchAsset': {
      const t = p.token as Token;
      title = 'Add token';
      approveLabel = 'Add token';
      body = (
        <div className="panel">
          <div className="row" style={{ marginBottom: 6 }}>
            <TokenIcon token={t} />
            <div>
              <div className="title" style={{ fontWeight: 700 }}>
                {t.symbol}
              </div>
              <div className="small muted">{t.name}</div>
            </div>
          </div>
          <KV k="Network">{String(p.networkName)}</KV>
          <KV k="Contract">{shortAddress(t.address, 6)}</KV>
          <KV k="Decimals">{t.decimals}</KV>
        </div>
      );
      break;
    }
    case 'solanaSignTransaction': {
      const net = networks.find((n) => n.id === p.networkId);
      const txs = p.transactions as { feePayer?: string; programs: string[]; version: string }[];
      title = p.send ? 'Review transaction' : txs.length > 1 ? `Sign ${txs.length} transactions` : 'Sign transaction';
      approveLabel = p.send ? 'Confirm' : 'Sign';
      body = (
        <>
          <AccountRow account={account} address={p.address as string} />
          <div className="panel">
            <KV k="Network">
              <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                <NetworkDot network={net} /> {net?.name}
              </span>
            </KV>
            {txs.map((t, i) => (
              <div key={i}>
                <KV k={txs.length > 1 ? `Transaction ${i + 1}` : 'Fee payer'}>
                  {t.feePayer ? shortAddress(t.feePayer) : '—'}
                  {t.feePayer && t.feePayer !== p.address ? ' (site pays)' : ''}
                </KV>
                <div className="small muted" style={{ paddingBottom: 6 }}>
                  Programs: {t.programs.join(', ')}
                </div>
              </div>
            ))}
          </div>
          {!p.send && <div className="small muted">The site will submit the signed transaction itself.</div>}
        </>
      );
      break;
    }
  }

  return (
    <div className="screen">
      <div className="topbar" style={{ padding: '0 20px' }}>
        <SiteBadge origin={request.origin} />
        <div className="spacer" />
        {queued > 0 && <span className="tag">+{queued} more</span>}
      </div>
      <div className="screen-body stack">
        <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>{title}</h1>
        {body}
      </div>
      <div className="screen-footer">
        <Button variant="secondary" onClick={reject} disabled={busy}>
          Reject
        </Button>
        <Button onClick={approve} loading={busy} disabled={!armed || (request.type === 'connect' && !selected.length)}>
          {approveLabel}
        </Button>
      </div>
    </div>
  );
}

function SiteBadge({ origin }: { origin: string }) {
  const host = hostname(origin);
  const insecure = origin.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin);
  return (
    <div className="row" style={{ gap: 8, minWidth: 0 }}>
      {/* A letter badge rather than a remote favicon, so the wallet doesn't leak visited sites to third parties. */}
      <span
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: 'var(--surface-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 750,
        }}
      >
        {host
          .replace(/^www\./, '')
          .charAt(0)
          .toUpperCase()}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="ellipsis" style={{ fontWeight: 700 }} data-testid="approval-origin">
          {host}
        </div>
        {insecure && <div className="small neg">Not secure (http)</div>}
      </div>
    </div>
  );
}

function AccountRow({ account, address }: { account?: Account; address?: string }) {
  return (
    <div className="row panel" style={{ padding: '8px 12px' }}>
      <Avatar seed={account?.evmAddress ?? account?.solanaAddress ?? address ?? ''} size={28} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 650 }}>{account?.name ?? 'Account'}</div>
        <div className="small muted">{shortAddress(address ?? '', 6)}</div>
      </div>
    </div>
  );
}

function DecodedCallView({ call, token }: { call: DecodedCall; token?: { symbol: string; decimals: number } }) {
  const amount = (v?: string) =>
    v === undefined ? '' : token ? `${formatAmount(v, token.decimals, token.decimals)} ${token.symbol}` : `${v} (raw units)`;
  const target = shortAddress(call.target, 6);
  let text: string;
  let danger = false;
  switch (call.fn) {
    case 'approve':
    case 'increaseAllowance':
      danger = !!call.unlimited;
      text = call.unlimited
        ? `Allow ${target} to spend an unlimited amount of your ${token?.symbol ?? 'tokens'}`
        : `Allow ${target} to spend ${amount(call.amount)}`;
      break;
    case 'transfer':
      text = `Send ${amount(call.amount)} to ${target}`;
      break;
    case 'transferFrom':
      text = `Move ${amount(call.amount)} from ${shortAddress(call.from ?? '', 6)} to ${target}`;
      break;
    case 'setApprovalForAll':
      danger = !!call.approved;
      text = call.approved
        ? `Allow ${target} to transfer all of your NFTs in this collection`
        : `Revoke ${target}'s access to this collection`;
      break;
  }
  return (
    <div className={`notice ${danger ? 'error' : 'info'}`} data-testid="decoded-call">
      {text}
      {danger && '. Only approve this for contracts you trust.'}
    </div>
  );
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span>{children}</span>
    </div>
  );
}
