import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useAccount,
  useConnect,
  useConnectorClient,
  useDisconnect,
  useSwitchChain,
  useReadContract,
} from 'wagmi';
import { erc20Abi, type WalletClient } from 'viem';
import {
  BASE_USDC_ADDRESS,
  formatUsdc,
  usdc,
  type CashEstimate,
  type CashFillStats,
  type CashoutResult,
} from '@zkp2p/cash';
import { CASH_ENV, CHAIN, CURRENCY, CURRENCY_SYMBOL } from '../config';
import { CAPS, CASH, friendlyError } from '../lib/cash';

// ---------------------------------------------------------------------------
// Payout rails offered by this MVP. The catalog (CAPS.platforms) may differ
// per environment; we intersect below so the dropdown only shows rails that
// actually exist for the configured env.
// ---------------------------------------------------------------------------
const PLATFORM_OPTIONS = [
  { id: 'venmo', label: 'Venmo', payeeLabel: 'Venmo username', placeholder: 'e.g. @andrew-w' },
  { id: 'wise', label: 'Wise', payeeLabel: 'Wisetag', placeholder: 'e.g. andrew@wise.com' },
  { id: 'revolut', label: 'Revolut', payeeLabel: 'Revtag', placeholder: 'e.g. andrew1abc' },
  { id: 'cashapp', label: 'Cash App', payeeLabel: 'Cashtag', placeholder: 'e.g. $andrew' },
];

export interface CashoutFormProps {
  /** Prefill the cash-out amount as a decimal string, e.g. "100" (widget-ready). */
  initialAmount?: string;
  /** Prefill the merchant payee handle (widget-ready). */
  initialPayee?: string;
  /** Prefill the payout platform id (widget-ready). */
  initialPlatform?: string;
  /** Called with the created order so the parent can persist it and show status. */
  onCashoutComplete: (result: CashoutResult, meta: { amount: bigint; platform: string; payee: string }) => void;
}

/** Format a median-fill seconds value into a short "~N min/hr" label. */
function formatCompactEta(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'Varies';
  if (seconds < 60) return '< 1 min';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  return `~${Math.max(1, Math.round(minutes / 60))} hr`;
}

const fmt2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const fmt4 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function CashoutForm({ initialAmount, initialPayee, initialPlatform, onCashoutComplete }: CashoutFormProps) {
  // --- wallet state ------------------------------------------------------
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useConnectorClient();

  // --- form state --------------------------------------------------------
  const [amountText, setAmountText] = useState(initialAmount ?? '');
  const [platform, setPlatform] = useState<string>(
    initialPlatform && PLATFORM_OPTIONS.some((p) => p.id === initialPlatform) ? initialPlatform : 'venmo',
  );
  const [payee, setPayee] = useState(initialPayee ?? '');
  const [estimate, setEstimate] = useState<CashEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<unknown>(null);
  const [fillStats, setFillStats] = useState<CashFillStats | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const seqRef = useRef(0);

  // Platforms that exist in this env's catalog, keeping the requested order.
  const platforms = useMemo(
    () => PLATFORM_OPTIONS.filter((p) => CAPS.platforms.some((c) => c.platform === p.id)),
    [],
  );
  const activePlatform = platforms.find((p) => p.id === platform) ?? platforms[0];
  const needsAttestation = CAPS.platforms.find((c) => c.platform === activePlatform?.id)?.requiresIdentityAttestation;

  // Parse the amount input → USDC base units (6 decimals). Invalid/empty → null.
  const amountWei = useMemo(() => {
    if (!amountText.trim()) return null;
    try {
      const parsed = usdc(amountText);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [amountText]);

  // --- USDC balance (wagmi reads the contract directly) ------------------
  const { data: balance } = useReadContract({
    abi: erc20Abi,
    address: BASE_USDC_ADDRESS,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  // --- live estimate (debounced) -----------------------------------------
  // estimate() is idempotent and has no side effects. The result is "≈" —
  // the binding rate resolves at the oracle when a buyer actually fills.
  useEffect(() => {
    if (!amountWei || amountWei < CAPS.amount.min) {
      setEstimate(null);
      setEstimateError(null);
      setEstimating(false);
      return;
    }
    setEstimating(true);
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        const est = await CASH.estimate(
          { amount: amountWei, currency: CURRENCY, platform: activePlatform?.id },
          { includeEta: false },
        );
        if (seq !== seqRef.current) return;
        setEstimate(est);
        setEstimateError(null);
      } catch (err) {
        if (seq !== seqRef.current) return;
        setEstimate(null);
        setEstimateError(err);
      } finally {
        if (seq === seqRef.current) setEstimating(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [amountWei, activePlatform?.id]);

  // Optional: historical fill-speed evidence for an ETA line. Fail open.
  useEffect(() => {
    let cancelled = false;
    CASH.fillStats()
      .then((stats) => {
        if (!cancelled) setFillStats(stats);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // --- derived UI state ----------------------------------------------------
  const onWrongChain = isConnected && chainId != null && chainId !== CHAIN.id;
  const showEstimate = Boolean(amountWei && amountWei >= CAPS.amount.min);
  const belowRecommended = Boolean(
    amountWei && amountWei >= CAPS.amount.min && amountWei < CAPS.amount.recommendedMin,
  );
  const insufficient =
    balance != null && amountWei != null && amountWei > balance;
  const etaSeconds = fillStats?.[`${activePlatform?.id}:${CURRENCY}`]?.medianFillSeconds;

  const cta = (() => {
    if (submitting) return { text: 'Starting cash-out…', disabled: true };
    if (!isConnected) return { text: 'Connect wallet', disabled: isConnecting };
    if (!amountText.trim() || amountWei == null) return { text: 'Enter an amount', disabled: true };
    if (amountWei < CAPS.amount.min)
      return { text: `Minimum is ${formatUsdc(CAPS.amount.min)} USDC`, disabled: true };
    if (insufficient) return { text: 'Insufficient USDC balance', disabled: true };
    if (onWrongChain) return { text: 'Switch to Base', disabled: isSwitching };
    if (!payee.trim()) return { text: `Enter ${activePlatform?.payeeLabel ?? 'the payee'}`, disabled: true };
    return { text: 'Start cash-out', disabled: false };
  })();

  const submit = async () => {
    if (cta.disabled) return;
    // The primary CTA doubles as the connect button when no wallet is linked.
    if (!isConnected) {
      const target = connectors[0];
      if (target) connect({ connector: target });
      return;
    }
    if (!amountWei || !activePlatform || !walletClient) return;
    if (onWrongChain) {
      switchChain({ chainId: CHAIN.id });
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await CASH.cashout(
        {
          amount: amountWei,
          receive: { platform: activePlatform.id, currency: CURRENCY, payee: payee.trim() },
        },
        { signer: walletClient as WalletClient },
      );
      onCashoutComplete(result, {
        amount: amountWei,
        platform: activePlatform.id,
        payee: payee.trim(),
      });
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const maxOut = () => {
    if (balance == null || balance <= 0n) return;
    setAmountText(formatUsdc(balance));
  };

  // --- render --------------------------------------------------------------
  return (
    <div className="card">
      <header className="card-head">
        <h1>Cash out USDC</h1>
        <span className={`badge badge-${CASH_ENV}`}>{CASH_ENV}</span>
      </header>
      <p className="subtitle">
        USDC on Base → USD to a payment app, via the Peer / ZKP2P protocol.
      </p>

      {/* Wallet row */}
      <div className="wallet-row">
        {isConnected && address ? (
          <>
            <span className="wallet-addr" title={address}>
              {shortAddress(address)}
            </span>
            {onWrongChain && (
              <button className="btn btn-ghost btn-small" onClick={() => switchChain({ chainId: CHAIN.id })} disabled={isSwitching}>
                Switch to Base
              </button>
            )}
            <button className="btn btn-ghost btn-small" onClick={() => disconnect()}>
              Disconnect
            </button>
          </>
        ) : (
          <div className="connect-row">
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                className="btn btn-ghost btn-small"
                onClick={() => connect({ connector })}
                disabled={isConnecting}
              >
                Connect {connector.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Amount */}
      <label className="field">
        <span className="field-label">Amount (USDC)</span>
        <div className="amount-input">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amountText}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, '');
              if ((v.match(/\./g) ?? []).length > 1) return;
              setAmountText(v);
            }}
          />
          {isConnected && balance != null && balance > 0n && (
            <button className="btn btn-ghost btn-small" onClick={maxOut} type="button">
              Max
            </button>
          )}
        </div>
        {isConnected && balance != null && (
          <span className="field-hint">
            Balance: {fmt2.format(Number(formatUsdc(balance)))} USDC
          </span>
        )}
      </label>

      {/* Platform */}
      <label className="field">
        <span className="field-label">Receive to</span>
        <select
          value={activePlatform?.id ?? ''}
          onChange={(e) => setPlatform(e.target.value)}
        >
          {platforms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {/* Payee */}
      <label className="field">
        <span className="field-label">{activePlatform?.payeeLabel}</span>
        <input
          type="text"
          placeholder={activePlatform?.placeholder}
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
        />
        {needsAttestation && (
          <span className="field-hint warn">
            Wise requires a verified identity for <em>new</em> handles — reuse one already
            registered on Peer, or pick another platform.
          </span>
        )}
      </label>

      {/* Live estimate */}
      <div className={`estimate ${showEstimate ? '' : 'estimate-empty'}`}>
        {showEstimate ? (
          <>
            <div className="estimate-amount">
              {CURRENCY_SYMBOL}
              {estimate ? fmt2.format(estimate.receiveAmount) : estimating ? '…' : '—'}
            </div>
            <div className="estimate-detail">
              {estimate ? (
                <>
                  ≈ {fmt4.format(estimate.rate)} {CURRENCY}/USDC · typical first fill{' '}
                  {formatCompactEta(etaSeconds)}
                </>
              ) : estimating ? (
                'Checking live rate…'
              ) : (
                'Live rate unavailable'
              )}
            </div>
            <div className="estimate-note">
              Estimate only — the binding rate sets at fill time, no locked quote.
            </div>
          </>
        ) : (
          <div className="estimate-placeholder">
            Enter an amount to see the live rate.
          </div>
        )}
      </div>

      {belowRecommended && (
        <p className="note">
          Under {formatUsdc(CAPS.amount.recommendedMin)} USDC orders fill much more slowly —
          a 1 USDC+ minimum is recommended.
        </p>
      )}

      {(submitError != null || estimateError != null) && (
        <p className="error" role="alert">
          {friendlyError(submitError ?? estimateError)}
        </p>
      )}

      <button className="btn btn-primary" onClick={submit} disabled={cta.disabled}>
        {cta.text}
      </button>
    </div>
  );
}
