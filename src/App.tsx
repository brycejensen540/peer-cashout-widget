import { lazy, Suspense, useCallback, useState } from 'react';
import { useConnectorClient } from 'wagmi';
import type { CashOrder, CashoutResult } from '@zkp2p/cash';
import CashoutForm from './components/CashoutForm';
import OrderStatus, { type PersistedOrder } from './components/OrderStatus';
import { CASH_ENV } from './config';

// The cash-in tab pulls in the full @zkp2p/sdk (orderbook + buyer TEE flow) —
// lazy-load it so the cash-out path stays light.
const CashinForm = lazy(() => import('./components/CashinForm'));

// ---------------------------------------------------------------------------
// App — the MVP is two screens per direction:
//   - Cash out: form → live order status (resumes from the persisted
//     depositId in localStorage).
//   - Cash in:  orderbook browse → intent → payment proof → USDC received
//     (resumes from the persisted intentHash).
//
// Widget-adaptation notes (for the ecommerce embed later):
//   - Cash-out values can be pre-filled via props or URL params:
//       <App initialAmount="25" initialPayee="@merchant" initialPlatform="venmo" />
//       /?amount=25&payee=%40merchant&platform=venmo
//   - `onTerminal` fires once a cash-out order reaches delivered/returned —
//     hook your "mark order as paid" logic there. `onCashinComplete` fires
//     when a buyer's USDC is released.
// ---------------------------------------------------------------------------

export interface CashoutWidgetProps {
  /** Prefill the cash-out amount (decimal USDC string). */
  initialAmount?: string;
  /** Prefill the merchant's payee handle. */
  initialPayee?: string;
  /** Prefill the payout platform id ('venmo' | 'wise' | 'revolut' | 'cashapp'). */
  initialPlatform?: string;
  /** Called once when a cash-out order reaches a terminal state. */
  onTerminal?: (info: { depositId: string; state: CashOrder['state'] }) => void;
  /** Called once when a cash-in purchase releases USDC to the buyer. */
  onCashinComplete?: (info: {
    intentHash: string;
    amount: bigint;
    platform: string;
    txHash: string;
  }) => void;
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
  onCashinComplete,
}: CashoutWidgetProps = {}) {
  const [mode, setMode] = useState<'cashout' | 'cashin'>('cashout');
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
      {/* Direction tabs — cash in (buy) vs cash out (sell) */}
      <nav className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={mode === 'cashout'}
          className={`tab ${mode === 'cashout' ? 'tab-on' : ''}`}
          onClick={() => setMode('cashout')}
        >
          Cash out (USDC → fiat)
        </button>
        <button
          role="tab"
          aria-selected={mode === 'cashin'}
          className={`tab ${mode === 'cashin' ? 'tab-on' : ''}`}
          onClick={() => setMode('cashin')}
        >
          Cash in (fiat → USDC)
        </button>
      </nav>

      {mode === 'cashin' ? (
        <Suspense fallback={<div className="card">Loading buy flow…</div>}>
          <CashinForm onCashinComplete={onCashinComplete} />
        </Suspense>
      ) : persisted ? (
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
          <strong>MVP demo.</strong> Both directions run on the real Peer / ZKP2P protocol on Base.
          Liquidity and settlement time depend on the Peer network — a counterparty must take your
          order. Rates are estimates at fill time; there is no locked quote.
        </p>
        <p className="foot-env">
          Peer environment: <code>{CASH_ENV}</code> · Base mainnet ·{' '}
          <a href="https://docs.peer.xyz" target="_blank" rel="noreferrer">
            docs
          </a>
        </p>
      </footer>
    </main>
  );
}