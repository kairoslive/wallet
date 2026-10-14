import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { RouterProvider } from './lib/router';
import { WalletProvider } from './lib/store';

createRoot(document.getElementById('root')!).render(
  <RouterProvider>
    <WalletProvider>
      <App />
    </WalletProvider>
  </RouterProvider>,
);
