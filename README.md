# Duo Wallet

A self-custodial Chrome extension wallet for Ethereum, EVM chains and Solana. One recovery phrase gives every account both an EVM address and a Solana address.

## Features

- **Accounts:** create or import a recovery phrase (12 or 24 words). You can also import a raw private key: EVM hex, or Solana base58 or JSON byte array.
- **Multiple accounts and phrases:** derive as many accounts per phrase as you need, and hold several phrases side by side. Accounts can be renamed, hidden and removed, or restored at a specific index.
- **Derivation paths:** the standard ones, so the same phrase shows the same addresses as in MetaMask (`m/44'/60'/0'/0/i`) and Phantom (`m/44'/501'/i'/0'`).
- **Portfolio:**
  - Native coins and tokens on every enabled network, with USD prices from DefiLlama.
  - ERC-20 tokens are found automatically through Blockscout.
  - All SPL and Token-2022 balances are read directly over Solana RPC.
- **Send:** native coins, ERC-20 and SPL tokens. Before you confirm, a review screen shows the fee, any rent the recipient's token account needs, and warnings. There's also a max-amount button, an address book and a recent-recipients list.
- **Receive:** QR code and copyable address for each chain type.
- **Swap:** same-chain swaps through LI.FI (EVM and Solana) or Jupiter (Solana). ERC-20 approvals are handled for you, and slippage is configurable.
- **Bridge:** between any two networks LI.FI supports, including EVM to Solana and back, with live bridge status tracking.
- **History:**
  - EVM networks use an indexer: Blockscout, or any Etherscan-compatible API.
  - Solana history comes from RPC (`getSignaturesForAddress`).
  - Transactions sent from this wallet are tracked locally until they confirm.
- **dApp connections:**
  - EVM: EIP-1193 provider (`window.ethereum`) with EIP-6963 discovery.
  - Solana: Wallet Standard (connect, sign message, sign transaction, sign and send).
  - Every connection, signature and transaction goes through an approval window. Connected sites can be reviewed and disconnected.
- **Security:**
  - Secrets are encrypted with AES-256-GCM, using a key derived from your password with PBKDF2-SHA256 (600k iterations).
  - The wallet auto-locks after a period of inactivity.
  - Showing a recovery phrase or private key requires your password. You can also change the password or reset the wallet.
- **Everything is configurable:**
  - Networks (RPC URL, chain id, explorer, history provider, price ids, colour), including adding custom EVM networks and Solana clusters.
  - Swap, bridge and price endpoints, plus optional API keys.

All defaults are public, keyless endpoints, and every one can be changed under **Settings → Networks** and **Settings → Swap & data providers**.

## Getting started

```bash
pnpm install
pnpm build          # outputs the unpacked extension to dist/
```

Load it in Chrome: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `dist/` folder. The onboarding tab opens automatically on first install.

`pnpm dev` rebuilds on change. After a rebuild, reload the extension from `chrome://extensions`.

## Testing

| Command | What it runs |
| --- | --- |
| `pnpm test:unit` | ~390 unit tests: crypto and derivation vectors (SLIP-0010, BIP-44), vault, formatting, history parsers, LI.FI/Jupiter clients, WalletService, dApp controller. |
| `pnpm test:integration` | WalletService and the dApp controller against real local chains: **anvil** for EVM, and a JSON-RPC shim over **LiteSVM** for Solana. Covers sends, ERC-20 and SPL transfers (including creating the recipient's token account), an approve-then-swap flow, signing, and dApp transactions. |
| `pnpm test:e2e` | Builds the extension and drives it in Chromium with Playwright: onboarding, lock/unlock, network editing, sending ETH on anvil, receive, contacts, and connecting and signing from a test dApp. |
| `pnpm test` | Unit and integration tests. |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm screenshots` | Captures the main screens into `test-results/screens` for design review. |

None of the tests use the public internet. Anvil ships as an npm dependency (`@foundry-rs/anvil`), and LiteSVM runs in-process.

## Architecture

```
src/
  core/            Chrome-agnostic wallet logic (unit/integration tested in Node)
    crypto/        vault encryption, SLIP-0010
    keyring/       mnemonic + key derivation, key import parsing
    evm/ solana/   chain clients (viem, @solana/web3.js)
    history/       Blockscout / Etherscan / Solana RPC parsers, merge with local records
    swap/          LI.FI (swaps + bridges, EVM + Solana) and Jupiter clients
    dapp/          DappController: EIP-1193 + Solana wallet-standard request handling
    wallet/        WalletService: accounts, vault, settings, balances, send, swap, history
  background/      MV3 service worker: message router, approval windows, auto-lock, dApp ports
  content/         isolated-world relay between page and background
  inpage/          MAIN-world EIP-1193 provider + EIP-6963 + wallet-standard registration
  shared/          message/API types shared by background and UI
  ui/              React popup (360×600) and full-tab views
```

Signing happens only in the background service worker. The popup calls an allow-listed set of `WalletService` methods over `chrome.runtime` messaging. The background rejects these calls unless they come from one of the extension's own pages, so content scripts and websites can't reach them.

While unlocked, the AES key is kept in `chrome.storage.session` (in memory only, and limited to trusted extension contexts). That way, the MV3 service worker can restart without asking for your password again. Locking, the auto-lock timer, or closing the browser clears it.

Some public RPCs, `api.mainnet-beta.solana.com` among them, reject requests that carry a browser `Origin`. A session `declarativeNetRequest` rule strips that header from requests the extension itself makes. Websites' requests are not affected.

## Known limitations

- **History coverage:** BNB Chain has no keyless history API, so its default history covers only transactions sent from this wallet. You can add an Etherscan v2 API key under Settings → Networks → BNB Chain → History. Some Blockscout instances also show a bot-check to certain IP ranges; the same setting lets you switch to Etherscan.
- **Aggregators:** LI.FI and Jupiter only route mainnets, so swaps and bridges are turned off on testnets and custom networks.
- **Not supported:** hardware wallets, NFTs, and replacing or cancelling a pending transaction.
