# dApp integration guide

Duo Wallet exposes standard interfaces, so most dApps work without Duo-specific code. This page lists exactly what is supported.

## Detecting the wallet

### EVM: EIP-6963 (recommended)

```js
window.addEventListener('eip6963:announceProvider', (event) => {
  const { info, provider } = event.detail;
  if (info.rdns === 'app.duowallet') {
    // info.name === 'Duo Wallet', info.icon is an SVG data URI
  }
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
```

Libraries such as wagmi, RainbowKit, Web3Modal/AppKit and ConnectKit pick this up automatically.

### EVM: `window.ethereum`

Duo sets `window.ethereum` only if no other wallet has already done so, and marks it with `isDuoWallet: true`. It is always reachable as `window.duoWallet.ethereum`.

### Solana: Wallet Standard

Duo registers a Wallet Standard wallet named **Duo Wallet**, which `@solana/wallet-adapter` and other Wallet Standard-aware libraries discover automatically.

|                      |                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Chains               | `solana:mainnet`, `solana:devnet`, `solana:testnet`                                                                                           |
| Features             | `standard:connect`, `standard:disconnect`, `standard:events`, `solana:signMessage`, `solana:signTransaction`, `solana:signAndSendTransaction` |
| Transaction versions | `legacy`, `0`                                                                                                                                 |

## EVM methods

### Accounts and permissions

| Method                      | Behavior                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eth_requestAccounts`       | Prompts the user to connect (choosing one or more accounts) if the site isn't connected yet. Returns lowercase addresses, with the wallet's active account first. |
| `eth_accounts`              | Connected accounts, or `[]` if not connected or the wallet is locked.                                                                                             |
| `wallet_requestPermissions` | Always prompts; supports `eth_accounts`.                                                                                                                          |
| `wallet_getPermissions`     | `[{ parentCapability: 'eth_accounts' }]` when connected.                                                                                                          |
| `wallet_revokePermissions`  | Disconnects the site.                                                                                                                                             |

### Chains

| Method                       | Behavior                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `eth_chainId`, `net_version` | The site's selected network. Each site keeps its own selection, defaulting to Ethereum.                                    |
| `wallet_switchEthereumChain` | Switches immediately if the chain is configured; otherwise returns error `4902`.                                           |
| `wallet_addEthereumChain`    | Prompts the user, verifies that the RPC reports the claimed chain id, then switches. `nativeCurrency.decimals` must be 18. |

### Signing and transactions

| Method                             | Behavior                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `personal_sign`                    | Prompts. Accepts hex or plain-text messages, with params in either order.                                                                                                                                                |
| `eth_signTypedData_v4` (and `_v3`) | Prompts. `domain.chainId`, if present, must match the site's selected chain.                                                                                                                                             |
| `eth_sendTransaction`              | Prompts with the amount, fee and decoded token calls (`approve`, `transfer`, `transferFrom`, `increaseAllowance`, `setApprovalForAll`; unlimited approvals are flagged), then signs and broadcasts. Returns the tx hash. |
| `wallet_watchAsset`                | Prompts to add an ERC-20 token (`type: 'ERC20'`).                                                                                                                                                                        |
| `eth_sign`                         | Not supported (unsafe), returns `4200`.                                                                                                                                                                                  |

### Read-only (proxied to the site's network RPC)

`eth_blockNumber`, `eth_call`, `eth_estimateGas`, `eth_feeHistory`, `eth_gasPrice`, `eth_getBalance`, `eth_getBlockByHash`, `eth_getBlockByNumber`, `eth_getBlockTransactionCountByHash`, `eth_getBlockTransactionCountByNumber`, `eth_getCode`, `eth_getLogs`, `eth_getProof`, `eth_getStorageAt`, `eth_getTransactionByHash`, `eth_getTransactionCount`, `eth_getTransactionReceipt`, `eth_maxPriorityFeePerGas`, `eth_syncing`, `net_listening`, `web3_clientVersion`.

### Events

| Event             | When                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `connect`         | Provider initialized (`{ chainId }`).                                                           |
| `accountsChanged` | The user switched the active account, connected or disconnected the site, or locked the wallet. |
| `chainChanged`    | The site's selected network changed.                                                            |

Legacy `enable()`, `send()` and `sendAsync()` are provided for older libraries.

## Solana behavior

- **`connect`:** prompts unless already connected. `{ silent: true }` (onlyIfTrusted) never prompts and fails if the site isn't connected.
- **`signMessage`:** shows the message as text. Bytes that parse as a serialized transaction message are refused, so a transaction can't be disguised as a message.
- **`signTransaction`:** signs one or more transactions and returns them without broadcasting.
- **`signAndSendTransaction`:** signs and broadcasts through the wallet's RPC for the requested chain (`solana:mainnet` uses the configured Solana mainnet network).
- **`disconnect`:** revokes the site's permission.

Connections are per chain family: connecting over EVM does not reveal the account's Solana address, and vice versa.

## Errors

Errors follow EIP-1193 / JSON-RPC codes (Solana requests use the same codes):

| Code     | Meaning                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| `4001`   | User rejected the request (or closed the approval window, or it timed out after 10 minutes). |
| `4100`   | Account or method not authorized: connect first, or the requested address isn't connected.   |
| `4200`   | Unsupported method.                                                                          |
| `4900`   | Wallet disconnected (extension reloaded or service worker restarted mid-request); retry.     |
| `4902`   | Unrecognized chain: call `wallet_addEthereumChain` first.                                    |
| `-32602` | Invalid parameters.                                                                          |
| `-32603` | Internal error (message describes the cause, e.g. RPC failure).                              |

## Testing your integration locally

1. `pnpm build` and load `dist/` unpacked (see the [README](../README.md#quick-start)).
2. The content script is injected on all `http://` and `https://` pages, including `localhost`.
3. To test against a local chain, add it under **Settings → Networks → Add EVM network** (for example anvil at `http://127.0.0.1:8545`, chain id `31337`), or approve `wallet_addEthereumChain` from your dApp.
