# Publishing to the Chrome Web Store

Everything needed for a submission: the package, the listing text, the images, and the answers for the Privacy practices tab.

## Before the first submission

- [ ] A Chrome Web Store developer account for the publisher (one-time $5 fee, 2-step verification on the Google account): https://chrome.google.com/webstore/devconsole
- [ ] A verified contact email on the account (Account tab).
- [ ] The trader declaration (Account tab). Kairos publishing a product is a trader under the EU Digital Services Act, which shows a business address and contact on the listing.
- [ ] **The privacy policy at a public URL.** The store requires one for a wallet. Fill in the contact in [`PRIVACY.md`](../PRIVACY.md), then host it on a public page (for example kairos.trade/wallet/privacy). This repo is private, so a GitHub link won't work.
- [ ] Decide visibility: **Unlisted** (only people with the link can install, good for the partner pilot) or **Public**.

## 1. Build the package

```bash
pnpm install
pnpm check            # typecheck, lint, format, unit tests
pnpm package          # builds and writes release/duo-wallet-<version>.zip
```

`pnpm package` refuses to build when `package.json` and `public/manifest.json` have different versions. It also checks that the build has no source maps or remote scripts, and that every file the manifest names is included. For each new upload, bump `version` in **both** files (the store rejects a version it has seen before).

Upload the zip under **Package → Upload new package**.

## 2. Store listing

| Field                  | Value                                                                             |
| ---------------------- | --------------------------------------------------------------------------------- |
| Name                   | Duo Wallet (from the manifest)                                                    |
| Summary (≤132 chars)   | A self-custodial wallet for Ethereum, EVM chains and Solana. (from the manifest)  |
| Category               | Tools                                                                             |
| Language               | English                                                                           |
| Store icon             | [`store/icon-128.png`](../store/icon-128.png) (96px artwork in a 128px square)    |
| Screenshots (1280×800) | [`store/screenshot-1-home.png` … `screenshot-5-connect.png`](../store/), in order |
| Small promo tile       | [`store/promo-small-440x280.png`](../store/promo-small-440x280.png)               |
| Marquee (optional)     | [`store/promo-marquee-1400x560.png`](../store/promo-marquee-1400x560.png)         |
| Homepage URL           | The public product page, if there is one                                          |
| Support URL            | Where users should go for help                                                    |

**Description** (paste as is):

```
Duo Wallet is a self-custodial wallet for Ethereum, EVM chains and Solana. One recovery phrase gives every account both an EVM and a Solana address, so you can hold, send and trade on both from one place.

• Send and receive native coins, ERC-20 and SPL tokens, with the exact amount and network fee shown before you sign
• Swap on the same chain, or bridge between chains, with token approvals for the exact amount only
• Trade prediction markets: browse live Polymarket markets, read the order book, and buy or sell outcomes from your wallet
• Connect to Ethereum and Solana apps. You approve each site and each request yourself
• Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Solana, plus testnets and custom networks
• Multiple recovery phrases and accounts, an address book, and imported private keys

Your keys stay on your device, encrypted with your password. Duo Wallet has no accounts, no analytics and no ads.
```

## 3. Privacy practices tab

**Single purpose**

```
Duo Wallet is a cryptocurrency wallet: it holds the user's keys and lets them view balances, send, swap and bridge tokens, trade prediction markets, and connect to websites that request a wallet.
```

**Permission justifications**

| Permission                            | Justification                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                             | Stores the user's encrypted wallet, settings and transaction records on the device, and holds the unlock key in session storage while the wallet is unlocked.                                                                                                                                  |
| `alarms`                              | Locks the wallet automatically after the inactivity period the user chooses.                                                                                                                                                                                                                   |
| `declarativeNetRequestWithHostAccess` | One session rule removes the Origin header from requests the extension itself makes, because some public Solana RPC nodes reject requests with a browser origin. The rule is limited to the extension's own requests (initiatorDomains is the extension id) and never touches website traffic. |
| Host permissions (`<all_urls>`)       | The wallet calls blockchain RPC nodes, explorers, price and swap APIs, including custom RPC URLs the user adds, which can be any host. The same access lets the Origin rule above apply to those requests.                                                                                     |
| Content scripts on http/https pages   | Injects the standard Ethereum (EIP-1193/EIP-6963) and Solana (Wallet Standard) provider so websites can ask to connect. Pages get nothing until the user approves the connection, and no page content is read.                                                                                 |

**Remote code:** No. All JavaScript ships in the package. The extension's CSP is `script-src 'self' 'wasm-unsafe-eval'`, and `pnpm package` rejects a build with remote scripts.

**Data usage.** Tick these, as the wallet handles them to provide its features (see [`PRIVACY.md`](../PRIVACY.md)):

- Financial and payment information: wallet addresses, balances, transactions
- Authentication information: the wallet password and keys, kept encrypted on the device and never transmitted
- Website content: requests from sites the user connects to (connections, signatures, transactions)

Leave the others unticked: personally identifiable info, health, personal communications, location, web history, user activity.

Certify all three: not sold to third parties, not used or transferred for purposes unrelated to the single purpose, not used to determine creditworthiness or for lending.

**Privacy policy URL:** the public URL where `PRIVACY.md` is hosted.

## 4. Notes for the reviewer

Paste into **Test instructions** (the field reviewers read):

```
No account or login is needed.
1. Click the toolbar icon, choose "Create a new wallet", set a password and confirm the recovery phrase.
2. The home screen shows balances (empty for a new wallet). Receive shows the EVM and Solana addresses.
3. To try sending without real funds: Settings → turn on "Show testnets", make sure Sepolia is on under Settings → Networks, then use any Sepolia faucet.
4. Predict (home screen) lists live prediction markets and opens a market's chart and order book without funds. Trading needs pUSD on Polygon.
5. dApp connection: open https://app.uniswap.org or https://jup.ag and click Connect. Duo Wallet appears in the wallet list and asks for approval in its own window.
```

## 5. After review

Reviews usually take a few days; extensions with broad host access can take longer. If a review asks about a permission, the justifications above are the answers. To update, bump the version in `package.json` and `public/manifest.json`, run `pnpm package` and upload the new zip.

## Regenerating the images

```bash
pnpm icons          # public/icons/* and store/icon-128.png
pnpm screenshots    # docs/screenshots (wallet screens, local anvil chain)
pnpm store-assets   # store/*.png (captures fresh prediction screens from live market data)
```
