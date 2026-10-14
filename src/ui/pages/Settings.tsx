import { useState, type ReactNode } from 'react';
import type { Settings as WalletSettings } from '../../core/types';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, Toggle, TopBar } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';

const AUTO_LOCK = [1, 5, 15, 30, 60, 240];
const SLIPPAGE_BPS = [10, 50, 100, 300];

function lockLabel(m: number) {
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = m / 60;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

export function Settings() {
  const { state, refresh, toast } = useWallet();
  const s = state.settings;
  const [locking, setLocking] = useState(false);

  const update = async (patch: Partial<Omit<WalletSettings, 'networks'>>) => {
    try {
      await api.updateSettings(patch);
      await refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  // Keep a non-standard saved value selectable instead of silently showing the wrong option.
  const lockOptions = AUTO_LOCK.includes(s.autoLockMinutes) ? AUTO_LOCK : [...AUTO_LOCK, s.autoLockMinutes].sort((a, b) => a - b);
  const slippageOptions = SLIPPAGE_BPS.includes(s.slippageBps) ? SLIPPAGE_BPS : [...SLIPPAGE_BPS, s.slippageBps].sort((a, b) => a - b);

  return (
    <div className="screen">
      <TopBar title="Settings" />
      <div className="screen-body">
        <h2 className="section">General</h2>
        <div className="list">
          <SettingRow title="Auto-lock" sub="Lock after this long without activity">
            <select
              className="select"
              aria-label="Auto-lock"
              style={{ width: 'auto', height: 36 }}
              value={s.autoLockMinutes}
              onChange={(e) => update({ autoLockMinutes: Number(e.target.value) })}
            >
              {lockOptions.map((m) => (
                <option key={m} value={m}>
                  {lockLabel(m)}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title="Default slippage" sub="Used for swaps and bridges">
            <select
              className="select"
              aria-label="Default slippage"
              style={{ width: 'auto', height: 36 }}
              value={s.slippageBps}
              onChange={(e) => update({ slippageBps: Number(e.target.value) })}
            >
              {slippageOptions.map((b) => (
                <option key={b} value={b}>
                  {b / 100}%
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title="Show testnets" sub="Include test networks in balances and pickers">
            <Toggle on={s.showTestnets} onChange={(v) => update({ showTestnets: v })} label="Show testnets" />
          </SettingRow>
          <SettingRow title="Hide zero balances" sub="On a single network; native coins always show">
            <Toggle on={s.hideZeroBalances} onChange={(v) => update({ hideZeroBalances: v })} label="Hide zero balances" />
          </SettingRow>
        </div>

        <h2 className="section">Manage</h2>
        <div className="list">
          <LinkRow icon="layers" title="Networks" sub="RPCs, explorers and custom networks" to="/settings/networks" />
          <LinkRow icon="swap" title="Swap & data providers" sub="LI.FI, Jupiter and price sources" to="/settings/apis" />
          <LinkRow icon="globe" title="Connected sites" sub="Sites that can see your accounts" to="/settings/sites" />
          <LinkRow icon="lock" title="Security & recovery" sub="Password, recovery phrases and reset" to="/settings/security" />
        </div>

        <div style={{ marginTop: 18 }}>
          <Button
            variant="secondary"
            block
            icon="lock"
            loading={locking}
            onClick={async () => {
              setLocking(true);
              try {
                await api.lock();
                await refresh();
              } catch (e) {
                toast((e as Error).message, true);
                setLocking(false);
              }
            }}
          >
            Lock wallet
          </Button>
        </div>
        <div className="small muted center" style={{ marginTop: 14 }}>
          Version {chrome.runtime.getManifest().version}
        </div>
      </div>
    </div>
  );
}

function SettingRow({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="list-item">
      <div className="main">
        <div className="title">{title}</div>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function LinkRow({ icon, title, sub, to }: { icon: IconName; title: string; sub: string; to: string }) {
  return (
    <button className="list-item" onClick={() => navigate(to)}>
      <Icon name={icon} />
      <div className="main">
        <div className="title">{title}</div>
        <div className="sub">{sub}</div>
      </div>
      <Icon name="chevronRight" size={16} />
    </button>
  );
}
