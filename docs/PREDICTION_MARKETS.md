# Prediction markets

Duo Wallet lets users browse and trade [Polymarket](https://polymarket.com), [Predict.fun](https://predict.fun) and [Hyperliquid](https://hyperliquid.xyz) (HIP-4 outcome markets) prediction markets through the [Kairos wallet API](https://docs.kairos.trade/wallets/overview). Users keep their keys: Kairos builds each request, the wallet checks and signs it, and Kairos routes it to the venue. There is no Kairos account, API key or login per user.

<p align="center">
  <img src="screenshots/predict.png" width="220" alt="Markets" />
  <img src="screenshots/predict-market.png" width="220" alt="Market detail" />
</p>

## User flow

1. **Browse:** **Predict** on the home screen opens trending markets, with category filters and search. Grouped events (price ladders, multi-candidate races) open to their outcome list. A market shows its chance, a price chart (1H and 6H from 1-minute candles, refreshed every minute; 1D, 1W and 1M), and Yes/No prices.
2. **Set up (once per account):** the user signs twice in the wallet: a proof of wallet ownership, and a batch that approves the Polymarket exchange contracts to use their new **trading wallet** (a smart wallet owned by their address). No gas.
3. **Fund** from **Add funds**, powered by [Halliday](https://docs.halliday.xyz):
   - **From your wallet:** pick any held token on any supported chain (EVM networks or Solana) and see a live quote. The token goes to a one-time Halliday deposit address, and pUSD is delivered to the trading wallet. pUSD on Polygon is sent directly. Sending needs a little gas on the source chain.
   - **Card or bank:** compare onramp quotes (Coinbase, Stripe, MoonPay, Transak) and finish checkout in a new tab. pUSD arrives in the trading wallet when the payment clears.

   Before any funds move, the wallet checks Halliday's deposit instruction against the quote: same token, same chain, no more than the amount entered. Halliday's one-time owner verification (payments of $300 or more) is signed only if it isn't a token permission.

4. **Trade:** buy or sell Yes/No shares.
   - **Market orders (default):** enter an amount. The wallet walks the live order book to show shares, average price and worst price, then sends a fill-and-kill order capped at that worst price (at most 5¢ from the best price). Warnings appear for a wide spread (5¢ or more), a thin book (under $250 within 5¢ of the best price), an order that moves the price (1¢+ or 5%+), high slippage (3¢+ or 15%+), and an order too large to fill within the 5¢ band. The last two are repeated on the confirm screen.
   - **Limit orders:** chosen from the **Order type** dropdown, with a limit price and a time in force (until cancelled, or fill now or cancel).

   One signature, no gas.

5. **Order book:** the book icon (or **Order book** next to the order type) opens a live book per outcome, with asks over bids, depth bars and the spread. It streams from the Kairos market-data WebSocket's `orderbook_slow` topic on the anonymous public tier: grouped deltas about every 150 ms, applied with the documented sequence, baseline and epoch rules, and re-fetching a snapshot on any gap.
6. **Withdraw:** **Withdraw** on the trading balance moves pUSD back to the main wallet without Kairos or Polymarket: the owner pauses the trading wallet, waits out its 60-minute safety timelock (set by the Polymarket factory), then withdraws to itself and resumes it. That's three Polygon transactions from the main wallet (a few cents of POL; the wallet asks for POL with a QR code if there isn't enough). The request is stored, so the wallet can be closed during the wait, and it can be cancelled until the withdrawal runs. Once pUSD arrives, **Convert to USDC** opens Swap (LI.FI routes pUSD → USDC on Polygon). Trading keeps working during the delay; open orders that need the withdrawn pUSD won't fill.
7. **Manage:** the **Positions** and **Orders** tabs list holdings and orders; open orders can be cancelled individually or all at once (one signature each). These reads are private: the first one runs a `login` action, which the wallet signs (one Sign-In with Ethereum message) and swaps for a read-only token valid 24 hours, sent as `Authorization: SIWE <token>`. The token is reused until it expires or the wallet locks, and a rejected token triggers one fresh sign-in. A wallet that isn't set up shows empty lists without signing in.

## Recovering tokens sent by mistake

Only **pUSD** counts as trading balance. If another token (USDC, USDC.e, USDT) is sent to the trading wallet, the **Predictions** screen shows a recovery card. Converting inside the trading wallet needs the venue's relayer, so the wallet uses the deposit wallet's built-in owner exit instead:

1. **Start recovery:** the owner pauses the trading wallet (`pause()`).
2. **Wait:** the factory's timelock is currently 1 hour, measured in block time.
3. **Withdraw to my wallet:** `withdrawERC20` for each stray token back to the owner, then `unpause()` so trading continues normally.
4. **Convert to pUSD and add funds:** opens **Add funds** with the recovered token preselected and converts it into the trading wallet in one step.

Each step is a Polygon transaction from the owner, which only the owner can send, so the owner account pays a few cents of POL in gas. If it has too little, the card shows the exact amount needed with the address and a QR code (or **Bridge POL from another network**), watches the balance, and continues automatically once the POL arrives. The deposit sheet warns that only pUSD on Polygon should be sent.

## One layout for every venue

On a multi-venue node the trading card shows the total across venues, then each venue as the same row: one line with its colour dot, name and balance. A venue that needs something first shows a short action in place of a zero balance (**Set up**, **Add funds**, **Add BNB**); the full explanation is in the row's tooltip and its sheet. Tapping a row opens that venue's sheet, which has the same shape for every venue: balance, where the money sits, what setup involves, and the actions (**Set up trading**, **Add funds**, **Withdraw** where the wallet can). The trade panel's **Set up** / **Add funds** opens the same sheet. Every market, event, position, order and order review carries the same venue tag. A node without the multi-venue API keeps the single Polymarket card.

## Predict.fun

Predict.fun runs on the multi-venue wallet API ([docs](https://docs.kairos.trade/wallets/trade)). The wallet sends `X-Kairos-Wallet-Api: 2` on every wallet API request. A node that predates it ignores the header and serves Polymarket only, and the wallet then shows Predict.fun markets read-only ("This Kairos node doesn't trade Predict.fun yet").

- **Browse:** **Markets** lists every venue together by default (**All**, merged by 24h volume, each row marked with its venue's dot), or one venue at a time. Predict.fun markets use the same data and market-data APIs with `provider=predictfun`, including the live order book. Inside the wallet a Predict.fun market is keyed `predictfun:<market_id>`; Polymarket keeps its bare id, so existing links still work.
- **Funds:** Predict.fun trades **USDT on BNB Chain from the wallet itself**, with no trading wallet. Its balance is a row on the trading card, like every venue's; its sheet's **Add funds** bridges to USDT on BNB Chain.
- **Setup:** happens inside the first Predict.fun order, and the order review says so. The wallet sends Predict.fun's 12 one-time approvals from its own address on BNB Chain (one transaction each, paid in BNB), then signs Predict.fun's login challenge. Kairos trades that signature for the venue session it uses to place and watch orders. The **Set up trading** button on a multi-venue node sets up Polymarket only (`venues: ['polymarket']`), so nobody spends BNB without placing a Predict.fun order.
- **Orders:** the wallet signs Predict.fun's EIP-712 `Order` on chain 56. A resting order lasts at most as long as the venue session (about a day), so **Until → Cancelled** says "max 1 day".
- **Holdings:** read on-chain from Predict.fun's three Conditional Tokens contracts at the wallet's own address (18 decimals). Polymarket holdings are read at the trading wallet.
- **Reads:** orders and positions come back in the shared row shape (`venue`, `market`, `marketId`, `size`, `avgPrice`, …) and carry a venue tag. Older Polymarket-only rows still read as before. Predict.fun has no marks, so positions are priced from the market listing.
- **Cancel:** one signature cancels across venues (Kairos `CancelOrders` on Polygon, unchanged).

## Hyperliquid (HIP-4 outcome markets)

Hyperliquid runs on the same multi-venue wallet API. Its outcome markets trade on HyperCore spot, and the wallet's Hyperliquid account is its own EVM address.

- **Browse:** Hyperliquid markets (`provider=hyperliquid`) appear in **All** and under their own filter, with the live order book. Its markets have no condition id, and simple ones are named by their two sides, such as two teams. Markets are keyed `hyperliquid:<market_id>`. Marks and candles are empty for Hyperliquid, so prices come from the market listing and the book.
- **Funds:** **USDC on the wallet's Hyperliquid account.** **Add funds** in its venue sheet sends native USDC on Arbitrum to Hyperliquid's bridge (`0x2Df1…3dF7`), which credits the sender's Hyperliquid perps account. The wallet refuses deposits under 5 USDC, because Hyperliquid loses them. Perps USDC counts towards the balance: when spot is short, the order asks for one extra signature that moves just what it needs from the wallet's own perps to its own spot. Status then shows `venueDetail.transferFromPerps`.
- **Setup:** happens inside the first Hyperliquid order, with one `approveAgent` signature and no gas, plus a builder-fee approval where Kairos charges one. It approves a trade-only agent key that Kairos holds. Hyperliquid agents can't withdraw or transfer, and the user can revoke the agent on Hyperliquid. Hyperliquid refuses every action from an account that was never funded, so the status for such an account is `fund`, not `setup`.
- **Orders:** each order is one signature over Kairos' `PlaceOrder` authorization (domain `Kairos` v1, chain 42161). Kairos then places exactly that order with the agent. The rules: whole shares, prices with at most 5 decimals (float noise is rounded off before signing), and `GTC`, `FAK` or `IOC` only. A market order is `FAK`, and the limit choice is "Fill now, cancel the rest".
- **Holdings and balances:** read from Hyperliquid's public info API (`spotClearinghouseState`, `clearinghouseState`). Outcome shares are spot balances named `+<encoding>`, which is the order book's `#<encoding>`.
- **Status `wait` and `blocked`:** `wait` means approvals already sent are still confirming. `blocked` means this venue account can't be used, for example a portfolio-margin account. The trade panel shows `venueDetail.reason` instead of offering to trade.

## Signature validation

Kairos sends each step as an `eth_signTypedData_v4` request, a `personal_sign` (sign-ins), or a `wallet_sendCalls` (Predict.fun approvals, sent as transactions). Before signing or sending, the wallet checks every request against the action the user started (`src/core/predictions/verify.ts`) and refuses anything else. It never falls back to signing blindly.

| Check                                      | Rule                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Method                                     | Only `eth_signTypedData_v4`, `personal_sign` (Kairos `login`, or Predict.fun's sign-in during a setup or order) or `wallet_sendCalls` (Predict.fun approvals), only for the user's own address.                                                                                                                                                                                         |
| Chain                                      | EIP-712 domain `chainId` must be Polygon (137), BNB Chain (56) for a Predict.fun order, or Arbitrum (42161, or 421614 for Hyperliquid testnet) for a Hyperliquid request.                                                                                                                                                                                                               |
| Ownership proof (`ClobAuth`)               | Only during setup (or the setup an order runs first), and only for the user's own address.                                                                                                                                                                                                                                                                                              |
| Contract-call batches (`DepositWallet`)    | Only during setup (or the setup an order runs first), and only for the user's trading wallet. Every call must be `approve` on pUSD or `setApprovalForAll` on the Conditional Tokens contract, with zero value, exact calldata length, and a spender from the known Polymarket/Kairos exchange contracts. Transfers, unknown contracts and unknown spenders are refused.                 |
| Sign-in (`login`)                          | Must be a Sign-In with Ethereum (EIP-4361, version 1) message for the user's address with a nonce, whose domain and URI are the configured wallet API host or a `kairos.trade` host. Sign-ins for other sites are refused.                                                                                                                                                              |
| Predict.fun approvals (`wallet_sendCalls`) | Only during a setup or order, on chain `0x38`, from the user's address. Every call must be `approve` on USDT or Predict.fun's wrapped collateral to one of Predict.fun's four exchanges, or `setApprovalForAll` on one of its Conditional Tokens contracts to an exchange or neg-risk adapter, with zero value and exact calldata length. Anything else is refused and nothing is sent. |
| Predict.fun sign-in                        | `personal_sign` of readable text for the user's address, only during a setup or order on a Predict.fun step. A raw 32-byte hash is refused, and a Sign-In with Ethereum message must name `predict.fun`.                                                                                                                                                                                |
| Predict.fun orders                         | Domain `predict.fun CTF Exchange` on chain 56 with one of the four Predict.fun exchanges as `verifyingContract`. Maker and signer must be the user's address, taker zero, the token id the chosen outcome, the side must match, and the amount given up (18 decimals) can't exceed what the user confirmed.                                                                             |
| Orders                                     | Maker/signer must be the user or their trading wallet, the token id must be the outcome the user chose, the side must match, and the amount given up can't exceed what the user confirmed (1% rounding tolerance).                                                                                                                                                                      |

Hyperliquid requests (`verifyHyperliquidRequest`):

- **User-signed actions:** domain `HyperliquidSignTransaction` v1 with a zero `verifyingContract`. The type must declare exactly the expected fields, and `hyperliquidChain` must match the chain (`Mainnet` with 42161). Only three are signed, all only during a setup or an order:
  - `ApproveAgent`, for an agent that isn't the user's own address;
  - `ApproveBuilderFee`, up to 0.1%;
  - `UsdClassTransfer`, only for a buy, only perps to spot (`toPerp: false`), and at most the order's cost plus fees.

  Withdrawals, sends and every other Hyperliquid action are refused.

- **Order authorization (`PlaceOrder`):** domain `Kairos` v1, no contract, the exact field list. Wallet, market, outcome, side, price, size, time in force and post-only must all equal the order the user confirmed. It must expire within an hour.

If Kairos rotates its exchange contracts, setup will refuse the new spender until the allowlist in `verify.ts` (`TRUSTED_SPENDERS`, or `PREDICTFUN_*` for Predict.fun) is updated.

## Configuration

Defaults point at **production**. **Settings → Swap & data providers → Prediction markets (Kairos) → Environment** switches all four Kairos URLs between production and staging at once. Editing any URL by hand shows the environment as **Custom**. The switch leaves the partner id alone:

| Setting          | Staging                                                               | Production (default)             |
| ---------------- | --------------------------------------------------------------------- | -------------------------------- |
| Partner id       | `wallet-pilot`                                                        | `wallet-pilot`                   |
| Wallet API URL   | `https://staging-execution.kairos.trade`                              | `https://execution.kairos.trade` |
| Data API URL     | `https://staging-data.kairos.trade`                                   | `https://data.kairos.trade`      |
| Market data URL  | `https://staging-md.kairos.trade`                                     | `https://md.kairos.trade`        |
| Orderbook stream | `wss://stream.kairos.trade` (staging's stream currently has no books) | `wss://stream.kairos.trade`      |

| Halliday API URL | `https://v2.prod.halliday.xyz` | same |
| Halliday key | publishable `pk_…` key | publishable `pk_…` key |

The partner id is sent as `X-Kairos-Partner-Id` on every wallet API request, with `X-Kairos-Wallet-Api: 2`. The feature can be turned off with the same settings toggle, which hides **Predict** from the home screen.

## APIs used

| Purpose                                       | Endpoint                                                    |
| --------------------------------------------- | ----------------------------------------------------------- |
| Market list, categories, search               | `GET {data}/api/markets/discover/v2` (public)               |
| Market detail and outcome tokens              | `GET {md}/v1/markets/{venue}/{market_id}`                   |
| Prices                                        | `GET {md}/v1/marks`                                         |
| Chart                                         | `GET {md}/v1/candles`                                       |
| Trading status (`next`: setup / fund / ready) | `GET {exec}/v3/wallets/{address}`                           |
| Login, setup, order, cancel                   | `POST {exec}/v3/actions`, `POST/GET {exec}/v3/actions/{id}` |
| Orders, positions (`Authorization: SIWE …`)   | `GET {exec}/v3/wallets/{address}/orders`, `/positions`      |
| Hyperliquid balances and holdings             | `POST https://api.hyperliquid.xyz/info` (public)            |

## Current limitations

- **Orders on staging:** staging accepts setup but rejects orders with `trading is not available on this node`. The order flow is implemented and unit-tested to the documented API, and that message is shown as-is.
- **Nodes without sign-in:** a Kairos node that predates the `login` action (it answers `unknown variant`) can't serve orders or positions, and the Positions and Orders tabs say so. Trading is unaffected.
- **Venues:** Polymarket (pUSD on Polygon) and Predict.fun (USDT on BNB Chain). Predict.fun trading needs a node serving the multi-venue wallet API; until it's deployed, Predict.fun is browse-only. Hyperliquid (USDC on HyperCore) trades on a node with its server agent enabled; a node without it doesn't list the venue.
- **Predict.fun and Hyperliquid history:** closed positions with realized P&L come from Polymarket trader stats only.
- **Hyperliquid deposits** come from USDC on Arbitrum only. Withdrawing from Hyperliquid happens on Hyperliquid; the wallet never signs a withdrawal.
- **Order responses:** order and position records are loosely typed in the API, so the lists read common field names defensively.

## Tests

- `tests/unit/predictions.test.ts`:
  - the validator, using real staging payloads plus attack cases (transfer calls, unknown contracts or spenders, wrong wallet or chain, mismatched orders);
  - the Kairos client (mapping, polling, partner header);
  - the service flow, including proof that a malicious batch is never signed or submitted.
- `tests/integration/kairos-staging.test.ts`: live against staging, opt-in with `KAIROS_LIVE=1 pnpm test:integration`. Lists and loads markets, then runs a full setup for a fresh wallet through the validator.
- `tests/unit/halliday.test.ts` and `tests/integration/halliday-deposit.test.ts`: Halliday asset mapping and quote handling; real token deposits on anvil with Halliday mocked. Tampered deposit instructions and permit-style "verifications" are refused before any funds move.
- `tests/unit/orderbook.test.ts`: the protobuf codec, book sequencing (gaps, stale deltas, epoch fencing, baseline mismatch), and market-order book walks. `tests/integration/kairos-stream.test.ts` checks the live feed (opt-in).
- `tests/integration/recovery-fork.test.ts`: the full recovery against the real Polymarket deposit-wallet contract on a Polygon mainnet fork. Opt-in with `RECOVERY_FORK=1 pnpm test:integration`.
- `tests/unit/venues.test.ts`: market keys, multi-venue status, the Predict.fun validator (orders, the 12 approvals, sign-in) with attack cases, and shared order/position rows.
- `tests/integration/predictfun-order.test.ts`: a first Predict.fun order against a stand-in multi-venue API with BNB Chain on anvil (chain 56). It checks the 12 approval transactions on chain, the login and order signatures, and that a bad approval sends nothing.
- `tests/unit/venues.test.ts` also covers the Hyperliquid validator: the agent, builder fee and perps-to-spot move, the order authorization field by field, and refused withdrawals.
- `tests/integration/hyperliquid-order.test.ts`: a first Hyperliquid order against a stand-in API (agent, builder fee, perps-to-spot move, order; every signature recovered), the order rules, balances and holdings, and a real deposit to the bridge on anvil playing Arbitrum (chain 42161).
- `tests/e2e/predictions.spec.ts`: live UI flow in the built extension (browse, search, market, setup, funding sheet, Predict.fun markets with their live book), opt-in with `KAIROS_LIVE=1 pnpm test:e2e`.
- `tests/e2e/portfolio.spec.ts`: positions and orders against a stand-in wallet API, including a multi-venue node (Predict.fun balance, position and first-order review; Hyperliquid deposit sheet, markets, whole-share order review and a blocked account).
