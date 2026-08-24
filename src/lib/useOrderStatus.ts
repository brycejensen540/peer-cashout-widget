import { useCallback, useEffect, useRef, useState } from 'react';
import type { CashOrder } from '@zkp2p/cash';
import { CASH } from './cash';

// Terminal states of a Peer Cash order. In this SDK there is no separate
// "failed"/"cancelled" state: an unmatched order ends as `returned` (USDC
// can be withdrawn) and a filled one as `delivered`.
export const TERMINAL_STATES: ReadonlySet<CashOrder['state']> = new Set([
  'delivered',
  'returned',
]);

/**
 * Observe one cash-out order by depositId.
 *
 * Fully resumable: the order is rebuilt from on-chain data, so it survives a
 * tab close, refresh, or device change. On mount it reads `order(depositId)`,
 * then `watch(depositId)` streams live state changes until a terminal state,
 * an abort, or a timeout. If the caller already has an optimistic snapshot
 * (from a just-completed cashout()), pass it as `initialOrder` to skip the
 * first read — the indexer can lag a few seconds right after submission.
 */
export function useOrderStatus(depositId: string | null, initialOrder?: CashOrder | null) {
  const [order, setOrder] = useState<CashOrder | null>(initialOrder ?? null);
  const [error, setError] = useState<Error | null>(null);
  const [watching, setWatching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!depositId) {
      setOrder(null);
      setError(null);
      setWatching(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setWatching(true);

    const run = async () => {
      try {
        // 1. Seed the order (from the optimistic snapshot, or a fresh read).
        const seeded =
          initialOrder && initialOrder.depositId === depositId
            ? initialOrder
            : await CASH.order(depositId);
        if (cancelled) return;
        setOrder(seeded);
        if (TERMINAL_STATES.has(seeded.state)) return;

        // 2. Stream updates until terminal / abort / timeout.
        for await (const next of CASH.watch(depositId, {
          signal: controller.signal,
        })) {
          if (cancelled) return;
          setOrder(next);
          if (TERMINAL_STATES.has(next.state)) break;
        }
      } catch (err) {
        // Aborts triggered by unmount/refresh are expected — ignore them.
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setWatching(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [depositId, initialOrder]);

  /** Manual pull: re-read the order from the chain right now. */
  const refresh = useCallback(async () => {
    if (!depositId) return;
    setError(null);
    try {
      const next = await CASH.order(depositId);
      setOrder(next);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [depositId]);

  return { order, error, watching, refresh };
}
