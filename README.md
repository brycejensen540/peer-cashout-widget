# Peer Cash Widget (MVP)

A minimal single-page React app that lets a user **cash out Base USDC to USD
fiat** and **cash in fiat to Base USDC** (Venmo, Wise, Revolut, Cash App)
through the [Peer / ZKP2P](https://docs.peer.xyz) protocol, using the official
[`@zkp2p/cash`](https://www.npmjs.com/package/@zkp2p/cash) and
[`@zkp2p/sdk`](https://www.npmjs.com/package/@zkp2p/sdk) packages.

- **Cash out (sell USDC)** — the user is the **maker**: their USDC is deposited
  into the protocol's escrow, a **buyer** pays the merchant's fiat handle
  (Venmo/Wisetag/Revtag/Cashtag) directly, proves the payment with a TEE
  attestation, and the protocol releases the USDC to the buyer.
- **Cash in (buy USDC)** — the user is the **buyer**: they take a seller's open
  order from the live orderbook, signal an on-chain intent, pay the seller's
  payment-app handle, prove it with the **Peer browser extension**, and the
  escrow releases USDC to their wallet.

No bank account, KYC, or centralized on/off-ramp provider involved.

> **This is an MVP demo.** It is not production-ready for high volume. It shows
> the full flows — connect → estimate → deposit → watch → deliver (cash out)
> and browse → signal → pay → verify → receive (cash in) — so an ecommerce
> site can later embed or adapt them.

![Peer widget: buying USDC from live Peer staging orders](public/demo.png)

---

## Stack

- **Vite + React + TypeScript**
- **wagmi + viem** — wallet connection & signing on Base
- **`@zkp2p/cash`** — the Peer Cash SDK, maker side (`createCashClient`,
  `estimate`, `cashout`, `order` / `watch`, `withdraw`)
- **`@zkp2p/sdk`** — the Peer SDK, taker side (orderbook, `signalIntent`,
  `fulfillIntent`, Peer-extension bridge)
- Plain CSS — no design system, no backend, no auth.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts: `npm run build` (typecheck + bundle) and `npm run typecheck`.
`node scripts/capture-demo.mjs` regenerates `public/demo.png` (the screenshot
above) — it renders the live app in headless Edge, so start `npm run dev` first.

### What you need to actually cash out

1. **A browser wallet** (MetaMask, Rabby, Coinbase Wallet, …) with **Base
   mainnet** selected — the SDK refuses other chains (`SIGNER_CHAIN_MISMATCH`).
   The app shows a "Switch to Base" button if needed.
2. **Base USDC** in that wallet. There is no faucet: every environment of the
   Peer Cash SDK runs against real Base mainnet USDC (see below).
3. **A real payee handle** on the chosen platform — a Venmo username, Wisetag,
   Revtag, or Cashtag that actually exists and is controlled by the merchant.
   Handles are validated against the live platform at registration.
4. **A buyer on the Peer network** to pick up your order. On staging, order
   volume is low, so expect to wait (or withdraw later).

> Tip: you can verify the whole integration against a 1–2 USDC cash-out and
> then `withdraw()` — see the "How the flow works" section. The SDK's own
> staging verification checklist lives in its
> [AGENTS.md](https://github.com/zkp2p/peer-cash/blob/main/AGENTS.md).

### What you need to actually cash in (buy USDC)

1. **A browser wallet** on **Base mainnet**, with a little **ETH for gas** —
   signaling the intent and fulfilling it are two small protocol transactions.
2. **A payment-app account** (Venmo / Wise / Revolut / Cash App) with funds.
   You pay the seller's handle directly from it.
3. **The Peer browser extension (Chrome, v0.6.3+)** — this is the TEE
   attestation bridge: it captures your payment metadata encrypted for the
   attestation service, so the protocol can verify the payment without seeing
   your credentials. The widget detects the extension and guides installation
   if it's missing.
4. **An open seller order** — the widget lists live orders from the Peer
   orderbook for the configured environment. Staging liquidity is thin and
   changes constantly; refresh to see what's available (an empty book shows a
   clear message).

### Configuration

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `VITE_CASH_ENV` | `staging` · `preproduction` · `production` | `staging` | Selects the Peer curator/indexer API. |

⚠️ **Important:** the environment selects the *API backend only*. All three
environments use the **same Base mainnet chain and real Base USDC**. There is
no testnet for this flow — "staging" just points at the staging curator API
(safer for testing integrations, but funds are still real).

## How the flows work

### Cash out (maker side)

1. **Connect** — wagmi connects the wallet; the app reads the wallet's Base
   USDC balance via `useReadContract` (viem `erc20Abi`).
2. **Estimate** — `cash.estimate({ amount, currency: 'USD', platform })`
   returns the live Chainlink oracle rate (`≈`, **never a locked quote**; the
   binding rate resolves when a buyer fills). A debounced call refreshes it as
   you type. `cash.fillStats()` adds a historical "typical first fill" ETA and
   fails open to "Varies".
3. **Cash out** — `cash.cashout({ amount, receive: { platform, currency,
   payee } }, { signer })`:
   - registers the payee with the Peer curator,
   - approves + deposits your USDC into the protocol escrow,
   - for **Venmo / Cash App** (restricted rails) also attaches the
     access-policy groups in a follow-up transaction,
   - returns `{ depositId, txHash, order }`.
4. **Watch** — `cash.watch(depositId)` streams order state changes until a
   terminal state:
   `awaiting-buyer → matched → delivering → delivered` (paid + proven) or
   `returned` (no buyer; no separate "failed/cancelled" state in this SDK).
   `order.explain()` provides a one-line human status.
5. **Withdraw** — the **only** unwind verb: `cash.withdraw(depositId, {
   signer })` prunes expired intents and returns your USDC. It's shown whenever
   `order.nextActions` includes `withdraw` — no heuristics.

### Cash in (taker side)

1. **Browse** — `apiGetOrderbook()` lists makers selling USDC for the env's
   currency (USD). Rows on retired escrows and platforms the widget can't drive
   are filtered out, and each maker's payment-app handle is resolved from the
   curator so you know exactly who to pay.
2. **Signal** — `client.signalIntent({ depositId, amount, toAddress,
   processorName, payeeDetails, fiatCurrencyCode, conversionRate })` reserves
   the USDC in the seller's escrow. The intent hash is decoded from the
   `IntentSignaled` event on the receipt (per the Peer onramp guide — never
   guess from `getIntents()` ordering).
3. **Pay & prove** — the widget drives the documented
   [onramp integration](https://docs.peer.xyz/developer/integrate-zkp2p/integrate-redirect-onramp):
   `peer.authenticate({ captureMode: 'buyerTee', ... })` opens the payment app
   in a tab, captures the payment rows encrypted for the TEE attestation
   service, and the user selects the exact payment row they made.
4. **Fulfill** — `client.fulfillIntent({ intentHash, proof,
   attestationServiceUrl })` posts the proof, gets a `PaymentAttestation`, and
   sends the on-chain fulfillment transaction that releases USDC to the
   buyer's wallet.
5. **Resume** — the `intentHash` (+ order metadata) is persisted to
   `localStorage`; on refresh the widget verifies the intent on-chain
   (`client.getIntent()`) and lets you continue paying, fulfill, or cancel
   (`client.cancelIntent()`).

### Errors

Every failure is surfaced through a friendly message. The maker side throws
typed `CashError`s with `code`, `retryable`, and `remediation`; the app maps
common codes (`INSUFFICIENT_TOKEN_BALANCE`, `TRANSACTION_REJECTED`,
`PAYEE_VERIFICATION_REQUIRED`, `SIGNER_CHAIN_MISMATCH`, `ORDER_NOT_FOUND`, …)
to human copy. The taker side maps the common failure modes itself
(`friendlyCashinError`): user-rejected transaction, wrong chain, no gas,
order already taken, retired escrow, attestation failure. Wallet-rejected
transactions are detected via `isUserRejectedError`.

## Project structure

```
peer-cashout-widget/
├── index.html
├── vite.config.ts / tsconfig.json
├── src/
│   ├── main.tsx               wagmi + react-query providers
│   ├── config.ts              environment, chain, currency — the only config
│   ├── wagmi.ts               wagmi config (Base + injected/Coinbase connectors)
│   ├── App.tsx                tabs (cash out / cash in) + localStorage resume
│   ├── lib/
│   │   ├── cash.ts            shared CashClient, capabilities, friendlyError()
│   │   ├── cashin.ts          taker client, orderbook, maker handles, extension helpers
│   │   ├── useOrderStatus.ts  order() + watch() hook (resumable, terminal-aware)
│   │   └── useWallet.ts       shared wagmi wallet hook
│   └── components/
│       ├── CashoutForm.tsx    cash-out form, live estimate, submit
│       ├── OrderStatus.tsx    live status, withdraw, resume
│       └── CashinForm.tsx     cash-in: orderbook → signal → extension → fulfill
│                              (lazy-loaded; pulls in @zkp2p/sdk)
```

## Current limitations

- **Liquidity / settlement time depends on the Peer network.** A buyer must
  pick up a cash-out order (and vice versa a seller must take your buy
  intent). On staging there is little volume; even in production it's not
  instant.
- **Proof times vary.** The TEE-TLS attestation takes time; `delivered` (cash
  out) / USDC released (cash in) only lands once the payment is proven
  on-chain.
- **Cash-in requires the Peer Chrome extension (0.6.3+).** The buyer-TEE
  payment capture is a browser-extension flow by design (it's what proves the
  payment without exposing credentials). The widget detects, guides, and
  verifies the extension, but there is no web-only fallback for the proof.
- **Not production-ready for high volume:** no backend, no auth, no order
  reconciliation job, single-currency (USD), public RPC, and the bundle is
  large (the cash-in tab lazy-loads the ~2.7 MB `@zkp2p/sdk` chunk only when
  opened). An ecommerce deployment would add a server, keyed RPC,
  webhooks/reconciliation, and a proper UI kit.
- **Wise and PayPal** need a verified identity for *new* handles (first-party
  Peer web obtains this via the Peer TEE browser extension). The app flags this
  in the UI; already-registered handles work fine.
- **No secrets are hardcoded anywhere** — no private keys, no API keys. All
  signing happens in the user's wallet.

## Adapting this into an ecommerce widget

The app is deliberately prop-shaped so it can become an embeddable widget:

```tsx
// Merchant checkout page
<CashWidget
  initialAmount="249.99"                 // pre-fill from the cart total
  initialPayee="@acme-store"             // the MERCHANT's payout handle
  initialPlatform="venmo"
  onTerminal={({ depositId, state }) => {
    if (state === 'delivered') markOrderPaid(depositId); // callback on success
    else offerRefund(depositId);                          // callback on no-buyer
  }}
/>
```

- **Props**: `initialAmount`, `initialPayee`, `initialPlatform`, `onTerminal`
  (cash-out terminal state), plus `onCashinComplete` (fires once a buyer's
  USDC is released: `{ intentHash, amount, platform, txHash }`). See
  `CashoutWidgetProps` in `src/App.tsx`.
- **URL pre-fill** (no props needed): `/cashout?amount=25&payee=%40acme&platform=venmo`.
- **Redirects**: listen for `onTerminal` / `onCashinComplete` and
  `window.location` redirect to your order-confirmation page; or keep the
  widget inline and swap the form for your receipt UI.
- **Persistence**: the widget saves `depositId` (cash out) or `intentHash`
  (cash in) to `localStorage` and resumes on refresh — your ecommerce backend
  should do the same server-side (`depositId` rebuilds a cash-out order from
  the chain; `intentHash` resumes a purchase).
- **Merchant payee, not shopper payee**: the buyer pays whoever the handle
  belongs to, so pass *your* store's payout handle — that's the whole point of
  the widget from an ecommerce perspective.

## How this stays safe

- Funds live in the **protocol escrow contract**, not in this app, and only
  the maker (your connected wallet) can withdraw an unmatched deposit.
- Everything is resumable: close the tab mid-order, come back, and
  `order(depositId)` rebuilds the state from the chain.
- Every transaction carries ERC-8021 attribution (`peer-cash`,
  `peer-cashout-widget`) so integrations are visible on-chain.

## References

- [@zkp2p/cash on npm](https://www.npmjs.com/package/@zkp2p/cash)
- [peer-cash repository & AGENTS.md](https://github.com/zkp2p/peer-cash)
- [Peer / ZKP2P docs](https://docs.zkp2p.xyz)
