import { useEffect, useRef, useState } from 'react';
import type { WalletClient } from 'viem';
import { base } from 'viem/chains';
import type { UseConnectorClientReturnType } from 'wagmi';
import { formatUsdc, type CashOrder } from '@zkp2p/cash';
import { CURRENCY_SYMBOL } from '../config';
import { CASH, friendlyError } from '../lib/cash';
import { TERMINAL_STATES, useOrderStatus } from '../lib/useOrderStatus';

// The signer is the wagmi connector's WalletClient — the same shape
// useConnectorClient() returns, so the prop lines up with the hook.
type Signer = UseConnectorClientReturnType['data'];

// ---------------------------------------------------------------------------
// Live order status view. Everything is resumable from the depositId alone:
// the order is reconstructed from on-chain data, so refreshing (or reopening
// the page later) shows the same state. watch() streams updates until the
// order reaches a terminal state (delivered / returned).
// ---------------------------------------------------------------------------

export interface PersistedOrder {
  depositId: string;
  amount: bigint;
  platform: string;
  payee: string;
  txHash?: string;
  initialOrder?: CashOrder;
}

const STATE_LABEL: Record<CashOrder['state'], string> = {
  'awaiting-buyer': 'Awaiting buyer',
  matched: 'Matched',
  delivering: 'Delivering',
  delivered: 'Delivered',
  returned: 'Returned',
};

const EXPLORER_URL = base.blockExplorers.default.url;

interface OrderStatusProps {
  order: PersistedOrder;
  signer: Signer;
  onStartNew: () => void;
  onTerminal?: (info: { depositId: string; state: CashOrder['state'] }) => void;
}

export default function OrderStatus({ order: persisted, signer, onStartNew, onTerminal }: OrderStatusProps) {
  const { order, error, watching, refresh } = useOrderStatus(
    persisted.depositId,
    persisted.initialOrder ?? null,
  );
  const [withdrawing, setWithdrawing] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const state = order?.state;
  const isTerminal = state != null && TERMINAL_STATES.has(state);
  const canWithdraw = Boolean(order?.nextActions.includes('withdraw'));

  // Widget callback: fire once when the order reaches a terminal state.
  const firedTerminal = useRef(false);
  useEffect(() => {
    if (isTerminal && state && !firedTerminal.current) {
      firedTerminal.current = true;
      onTerminal?.({ depositId: persisted.depositId, state });
    }
  }, [isTerminal, state, persisted.depositId, onTerminal]);

  const withdraw = async () => {
    if (!persisted.depositId || !signer || withdrawing) return;
    setWithdrawing(true);
    setActionNote(null);
    try {
      // wagmi's client is a viem WalletClient at runtime; the cast only
      // reconciles the slightly different TS shapes.
      await CASH.withdraw(persisted.depositId, { signer: signer as WalletClient });
      setActionNote('Withdraw submitted — your USDC is on its way back to your wallet.');
      await refresh();
    } catch (err) {
      setActionNote(friendlyError(err));
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div className="card">
      <header className="card-head">
        <h1>Cash-out order</h1>
        <span className={`pill pill-${state ?? 'awaiting-buyer'}`}>
          {state ? STATE_LABEL[state] : 'Loading…'}
        </span>
      </header>

      <dl className="order-summary">
        <div>
          <dt>Amount</dt>
          <dd>{formatUsdc(persisted.amount)} USDC</dd>
        </div>
        <div>
          <dt>Receive</dt>
          <dd>
            {CURRENCY_SYMBOL} USD · {platformLabel(persisted.platform)} → {persisted.payee}
          </dd>
        </div>
        <div>
          <dt>Deposit ID</dt>
          <dd className="mono" title="Resume key — the order rebuilds from this alone">
            {persisted.depositId}
          </dd>
        </div>
        {persisted.txHash && (
          <div>
            <dt>Deposit tx</dt>
            <dd>
              <a href={`${EXPLORER_URL}/tx/${persisted.txHash}`} target="_blank" rel="noreferrer">
                {persisted.txHash.slice(0, 10)}…
              </a>
            </dd>
          </div>
        )}
      </dl>

      {/* Live status line from the SDK's explain() helper */}
      <div className="status-line">
        <span className={`dot ${watching && !isTerminal ? 'dot-live' : 'dot-idle'}`} />
        {order ? (
          order.explain()
        ) : (
          'Reading order from the chain…'
        )}
      </div>

      {state === 'delivered' && (
        <p className="success" role="status">
          Delivered — a buyer paid {persisted.payee} on {platformLabel(persisted.platform)} and
          the proof verified. Escrow released.
        </p>
      )}
      {state === 'returned' && (
        <p className="note">
          No buyer matched in time. Your USDC is still in the protocol escrow — withdraw it
          whenever you like.
        </p>
      )}

      {error && <p className="error">{friendlyError(error)}</p>}
      {actionNote && <p className="note">{actionNote}</p>}

      <div className="order-actions">
        {canWithdraw && signer && (
          <button className="btn btn-primary" onClick={withdraw} disabled={withdrawing}>
            {withdrawing ? 'Withdrawing…' : 'Withdraw USDC'}
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => void refresh()}>
          Refresh status
        </button>
        <button className="btn btn-ghost" onClick={onStartNew}>
          New cash-out
        </button>
      </div>

      <p className="persist-note">
        This order is safe to close — it rebuilds from the chain by deposit ID. Reopen the
        page and it resumes automatically.
      </p>
    </div>
  );
}

function platformLabel(id: string): string {
  const labels: Record<string, string> = {
    venmo: 'Venmo',
    wise: 'Wise',
    revolut: 'Revolut',
    cashapp: 'Cash App',
  };
  return labels[id] ?? id;
}
