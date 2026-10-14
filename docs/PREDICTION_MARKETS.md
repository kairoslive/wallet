# Prediction markets

Duo Wallet lets users browse and trade [Polymarket](https://polymarket.com) prediction markets through the [Kairos wallet API](https://docs.kairos.trade/wallets/overview). Users keep their keys: Kairos builds each request, the wallet checks and signs it, and Kairos routes it to the venue. There is no Kairos account, API key or login per user.

<p align="center">
  <img src="screenshots/predict.png" width="220" alt="Markets" />
  <img src="screenshots/predict-market.png" width="220" alt="Market detail" />
</p>

## User flow

1. **Browse:** **Predict** on the home screen opens trending markets, with category filters and search. Grouped events (price ladders, multi-candidate races) open to their outcome list. A market shows its chance, a 1D/1W/1M price chart, and Yes/No prices.
2. **Set up (once per account):** the user signs twice in the wallet: a proof of wallet ownership, and a batch that approves the Polymarket exchange contracts to use their new **trading wallet** (a smart wallet owned by their address). No gas.
3. **Fund:** the user moves pUSD on Polygon into the trading wallet from **Add funds**. If they have no pUSD, **Get pUSD** opens Swap/Bridge with pUSD preselected. The deposit is a normal Polygon transfer and needs a little POL.
4. **Trade:** buy or sell Yes/No shares with a limit price, either **Limit** (stays open) or **Fill now or cancel** (FOK). The confirm sheet shows shares, limit price, max cost and payout. One signature, no gas.
5. **Manage:** the **Positions** and **Orders** tabs list holdings and orders; open orders can be cancelled individually or all at once (one signature each).

## Signature validation

Kairos sends each step as an `eth_signTypedData_v4` request. Before signing, the wallet checks every request against the action the user started (`src/core/predictions/verify.ts`) and refuses anything else. It never falls back to signing blindly.

| Check                                   | Rule                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Method                                  | Only `eth_signTypedData_v4`, only for the user's own address.                                                                                                                                                                                                                                                                        |
| Chain                                   | EIP-712 domain `chainId` must be Polygon (137).                                                                                                                                                                                                                                                                                      |
| Ownership proof (`ClobAuth`)            | Only during setup, and only for the user's own address.                                                                                                                                                                                                                                                                              |
| Contract-call batches (`DepositWallet`) | Only during setup, and only for the user's trading wallet. Every call must be `approve` on pUSD or `setApprovalForAll` on the Conditional Tokens contract, with zero value, exact calldata length, and a spender from the known Polymarket/Kairos exchange contracts. Transfers, unknown contracts and unknown spenders are refused. |
| Orders                                  | Maker/signer must be the user or their trading wallet, the token id must be the outcome the user chose, the side must match, and the amount given up can't exceed what the user confirmed (1% rounding tolerance).                                                                                                                   |

If Kairos rotates its exchange contracts, setup will refuse the new spender until the allowlist in `verify.ts` (`TRUSTED_SPENDERS`) is updated.

## Configuration

Edit it under **Settings → Swap & data providers → Prediction markets (Kairos)**. Defaults point at **staging** for the pilot:

| Setting         | Staging (default)                        | Production                  |
| --------------- | ---------------------------------------- | --------------------------- |
| Partner id      | `wallet-pilot`                           | Assigned by Kairos          |
| Wallet API URL  | `https://staging-execution.kairos.trade` | Assigned by Kairos          |
| Data API URL    | `https://staging-data.kairos.trade`      | `https://data.kairos.trade` |
| Market data URL | `https://staging-md.kairos.trade`        | `https://md.kairos.trade`   |

The partner id is sent as `X-Kairos-Partner-Id` on every wallet API request. The feature can be turned off with the same settings toggle, which hides **Predict** from the home screen.

## APIs used

| Purpose                                       | Endpoint                                                    |
| --------------------------------------------- | ----------------------------------------------------------- |
| Market list, categories, search               | `GET {data}/api/markets/discover/v2` (public)               |
| Market detail and outcome tokens              | `GET {md}/v1/markets/polymarket/{market_id}`                |
| Prices                                        | `GET {md}/v1/marks`                                         |
| Chart                                         | `GET {md}/v1/candles`                                       |
| Trading status (`next`: setup / fund / ready) | `GET {exec}/v3/wallets/{address}`                           |
| Setup, order, cancel                          | `POST {exec}/v3/actions`, `POST/GET {exec}/v3/actions/{id}` |
| Orders, positions                             | `GET {exec}/v3/wallets/{address}/orders`, `/positions`      |

## Current limitations

- **Orders on staging:** staging accepts setup but rejects orders with `trading is not available on this node`. The order flow is implemented and unit-tested to the documented API, and that message is shown as-is.
- **Withdrawals:** the wallet API has no withdrawal action. Funds in the trading wallet can't be moved back from Duo yet.
- **Venues:** only Polymarket (pUSD on Polygon).
- **Order responses:** order and position records are loosely typed in the API, so the lists read common field names defensively.

## Tests

- `tests/unit/predictions.test.ts`:
  - the validator, using real staging payloads plus attack cases (transfer calls, unknown contracts or spenders, wrong wallet or chain, mismatched orders);
  - the Kairos client (mapping, polling, partner header);
  - the service flow, including proof that a malicious batch is never signed or submitted.
- `tests/integration/kairos-staging.test.ts`: live against staging, opt-in with `KAIROS_LIVE=1 pnpm test:integration`. Lists and loads markets, then runs a full setup for a fresh wallet through the validator.
- `tests/e2e/predictions.spec.ts`: live UI flow in the built extension (browse, search, market, setup, funding sheet), opt-in with `KAIROS_LIVE=1 pnpm test:e2e`.
