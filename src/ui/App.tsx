import { useEffect, type ReactElement } from 'react';
import { useRoute, navigate } from './lib/router';
import { useMaybeWallet } from './lib/store';
import { bg } from './lib/api';
import { Spinner, Toasts } from './components/ui';
import { Onboarding } from './pages/Onboarding';
import { Unlock } from './pages/Unlock';
import { Home } from './pages/Home';
import { Send } from './pages/Send';
import { Receive } from './pages/Receive';
import { Swap } from './pages/Swap';
import { Accounts } from './pages/Accounts';
import { AddAccount } from './pages/AddAccount';
import { AccountDetails } from './pages/AccountDetails';
import { Settings } from './pages/Settings';
import { Networks } from './pages/Networks';
import { NetworkEdit } from './pages/NetworkEdit';
import { ApiSettings } from './pages/ApiSettings';
import { Security } from './pages/Security';
import { ConnectedSites } from './pages/ConnectedSites';
import { AddToken } from './pages/AddToken';
import { TxDetails } from './pages/TxDetails';
import { Contacts } from './pages/Contacts';
import { Predict } from './pages/Predict';
import { PredictEvent } from './pages/PredictEvent';
import { PredictMarket } from './pages/PredictMarket';
import { Approve } from './pages/Approve';

const ROUTES: Record<string, () => ReactElement | null> = {
  '/': Home,
  '/send': Send,
  '/receive': Receive,
  '/swap': Swap,
  '/accounts': Accounts,
  '/accounts/add': AddAccount,
  '/account': AccountDetails,
  '/settings': Settings,
  '/settings/networks': Networks,
  '/settings/network': NetworkEdit,
  '/settings/apis': ApiSettings,
  '/settings/security': Security,
  '/settings/sites': ConnectedSites,
  '/settings/contacts': Contacts,
  '/predict': Predict,
  '/predict/event': PredictEvent,
  '/predict/market': PredictMarket,
  '/tokens/add': AddToken,
  '/tx': TxDetails,
};

export function App() {
  const { state, stale } = useMaybeWallet();
  const route = useRoute();

  useEffect(() => {
    // Full-page layout when opened in a tab (onboarding, expand view) rather than the toolbar popup.
    const isTab = route.query.get('tab') === '1' || window.innerWidth > 420;
    document.body.classList.toggle('tab', isTab);
  }, [route]);

  useEffect(() => {
    if (state && !state.initialized && route.path !== '/onboarding') navigate('/onboarding', undefined, true);
  }, [state, route.path]);

  useEffect(() => {
    // Pending dApp requests take priority when the popup opens (e.g. if the approval window was closed or blocked).
    if (!state?.initialized || route.path === '/approve' || route.path === '/onboarding') return;
    bg('approvals.list')
      .then((list) => list.length && navigate('/approve', undefined, true))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.initialized]);

  if (!state) {
    return (
      <div className="screen" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size={24} />
      </div>
    );
  }

  let page: ReactElement;
  if (!state.initialized || route.path === '/onboarding') page = <Onboarding />;
  else if (route.path === '/approve') page = <Approve />;
  else if (!state.unlocked) page = <Unlock />;
  else {
    const Page = ROUTES[route.path] ?? Home;
    page = <Page />;
  }
  return (
    <>
      {stale && (
        <div
          className="notice info row"
          role="alert"
          style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 60, borderRadius: 0, justifyContent: 'space-between' }}
        >
          <span>The wallet was updated. Reload to finish.</span>
          <button className="btn small" onClick={() => chrome.runtime.reload()}>
            Reload
          </button>
        </div>
      )}
      {page}
      <Toasts />
    </>
  );
}
