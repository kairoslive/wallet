# Configuration

All settings are edited in the extension UI and stored in `chrome.storage.local`. Nothing is configured at build time. The defaults below come from `src/core/networks.ts` and `src/core/wallet/defaults.ts`; every value can be changed per install.

## Default networks

### Mainnets

| Network           | Chain ID | RPC                                      | History provider                     |
| ----------------- | -------- | ---------------------------------------- | ------------------------------------ |
| Ethereum          | 1        | `https://ethereum-rpc.publicnode.com`    | Blockscout `eth.blockscout.com`      |
| Base              | 8453     | `https://mainnet.base.org`               | Blockscout `base.blockscout.com`     |
| Arbitrum One      | 42161    | `https://arb1.arbitrum.io/rpc`           | Blockscout `arbitrum.blockscout.com` |
| OP Mainnet        | 10       | `https://mainnet.optimism.io`            | Blockscout `explorer.optimism.io`    |
| Polygon           | 137      | `https://polygon-bor-rpc.publicnode.com` | Blockscout `polygon.blockscout.com`  |
| BNB Chain         | 56       | `https://bsc-dataseed.bnbchain.org`      | None (wallet-sent transactions only) |
| Avalanche C-Chain | 43114    | `https://api.avax.network/ext/bc/C/rpc`  | Routescan (Etherscan-compatible)     |
| Solana            | —        | `https://api.mainnet-beta.solana.com`    | RPC (`getSignaturesForAddress`)      |

### Testnets

Testnets are hidden until **Settings → Show testnets** is on.

| Network       | Chain ID | RPC                                           | History provider                         |
| ------------- | -------- | --------------------------------------------- | ---------------------------------------- |
| Sepolia       | 11155111 | `https://ethereum-sepolia-rpc.publicnode.com` | Blockscout `eth-sepolia.blockscout.com`  |
| Base Sepolia  | 84532    | `https://sepolia.base.org`                    | Blockscout `base-sepolia.blockscout.com` |
| Solana Devnet | —        | `https://api.devnet.solana.com`               | RPC                                      |

## Network fields

Edit them under **Settings → Networks**, then tap a network.

| Field                     | Purpose                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RPC URL                   | JSON-RPC endpoint. Use **Test** to check connectivity and the reported chain id.                                                                                         |
| Chain ID (EVM)            | Must match the RPC; used for signing and dApp `eth_chainId`.                                                                                                             |
| Cluster (Solana)          | `mainnet-beta`, `devnet`, `testnet` or `custom`. Maps dApp chains (`solana:mainnet`, …) to networks and sets explorer links.                                             |
| Explorer URL              | Base URL for transaction and address links.                                                                                                                              |
| History provider (EVM)    | **Blockscout** (instance URL), **Etherscan** (any Etherscan-compatible API URL plus optional API key; e.g. Etherscan v2 `https://api.etherscan.io/v2/api`), or **None**. |
| Price ids                 | DefiLlama key for the native coin (e.g. `coingecko:ethereum`) and the chain slug for token prices (e.g. `base`).                                                         |
| LI.FI chain id            | Enables swaps and bridges on the network. Leave empty to disable them.                                                                                                   |
| Enabled / Testnet / Color | Visibility and display.                                                                                                                                                  |

Custom EVM networks and Solana clusters can be added from the same screen. dApps can also propose EVM networks via `wallet_addEthereumChain`, which the user must approve.

## Service endpoints

Edit them under **Settings → Swap & data providers**.

| Setting              | Default                   | Notes                                                   |
| -------------------- | ------------------------- | ------------------------------------------------------- |
| LI.FI API URL        | `https://li.quest`        | Swaps (EVM and Solana) and all bridges.                 |
| LI.FI API key        | —                         | Optional; raises rate limits. Sent as `x-lifi-api-key`. |
| LI.FI integrator     | `duo-wallet`              | Identifies the wallet to LI.FI.                         |
| Jupiter API URL      | `https://lite-api.jup.ag` | Solana swaps; also token metadata lookups.              |
| Jupiter API key      | —                         | Optional; required if pointing at `api.jup.ag`.         |
| Solana swaps use     | Jupiter                   | Jupiter or LI.FI for same-chain Solana swaps.           |
| DefiLlama prices URL | `https://coins.llama.fi`  | USD prices for coins and tokens.                        |

## Prediction markets (Kairos)

Edit them under **Settings → Swap & data providers → Prediction markets (Kairos)**. Staging is the default during the pilot; see [PREDICTION_MARKETS.md](PREDICTION_MARKETS.md#configuration) for production values.

| Setting         | Default                                  |
| --------------- | ---------------------------------------- |
| Enabled         | On                                       |
| Partner id      | `wallet-pilot`                           |
| Wallet API URL  | `https://staging-execution.kairos.trade` |
| Data API URL    | `https://staging-data.kairos.trade`      |
| Market data URL | `https://staging-md.kairos.trade`        |

## Wallet preferences

Edit them under **Settings**.

| Setting            | Default                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| Auto-lock          | 15 minutes of inactivity                                                       |
| Default slippage   | 0.5%                                                                           |
| Show testnets      | Off                                                                            |
| Hide zero balances | Off (single-network view; the "All networks" view always hides empty balances) |
