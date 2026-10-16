# Duo Wallet privacy policy

_Last updated: October 16, 2026_

Duo Wallet is a self-custodial browser wallet for Ethereum, other EVM chains and Solana, published by Kairos. This policy explains what the extension stores, what it sends and to whom.

## The short version

- Your recovery phrase, private keys and password never leave your device.
- Duo Wallet has no accounts, no analytics, no tracking and no ads.
- To show balances, build transactions and trade, the wallet sends your **public** wallet addresses and the details of the action you take to the blockchain and market services listed below.
- We do not sell or share your data, and we do not use it for anything except running the features you use.

## What stays on your device

Stored in the browser's extension storage on your computer:

- **Recovery phrases and imported private keys**, encrypted with AES-256-GCM under a key derived from your password (PBKDF2-SHA256, 600,000 iterations). Your password itself is never stored.
- **Settings**: networks, enabled tokens, the address book, connected sites and their permissions, provider URLs.
- **Your own transaction records**, so recent activity shows instantly.
- **While unlocked**, the key that decrypts your wallet and, if you use prediction markets, a read-only sign-in token for your Kairos orders and positions. These are held in session storage and are cleared when the wallet locks or the browser closes.

Uninstalling the extension deletes all of it. Keep your recovery phrase: without it, a deleted wallet can't be restored.

## What is sent, and to whom

The wallet talks to these services directly from your browser. Each one can see the public addresses it is asked about and your IP address, as with any website. None of them ever receives your keys, recovery phrase or password.

| Service                                                                                     | Used for                                                                 | What it receives                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Blockchain RPC nodes (default: public endpoints such as publicnode.com and the chains' own) | Balances, fees, sending signed transactions                              | Your addresses and your signed transactions                                                                                                            |
| Block explorers (Blockscout, Etherscan-family APIs, Routescan)                              | Token discovery and transaction history                                  | Your addresses                                                                                                                                         |
| DefiLlama                                                                                   | USD prices                                                               | Token identifiers only                                                                                                                                 |
| LI.FI and Jupiter                                                                           | Swap and bridge quotes and transactions                                  | Your addresses, the tokens and amounts you choose                                                                                                      |
| Kairos (kairos.trade)                                                                       | Prediction markets: market data, trading-wallet setup, orders, positions | Your EVM address, the orders you place, signatures you approve for those actions, and your trading wallet's address for position history (public data) |
| Halliday                                                                                    | Adding funds for prediction markets with another token or a card         | Your addresses, the amount and token. Card payments happen on Halliday's own checkout page, under Halliday's privacy policy                            |
| Websites you connect to                                                                     | dApp connections                                                         | Only the addresses you approve for that site, and the signatures and transactions you approve                                                          |

You can change the RPC and provider URLs in Settings, and turn prediction markets off. Blockchain transactions are public by nature: anything you send on-chain can be seen by anyone.

## Permissions the extension uses

- **Storage and alarms**: to keep your encrypted wallet and settings, and to lock the wallet automatically after the time you choose.
- **Access to websites** (content script on http and https pages): to offer the standard Ethereum and Solana wallet interfaces that sites use to request a connection. Nothing is read from pages, and a site gets nothing until you approve it.
- **Network request rules for the extension's own requests**: some public Solana RPC nodes reject requests that carry a browser origin header, so the wallet removes that header from its own requests. It does not touch requests made by websites.

## Children

Duo Wallet is not directed to children under 13 and does not knowingly collect information from them.

## Changes

If this policy changes, the new version will be published here with a new date, and significant changes will be noted in the extension's release notes.

## Contact

Questions about this policy: **[support email]**
