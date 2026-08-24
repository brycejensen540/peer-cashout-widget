import { useCallback, useState } from 'react';
import { useConnectorClient } from 'wagmi';
import type { CashOrder, CashoutResult } from '@zkp2p/cash';
import CashoutForm from './components/CashoutForm';
import OrderStatus, { type PersistedOrder } from './components/OrderStatus';
import { CASH_ENV } from './config';

// ---------------------------------------------------------------------------
// App — the whole MVP is two screens: the cash-out form, and the live order
// status view. The depositId (plus a little display metadata) is persisted to
// localStorage so a refresh — or a later visit — resumes the same order.
//
// Widget-adaptation notes (for the ecommerce embed later):
//   - All values can be pre-filled via props or URL params:
//       <App initialAmount="25" initialPayee="@merchant" initialPlatform="venmo" />
//       /?amount=25&payee=%40merchant&platform=venmo
//   - `onTerminal` fires once an order reaches delivered/returned — hook your
//     "mark order as paid / show receipt" logic there. The merchant payee is
//     what the buyer actually pays, so an ecommerce site would pass its own
//     payout handle, not the shopper's.
// ---------------------------------------------------------------------------

export interface CashoutWidgetProps {
  /** Prefill the cash-out amount (decimal USDC string). */
  initialAmount?: string;
  /** Prefill the merchant's payee handle. */
  initialPayee?: string;
  /** Prefill the payout platform id ('venmo' | 'wise' | 'revolut' | 'cashapp'). */
  initialPlatform?: string;
  /** Called once when an order reaches a terminal state. */
  onTerminal?: (info: { depositId: string; state: CashOrder['state'] }) => void;
}

const LS_KEY = 'peer-cashout:order';

function readUrlParam(name: string): string | undefined {
  const value = new URLSearchParams(window.location.search).get(name);
  return value && value.trim() ? value.trim() : undefined;
}

function loadPersisted(): PersistedOrder | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      depositId?: string;
      amount?: string;
      platform?: string;
      payee?: string;
      txHash?: string;
    };
    if (!parsed.depositId || !parsed.amount || !parsed.platform || !parsed.payee) return null;
    return {
      depositId: parsed.depositId,
      amount: BigInt(parsed.amount),
      platform: parsed.platform,
      payee: parsed.payee,
      txHash: parsed.txHash,
    };
  } catch {
    return null;
  }
}

export default function App({
  initialAmount,
  initialPayee,
  initialPlatform,
  onTerminal,
}: CashoutWidgetProps = {}) {
  const [persisted, setPersisted] = useState<PersistedOrder | null>(loadPersisted);
  const { data: walletClient } = useConnectorClient();

  const handleCashoutComplete = useCallback(
    (result: CashoutResult, meta: { amount: bigint; platform: string; payee: string }) => {
      const next: PersistedOrder = {
        depositId: result.depositId,
        amount: meta.amount,
        platform: meta.platform,
        payee: meta.payee,
        txHash: result.txHash,
        initialOrder: result.order,
      };
      // Persist the depositId immediately — that row is the entire integration
      // state. The order rebuilds from the chain by this id alone.
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({
            depositId: next.depositId,
            amount: next.amount.toString(),
            platform: next.platform,
            payee: next.payee,
            txHash: next.txHash,
          }),
        );
      } catch {
        // localStorage unavailable (private mode) — keep the order in memory.
      }
      setPersisted(next);
    },
    [],
  );

  const startNew = useCallback(() => {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      // ignore
    }
    setPersisted(null);
  }, []);

  return (
    <main className="page">
      {persisted ? (
        <OrderStatus
          order={persisted}
          signer={walletClient}
          onStartNew={startNew}
          onTerminal={onTerminal}
        />
      ) : (
        <CashoutForm
          initialAmount={initialAmount ?? readUrlParam('amount')}
          initialPayee={initialPayee ?? readUrlParam('payee')}
          initialPlatform={initialPlatform ?? readUrlParam('platform')}
          onCashoutComplete={handleCashoutComplete}
        />
      )}

      <footer className="foot">
        <p>
          <strong>MVP demo.</strong> Liquidity and settlement time depend on the Peer network —
          a buyer must pick up your order and pay the merchant’s payment-app handle. The rate
          is an estimate at fill time; there is no locked quote.
        </p>
        <p className="foot-env">
          Peer Cash environment: <code>{CASH_ENV}</code> · Base mainnet ·{' '}
          <a href="https://docs.zkp2p.xyz" target="_blank" rel="noreferrer">
            docs
          </a>
        </p>
      </footer>
    </main>
  );
}
