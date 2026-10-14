# Security

## Reporting a vulnerability

Please report security issues privately to the Kairos team rather than opening a public issue or pull request. Include steps to reproduce, the affected version or commit, and the impact you expect. We'll acknowledge the report and keep you updated on the fix.

## Security model

Duo Wallet is self-custodial: keys are generated and stored only on the user's device, and nothing is sent to a Kairos server.

### Key storage

- Recovery phrases and imported private keys are encrypted with **AES-256-GCM**. The key is derived from the user's password with **PBKDF2-SHA256** (600,000 iterations, random salt); every write uses a fresh random IV.
- While unlocked, the derived key is held in `chrome.storage.session`, which is memory-only and readable only by trusted extension contexts. The decrypted secrets live only in service-worker memory.
- Locking, auto-lock (default 15 minutes) or closing the browser clears both. A lock that happens while a service-worker restart is restoring the session always wins.
- Revealing a recovery phrase or private key requires the password.

### Isolation

- Wallet operations are exposed only to the extension's own pages. Content scripts and websites cannot call them, and the extension declares no web-accessible resources.
- dApps talk to the wallet through a port whose origin is taken from Chrome, not from the page. Opaque (`null`) origins are refused.
- Site permissions are per origin and per chain family; an EVM connection doesn't reveal Solana addresses.

### User approval

- Connecting, signing messages or typed data, sending transactions, adding networks and adding tokens all require explicit approval in a separate window. The approve button ignores clicks for a moment after each request appears, so a double-click can't approve a queued request.
- Approval screens decode common token calls and flag unlimited approvals and `setApprovalForAll`. They also warn when a transaction is expected to fail.
- `eth_sign` is disabled. `personal_sign` uses the EIP-191 prefix. Typed data must match the active chain.
- Solana `signMessage` refuses bytes that parse as a transaction message.

### Transactions built by the wallet

- Send previews re-check balances and fees, and reject sending to token-account addresses on Solana.
- Swap and bridge routes are checked for the expected chain and fee payer before signing. ERC-20 approvals are for the exact swap amount, never unlimited. An expired Solana route is never silently replaced with a new quote.

### Prediction markets

Kairos builds every payload the wallet signs for prediction markets. Each request is checked against the action the user started before it is signed:

- Polygon only.
- Ownership proofs and token-approval batches are allowed only during setup.
- Approvals may only target pUSD and the outcome-token contract, for known exchange spenders.
- Orders must match the outcome, side and amount the user confirmed.

Deposits through Halliday are only sent after the deposit instruction matches the quote (token, chain, amount). Halliday's owner verification is refused if it looks like a token permission.

Anything else is refused. See [docs/PREDICTION_MARKETS.md](docs/PREDICTION_MARKETS.md#signature-validation).

### Third-party services

Balances, history, prices and routes come from the configured public endpoints (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md)). These services can see the addresses being queried, but never keys. The approval window does not load remote favicons, so the sites a user visits aren't leaked to third parties.

## Out of scope

- A compromised operating system or browser profile.
- A user approving a malicious request after it has been shown to them.
- A malicious RPC endpoint that the user configured themselves.
