import { useState } from 'react';
import type { ChainType, Contact } from '../../core/types';
import { shortAddress } from '../../core/format';
import { api } from '../lib/api';
import { useAsync, useWallet } from '../lib/store';
import { Avatar, Button, CopyButton, Empty, ErrorNote, Field, Screen, Sheet, Spinner, TopBar } from '../components/ui';

export function Contacts() {
  const { toast } = useWallet();
  const { data: contacts, loading, reload } = useAsync(() => api.getContacts(), []);
  const [editing, setEditing] = useState<Partial<Contact> | null>(null);

  return (
    <Screen>
      <TopBar title="Contacts" />
      <div className="screen-body">
        {loading && !contacts && (
          <div className="center" style={{ padding: 24 }}>
            <Spinner />
          </div>
        )}
        {contacts && !contacts.length && (
          <Empty title="No contacts yet">Save addresses you send to often, and pick them from the Send screen.</Empty>
        )}
        <div className="list">
          {contacts?.map((c) => (
            <div key={c.id} className="list-item clickable" onClick={() => setEditing(c)}>
              <Avatar seed={c.address} />
              <div className="main">
                <div className="title">{c.name}</div>
                <div className="sub">
                  {c.chainType === 'evm' ? 'EVM' : 'Solana'} · {shortAddress(c.address, 6)}
                </div>
              </div>
              <CopyButton text={c.address} label={`Copy ${c.name}'s address`} />
            </div>
          ))}
        </div>
      </div>
      <div className="screen-footer">
        <Button icon="plus" onClick={() => setEditing({ chainType: 'evm' })}>
          Add contact
        </Button>
      </div>
      {editing && (
        <ContactSheet
          contact={editing}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            toast(msg);
            await reload();
          }}
        />
      )}
    </Screen>
  );
}

function ContactSheet({
  contact,
  onClose,
  onSaved,
}: {
  contact: Partial<Contact>;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [name, setName] = useState(contact.name ?? '');
  const [address, setAddress] = useState(contact.address ?? '');
  const [chainType, setChainType] = useState<ChainType>(contact.chainType ?? 'evm');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const isNew = !contact.id;

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    try {
      await onSaved(await fn());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet title={isNew ? 'Add contact' : 'Edit contact'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.saveContact({ id: contact.id, name, address, chainType });
            return isNew ? 'Contact added' : 'Contact saved';
          });
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
        <Field label="Name" htmlFor="contact-name">
          <input
            id="contact-name"
            className="input"
            maxLength={40}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Address" htmlFor="contact-address">
          <textarea
            id="contact-address"
            className="textarea mono"
            rows={2}
            spellCheck={false}
            placeholder={chainType === 'evm' ? '0x… address' : 'Solana address'}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <ErrorNote error={error} />
        <div className="row">
          {!isNew && (
            <Button
              type="button"
              variant="secondary"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.removeContact(contact.id!);
                  return 'Contact removed';
                })
              }
            >
              Remove
            </Button>
          )}
          <Button type="submit" style={{ flex: 1 }} loading={busy} disabled={!name.trim() || !address.trim()}>
            {isNew ? 'Add contact' : 'Save'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
