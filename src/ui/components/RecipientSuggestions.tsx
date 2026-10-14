import { useEffect, useState } from 'react';
import type { Account, ChainType, Contact } from '../../core/types';
import { sameAddress } from '../../core/address';
import { shortAddress } from '../../core/format';
import { api } from '../lib/api';
import { useWallet } from '../lib/store';
import { Avatar } from './ui';

/** Contacts, the user's other accounts, and recent recipients for the given chain type. */
export function RecipientSuggestions({
  chainType,
  exclude,
  onPick,
}: {
  chainType: ChainType;
  exclude?: string;
  onPick: (address: string) => void;
}) {
  const { state } = useWallet();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [recent, setRecent] = useState<{ address: string }[]>([]);

  useEffect(() => {
    let stale = false;
    Promise.all([api.getContacts(), api.getRecentRecipients(chainType)])
      .then(([c, r]) => {
        if (stale) return;
        setContacts(c.filter((x) => x.chainType === chainType));
        setRecent(r);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [chainType]);

  const addr = (a: Account) => (chainType === 'evm' ? a.evmAddress : a.solanaAddress);
  const mine = state.accounts.filter((a) => addr(a) && !sameAddress(addr(a), exclude) && !a.hidden);
  const nameFor = (address: string) =>
    contacts.find((c) => sameAddress(c.address, address))?.name ??
    state.accounts.find((a) => sameAddress(addr(a), address))?.name;
  const recentOnly = recent.filter((r) => !nameFor(r.address));

  const rows: { key: string; title: string; address: string }[] = [
    ...contacts.map((c) => ({ key: `c:${c.id}`, title: c.name, address: c.address })),
    ...mine.map((a) => ({ key: `a:${a.id}`, title: a.name, address: addr(a)! })),
    ...recentOnly.map((r) => ({ key: `r:${r.address}`, title: 'Recent', address: r.address })),
  ];
  if (!rows.length) return null;

  return (
    <div>
      <div className="field-label" style={{ marginBottom: 2 }}>
        Contacts and your accounts
      </div>
      <div className="list">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            className="list-item"
            style={{ minHeight: 48, padding: '7px 0' }}
            onClick={() => onPick(r.address)}
          >
            <Avatar seed={r.address} size={28} />
            <div className="main">
              <div className="title">{r.title}</div>
              <div className="sub">{shortAddress(r.address, 6)}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
