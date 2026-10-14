import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { ChainType } from '../../core/types';
import { useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { CopyButton, NetworkDot, Screen, TopBar } from '../components/ui';

export function Receive() {
  const { account, networks, activeNetworks } = useWallet();
  const route = useRoute();
  const requested = networks.find((n) => n.id === route.query.get('network'));
  const [chain, setChain] = useState<ChainType>(() => {
    if (requested?.type === 'solana' && account?.solanaAddress) return 'solana';
    if (requested?.type === 'evm' && account?.evmAddress) return 'evm';
    return account?.evmAddress ? 'evm' : 'solana';
  });
  const address = chain === 'evm' ? account?.evmAddress : account?.solanaAddress;
  const [qr, setQr] = useState<string>();

  useEffect(() => {
    if (!address) return;
    let stale = false;
    QRCode.toDataURL(address, { margin: 1, width: 400, color: { dark: '#1a2233', light: '#ffffff' } })
      .then((url) => !stale && setQr(url))
      .catch(() => !stale && setQr(undefined));
    return () => {
      stale = true;
    };
  }, [address]);

  if (!account) return null;
  const evmNetworks = activeNetworks.filter((n) => n.type === 'evm');
  const solanaNetworks = activeNetworks.filter((n) => n.type === 'solana');

  return (
    <Screen>
      <TopBar title="Receive" />
      <div className="screen-body stack">
        {account.evmAddress && account.solanaAddress && (
          <div className="segmented" role="tablist">
            <button role="tab" aria-selected={chain === 'evm'} className={chain === 'evm' ? 'active' : ''} onClick={() => setChain('evm')}>
              EVM
            </button>
            <button
              role="tab"
              aria-selected={chain === 'solana'}
              className={chain === 'solana' ? 'active' : ''}
              onClick={() => setChain('solana')}
            >
              Solana
            </button>
          </div>
        )}

        {address ? (
          <>
            <div className="qr">
              {qr ? (
                <img src={qr} width={200} height={200} alt={`QR code for ${address}`} />
              ) : (
                <div className="skeleton" style={{ width: 200, height: 200 }} />
              )}
            </div>
            <div className="panel row" style={{ gap: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small muted">{account.name} · {chain === 'evm' ? 'EVM' : 'Solana'} address</div>
                <div className="mono" data-testid="receive-address">
                  {address}
                </div>
              </div>
              <CopyButton text={address} label="Copy address" />
            </div>
            {chain === 'evm' ? (
              <div className="notice info">
                This address works on every EVM network
                {evmNetworks.length > 0 && ':'}
                {evmNetworks.length > 0 && (
                  <div className="row" style={{ flexWrap: 'wrap', gap: '4px 12px', marginTop: 6 }}>
                    {evmNetworks.map((n) => (
                      <span key={n.id} className="row" style={{ gap: 5 }}>
                        <NetworkDot network={n} />
                        {n.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="notice info">
                Only send assets on {solanaNetworks.map((n) => n.name).join(' or ') || 'Solana'} to this address. Tokens sent from other
                networks will be lost.
              </div>
            )}
          </>
        ) : (
          <div className="notice">
            This account has no {chain === 'evm' ? 'EVM' : 'Solana'} address. Add an account from a recovery phrase to get both.
          </div>
        )}
      </div>
    </Screen>
  );
}
