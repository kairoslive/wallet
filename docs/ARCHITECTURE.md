# Architecture

Duo Wallet is a Manifest V3 Chrome extension. All wallet logic lives in `src/core`, a Chrome-agnostic TypeScript library that is unit- and integration-tested in Node. The extension pieces are thin adapters around it.

```
 Web page (dApp)                    Extension
┌───────────────────────┐        ┌──────────────────────────────────────────────┐
│ inpage.js (MAIN world)│        │ background.js (service worker)               │
│  window.ethereum      │        │  ┌────────────────┐   ┌───────────────────┐  │
│  EIP-6963 announce    │        │  │ DappController │──▶│   WalletService   │  │
│  Wallet Standard      │        │  └───────┬────────┘   │  vault · keys     │  │
└──────────┬────────────┘        │          │ approvals  │  balances · send  │  │
           │ window.postMessage  │          ▼            │  swap · history   │  │
┌──────────▼────────────┐  port  │  ┌────────────────┐   └─────────┬─────────┘  │
│ content.js (isolated) │◀──────▶│  │ ChromeApprover │             │            │
└───────────────────────┘        │  └───────┬────────┘             │ RPC / HTTP │
                                 └──────────┼──────────────────────┼────────────┘
                                            │ opens                ▼
                                 ┌──────────▼───────────┐   EVM RPCs, Solana RPC,
                                 │ popup.html (React)   │   Blockscout/Etherscan,
                                 │  toolbar popup       │   LI.FI, Jupiter, DefiLlama
                                 │  approval window     │
                                 └──────────────────────┘
```

## Components

### `WalletService` (`src/core/wallet/service.ts`)

The single owner of wallet state. Responsibilities:

- **Lifecycle:** create, unlock, lock, change password, reset.
- **Recovery phrases and accounts:** add, derive, import, rename, hide, remove, and reveal (password-gated).
- **Settings and networks:** validation, defaults, and custom networks.
- **Data:** tokens, balances and prices; sending (preview → send → wait); history; swaps and bridges.
- **Site data:** dApp permissions and the address book.

It depends only on a `KVStore` interface (`src/core/storage.ts`): `chrome.storage` in the extension, and an in-memory store in tests. Storage read-modify-write sections are serialized with a mutex.

### `DappController` (`src/core/dapp/controller.ts`)

Translates EIP-1193 and Wallet Standard requests into `WalletService` calls. It enforces per-origin, per-chain permissions and asks an `Approver` before anything that reveals accounts or signs. Read-only EVM methods are proxied to the site's selected network RPC.

### Background service worker (`src/background`)

- **Message router:** exposes an allow-listed set of `WalletService` methods (`src/shared/api.ts`) to extension pages only. The sender must be one of the extension's own pages, so content scripts and websites can't call them.
- **dApp ports:** the origin comes from Chrome's `port.sender`, never from the page. Opaque (`null`) origins are refused.
- **`ChromeApprover`:** queues approval requests, shows them in a popup window, and resolves them by request id. Requests time out after 10 minutes.
- **Auto-lock:** a `chrome.alarms` timer that every UI interaction resets.
- **Event broadcast:** pushes `accountsChanged` / `chainChanged` to connected pages when their view of the wallet changes.

### Content script and in-page providers

- `content.js` relays `window.postMessage` traffic to a long-lived `chrome.runtime` port, and reconnects after service-worker restarts.
- `inpage.js` implements `window.ethereum` (EIP-1193), announces itself via EIP-6963, and registers a Wallet Standard Solana wallet. If another wallet already set `window.ethereum`, it leaves it alone; dApps can still find Duo through EIP-6963.

### UI (`src/ui`)

A React app with a tiny hash router. It calls the background through a typed proxy (`src/ui/lib/api.ts`); all values crossing the boundary are JSON-safe (amounts are decimal strings in base units). The same bundle serves the toolbar popup, the full-tab view (`?tab=1`) and the approval window (`#/approve`).

## Keys and encryption

| Item                                    | Where                                   | Form                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recovery phrases, imported private keys | `chrome.storage.local` → `vault`        | AES-256-GCM ciphertext. Key derived with PBKDF2-SHA256 (600k iterations, random 16-byte salt); fresh 12-byte IV per write.                                                              |
| Derived AES key while unlocked          | `chrome.storage.session` → `sessionKey` | Raw key. Session storage is memory-only, restricted to trusted extension contexts, and cleared on lock, auto-lock or browser exit. It lets the MV3 worker restart without re-prompting. |
| Decrypted secrets                       | Service worker memory                   | Present only while unlocked. Signing keys are derived on demand and never sent to the UI, except through the password-gated reveal screens.                                             |

Derivation:

- **EVM:** BIP-32 secp256k1 at `m/44'/60'/0'/0/{i}`.
- **Solana:** SLIP-0010 ed25519 at `m/44'/501'/{i}'/0'`.

Both use the same BIP-39 seed, so account _i_ of a phrase has one address on each chain.

## Storage layout (`chrome.storage.local`)

| Key                           | Contents                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vault`                       | Encrypted secrets (see above).                                                                                                                   |
| `wallet`                      | Recovery-phrase metadata (name, next index, backed-up flag), accounts (name, addresses, derivation index), and the selected account. No secrets. |
| `settings`                    | Networks, endpoints, auto-lock, slippage and display preferences.                                                                                |
| `customTokens`                | Tokens added by the user.                                                                                                                        |
| `txs`                         | Transactions sent from the wallet (most recent 500), with status and bridge tracking.                                                            |
| `permissions`                 | Per-origin connected accounts, chains and selected EVM network.                                                                                  |
| `contacts`                    | Address book.                                                                                                                                    |
| `portfolioCache`, `tokenMeta` | Cosmetic caches for faster first paint.                                                                                                          |

## Transaction flows

**Send.** `previewSend` validates the recipient and balances, estimates the fee (including Solana priority fee and token-account rent), and returns warnings. `send` builds, signs and broadcasts the transaction, records it as pending, and the UI polls `waitForTx`.

**Swap / bridge.**

1. `getQuote` requests a route from LI.FI or Jupiter.
2. `executeQuote` sanity-checks the returned transaction (chain id, fee payer).
3. If an ERC-20 approval is needed, it approves exactly the swap amount. If a non-zero allowance already exists, it resets it to zero first, for USDT-style tokens.
4. It signs and sends the swap and records it.
5. Bridges are then polled through LI.FI's status API until done.

**History.** Indexer results are fetched per network and merged with locally recorded transactions. Local records show immediately while indexers load.

## Network access notes

Some public RPCs, including `api.mainnet-beta.solana.com`, reject requests carrying a browser `Origin` header. At startup the background installs a session `declarativeNetRequest` rule that removes `Origin` from requests initiated by the extension itself. Websites' requests are unaffected.
