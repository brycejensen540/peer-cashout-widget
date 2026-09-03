import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { WalletClient } from 'viem';
import { base } from 'viem/chains';
import { formatUsdc, usdc } from '@zkp2p/cash';
import {
  createPeerExtensionSdk,
  isPeerExtensionAvailable,
  PEER_EXTENSION_CHROME_URL,
  type BuyerTeePaymentProofInput,
  type PeerMetadataMessage,
} from '@zkp2p/sdk';
import { CASH_ENV, CHAIN, CURRENCY, CURRENCY_SYMBOL } from '../config';
import { useWallet } from '../lib/useWallet';
import {
  ATTESTATION_SERVICE_URL,
  buildBuyerTeeProof,
  CASHIN_PLATFORMS,
  createCashinClient,
  createReadOnlyCashinClient,
  fetchOrderbook,
  friendlyCashinError,
  intentHashFromReceipt,
  isBuyerTeeRow,
  isPeerExtension063OrNewer,
  type BuyerTeeRow,
  type CashinOrder,
} from '../lib/cashin';

// ---------------------------------------------------------------------------
// Cash-IN (fiat → USDC). The buyer-side mirror of the cash-out form:
//
//   1. BROWSE   — live maker orders from the Peer orderbook (staging/prod API)
//   2. SIGNAL   — wallet signs an on-chain intent reserving USDC (no funds
//                 locked, but needs a little ETH for gas on Base)
//   3. PAY+PROVE — the user pays the maker's payment-app handle; the Peer
//                 browser extension (0.6.3+) captures the payment metadata
//                 encrypted for the TEE attestation service
//   4. FULFILL  — fulfillIntent() verifies the proof and releases the USDC to
//                 the buyer's wallet
//
// The intent is persisted to localStorage so a refresh resumes the purchase.
// ---------------------------------------------------------------------------

const LS_KEY = 'peer-cashin:intent';
const EXPLORER_URL = base.blockExplorers.default.url;
const fmt2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const fmt4 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const shortHash = (h: string) => `${h.slice(0, 10)}…`;

interface PersistedCashin {
  intentHash: string;
  signalTx?: string;
  amount: string; // USDC base units
  platform: string;
  platformLabel: string;
  payeeHandle: string;
  toAddress: string;
  depositId: string;
  payeeDetailsHash: string;
  conversionRate: string;
  escrowAddress: string;
  currency: string;
  fulfillTx?: string;
}

function loadPersisted(): PersistedCashin | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedCashin;
    if (!parsed.intentHash || !parsed.amount || !parsed.platform || !parsed.toAddress) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(p: PersistedCashin) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    // localStorage unavailable (private mode) — keep it in memory.
  }
}

export interface CashinFormProps {
  /** Called once the buyer's USDC is released (widget-ready). */
  onCashinComplete?: (info: {
    intentHash: string;
    amount: bigint;
    platform: string;
    txHash: string;
  }) => void;
}

export default function CashinForm({ onCashinComplete }: CashinFormProps) {
  const wallet = useWallet();
  const publicClient = usePublicClient();

  // --- browse state ---------------------------------------------------------
  const [orders, setOrders] = useState<CashinOrder[] | null>(null);
  const [ordersError, setOrdersError] = useState<unknown>(null);
  const [selected, setSelected] = useState<CashinOrder | null>(null);
  const [amountText, setAmountText] = useState('');

  // --- purchase state -------------------------------------------------------
  // Resume a purchase in progress from a previous visit (the active-purchase
  // view renders entirely from `intent`, so no `selected` is needed).
  const [intent, setIntent] = useState<PersistedCashin | null>(loadPersisted);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  // --- extension / proof state ----------------------------------------------
  const [paymentRows, setPaymentRows] = useState<BuyerTeeRow[] | null>(null);
  const [captureMaterial, setCaptureMaterial] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [extBusy, setExtBusy] = useState<string | null>(null);
  const extErrorRef = useRef<((message: PeerMetadataMessage) => void) | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const [intentGone, setIntentGone] = useState(false);

  const client = useMemo(
    () => (wallet.walletClient ? createCashinClient(wallet.walletClient as WalletClient) : null),
    [wallet.walletClient],
  );
  const peerRef = useRef<ReturnType<typeof createPeerExtensionSdk> | null>(null);
  const getPeer = () => {
    if (!peerRef.current) peerRef.current = createPeerExtensionSdk({ window });
    return peerRef.current;
  };

  // --- orderbook load ---------------------------------------------------------
  const loadOrders = useCallback(async () => {
    setOrders(null);
    setOrdersError(null);
    try {
      setOrders(await fetchOrderbook());
    } catch (err) {
      setOrdersError(err);
    }
  }, []);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  // On mount with a resumed intent: verify it still exists on-chain.
  useEffect(() => {
    if (!intent || intent.fulfillTx || !publicClient) return;
    let cancelled = false;
    const check = async () => {
      try {
        const readClient = createReadOnlyCashinClient(publicClient);
        await readClient.getIntent(intent.intentHash as `0x${string}`);
      } catch {
        if (!cancelled) setIntentGone(true);
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [intent, publicClient]);

  const clearPurchase = useCallback(() => {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      // ignore
    }
    setIntent(null);
    setPaymentRows(null);
    setCaptureMaterial(null);
    setSelectedRow(null);
    setIntentGone(false);
    setError(null);
    setNote(null);
  }, []);

  // --- amount derivation ------------------------------------------------------
  const amountWei = useMemo(() => {
    if (!amountText.trim()) return null;
    try {
      const parsed = usdc(amountText);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [amountText]);

  const minWei = useMemo(() => (selected ? BigInt(selected.intentAmountMin) : null), [selected]);
  const maxWei = useMemo(() => (selected ? BigInt(selected.intentAmountMax) : null), [selected]);
  const rate = useMemo(() => (selected ? Number(selected.price) / 1e18 : 0), [selected]);
  const fiatCost = amountWei && rate ? (Number(amountWei) / 1e6) * rate : null;

  const pickOrder = (order: CashinOrder) => {
    setSelected(order);
    // Default to the largest amount the maker accepts.
    const max = BigInt(order.intentAmountMax);
    setAmountText(formatUsdc(max > 0n ? max : BigInt(order.availableTokenAmount)));
    setError(null);
  };

  // --- step 2: signal the intent -----------------------------------------------
  const signal = async () => {
    if (!selected || !amountWei || !wallet.isConnected) return;
    if (!client || !wallet.address) {
      setError('Reconnect your wallet and try again.');
      return;
    }
    if (minWei != null && maxWei != null && (amountWei < minWei || amountWei > maxWei)) {
      setError(`This order accepts ${formatUsdc(minWei)}–${formatUsdc(maxWei)} USDC.`);
      return;
    }
    setBusy('Signing intent — approve it in your wallet…');
    setError(null);
    try {
      const signalTx = await client.signalIntent({
        depositId: selected.depositIdOnContract ?? selected.depositId,
        amount: amountWei,
        toAddress: wallet.address,
        processorName: selected.paymentPlatform,
        payeeDetails: selected.payeeDetailsHash,
        fiatCurrencyCode: selected.currency,
        conversionRate: selected.price,
        escrowAddress: selected.escrowAddress,
      });
      const receipt = await publicClient?.waitForTransactionReceipt({ hash: signalTx });
      const intentHash = receipt ? intentHashFromReceipt(receipt) : null;
      if (!intentHash) {
        throw new Error('The intent transaction did not emit an IntentSignaled event.');
      }
      const next: PersistedCashin = {
        intentHash,
        signalTx,
        amount: amountWei.toString(),
        platform: selected.paymentPlatform,
        platformLabel: selected.platformLabel,
        payeeHandle: selected.payeeHandle,
        toAddress: wallet.address,
        depositId: selected.depositId,
        payeeDetailsHash: selected.payeeDetailsHash,
        conversionRate: selected.price,
        escrowAddress: selected.escrowAddress,
        currency: selected.currency,
      };
      savePersisted(next);
      setIntent(next);
      setBusy(null);
    } catch (err) {
      setBusy(null);
      setError(err);
    }
  };

  // --- step 3: Peer extension capture + step 4: fulfill ---------------------------
  const startCapture = async () => {
    const peer = getPeer();
    setError(null);
    setPaymentRows(null);
    setCaptureMaterial(null);
    setSelectedRow(null);
    setIntentGone(false);

    setExtBusy('Checking the Peer extension…');
    let unsubscribe: (() => void) | null = null;
    try {
      // The SDK throws from onMetadataMessage() when no extension is present,
      // so check availability BEFORE registering (and keep the whole launch
      // inside the try so any extension error lands in the error box).
      if (!isPeerExtensionAvailable({ window })) {
        setExtBusy(null);
        setError(
          'The Peer extension is required to verify your payment. Install it, then retry.',
        );
        window.open(PEER_EXTENSION_CHROME_URL, '_blank', 'noopener');
        return;
      }

      // Register BEFORE authenticate() (docs: "Register peer.onMetadataMessage()
      // before opening the provider auth tab"). Drop any previous subscription.
      unsubscribeRef.current?.();
      unsubscribe = peer.onMetadataMessage((message) => {
        extErrorRef.current?.(message);
      });
      unsubscribeRef.current = unsubscribe;

      const handleMessage = (message: PeerMetadataMessage) => {
        if (message.errorMessage) {
          unsubscribe?.();
          unsubscribeRef.current = null;
          setExtBusy(null);
          setError(new Error(message.errorMessage));
          return;
        }
        const rows = (message.metadata ?? []).filter(isBuyerTeeRow);
        if (rows.length === 0) {
          unsubscribe?.();
          unsubscribeRef.current = null;
          setExtBusy(null);
          setError(new Error('No usable payment rows were captured. Try the payment again.'));
          return;
        }
        if (!message.buyerTeeCapture?.encryptedSessionMaterial) {
          unsubscribe?.();
          unsubscribeRef.current = null;
          setExtBusy(null);
          setError(new Error('The extension did not return encrypted payment proof material.'));
          return;
        }
        setPaymentRows(rows);
        setCaptureMaterial(message.buyerTeeCapture.encryptedSessionMaterial);
        setSelectedRow(0);
        setExtBusy(null);
      };
      extErrorRef.current = handleMessage;

      const state = await peer.getState();
      if (state === 'needs_install') {
        setExtBusy(null);
        setError('The Peer extension is not installed. Install it, then retry.');
        window.open(PEER_EXTENSION_CHROME_URL, '_blank', 'noopener');
        return;
      }
      if (state === 'needs_connection') {
        const approved = await peer.requestConnection();
        if (!approved) {
          setExtBusy(null);
          setError('Peer extension connection was not approved.');
          return;
        }
      }
      const version = await peer.getVersion();
      if (!isPeerExtension063OrNewer(version)) {
        setExtBusy(null);
        setError(
          `The Peer extension is too old (found ${version}); version 0.6.3+ is required. Update it and retry.`,
        );
        return;
      }
      if (!intent) return;
      const config = CASHIN_PLATFORMS.find((p) => p.platform === intent.platform);
      if (!config) {
        setExtBusy(null);
        setError(`No payment capture flow for ${intent.platform}.`);
        return;
      }
      setExtBusy(`Open ${config.label} and pay ${intent.payeeHandle} — then confirm here.`);
      peer.authenticate({
        actionType: config.actionType,
        attestationActionType: config.actionType,
        attestationServiceUrl: ATTESTATION_SERVICE_URL,
        captureMode: 'buyerTee',
        platform: config.platform,
      });
    } catch (err) {
      unsubscribe?.();
      unsubscribeRef.current = null;
      setExtBusy(null);
      setError(err);
    }
  };

  const fulfill = async () => {
    if (!intent || paymentRows == null || captureMaterial == null || selectedRow == null) return;
    if (!client || !wallet.isConnected) {
      setError('Reconnect your wallet, then confirm the payment.');
      return;
    }
    const row = paymentRows[selectedRow];
    if (!row) return;
    const config = CASHIN_PLATFORMS.find((p) => p.platform === intent.platform);
    if (!config) return;
    setBusy('Verifying payment and releasing USDC…');
    setError(null);
    try {
      const proof = buildBuyerTeeProof(row, captureMaterial, config) as BuyerTeePaymentProofInput;
      const fulfillTx = await client.fulfillIntent({
        intentHash: intent.intentHash as `0x${string}`,
        proof,
        attestationServiceUrl: ATTESTATION_SERVICE_URL,
      });
      const next = { ...intent, fulfillTx };
      savePersisted(next);
      setIntent(next);
      setBusy(null);
      onCashinComplete?.({
        intentHash: intent.intentHash,
        amount: BigInt(intent.amount),
        platform: intent.platform,
        txHash: fulfillTx,
      });
    } catch (err) {
      setBusy(null);
      setError(err);
    }
  };

  const cancelIntent = async () => {
    if (!intent || !client || !wallet.isConnected) return;
    setBusy('Cancelling intent…');
    setError(null);
    try {
      await client.cancelIntent({ intentHash: intent.intentHash as `0x${string}` });
      setNote('Intent cancelled — nothing was sent. Your purchase is cleared.');
      clearPurchase();
      setBusy(null);
    } catch (err) {
      setBusy(null);
      setError(err);
    }
  };

  // --- render: done state -----------------------------------------------------
  if (intent?.fulfillTx) {
    const amountUsdc = formatUsdc(BigInt(intent.amount));
    return (
      <div className="card">
        <header className="card-head">
          <h1>USDC received</h1>
          <span className="pill pill-delivered">Done</span>
        </header>
        <p className="success" role="status">
          {amountUsdc} USDC was released to your wallet after your payment was verified.
        </p>
        <dl className="order-summary">
          <div>
            <dt>Bought</dt>
            <dd>
              {amountUsdc} USDC on Base
            </dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>
              {intent.payeeHandle} · {intent.platformLabel}
            </dd>
          </div>
          <div>
            <dt>Received at</dt>
            <dd className="mono">{shortAddress(intent.toAddress)}</dd>
          </div>
          <div>
            <dt>Fulfill tx</dt>
            <dd>
              <a href={`${EXPLORER_URL}/tx/${intent.fulfillTx}`} target="_blank" rel="noreferrer">
                {shortHash(intent.fulfillTx)}
              </a>
            </dd>
          </div>
        </dl>
        <div className="order-actions">
          <button className="btn btn-primary" onClick={clearPurchase}>
            New purchase
          </button>
        </div>
      </div>
    );
  }

  // --- render: active purchase (signed intent) -----------------------------------
  if (intent) {
    const amountUsdc = formatUsdc(BigInt(intent.amount));
    const fiatPaid = (Number(intent.amount) / 1e6) * (Number(intent.conversionRate) / 1e18);
    return (
      <div className="card">
        <header className="card-head">
          <h1>Buy USDC</h1>
          <span className={`badge badge-${CASH_ENV}`}>{CASH_ENV}</span>
        </header>

        <dl className="order-summary">
          <div>
            <dt>Buying</dt>
            <dd>
              {amountUsdc} USDC on Base
            </dd>
          </div>
          <div>
            <dt>Pay</dt>
            <dd>
              ≈{CURRENCY_SYMBOL}
              {fmt2.format(fiatPaid)} · {intent.payeeHandle} on {intent.platformLabel}
            </dd>
          </div>
          <div>
            <dt>Intent</dt>
            <dd className="mono" title={intent.intentHash}>
              {shortHash(intent.intentHash)}
            </dd>
          </div>
          {intent.signalTx && (
            <div>
              <dt>Signal tx</dt>
              <dd>
                <a
                  href={`${EXPLORER_URL}/tx/${intent.signalTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortHash(intent.signalTx)}
                </a>
              </dd>
            </div>
          )}
        </dl>

        <ol className="steps">
          <li className="step step-done">Intent signed — USDC reserved in the seller’s escrow</li>
          <li className="step step-current">
            <strong>Pay {intent.payeeHandle} on {intent.platformLabel}</strong>
            <span className="step-hint">
              Send ≈{CURRENCY_SYMBOL}
              {fmt2.format(fiatPaid)} from your {intent.platformLabel} account, then verify the
              payment with the Peer extension.
            </span>
          </li>
          <li className="step">USDC released to your wallet</li>
        </ol>

        {paymentRows == null ? (
          <>
            {extBusy && <p className="note">{extBusy}</p>}
            <button
              className="btn btn-primary"
              onClick={() => void startCapture()}
              disabled={extBusy != null || busy != null}
            >
              {extBusy ? 'Waiting for payment…' : 'Open payment & verify with Peer extension'}
            </button>
            <p className="persist-note">
              Requires the <strong>Peer extension</strong> (0.6.3+) — it captures your payment
              proof encrypted for the TEE attestation service. {intent.platformLabel} will open in
              a new tab.
            </p>
          </>
        ) : (
          <>
            <p className="field-label">Select the payment you just made:</p>
            <div className="rowlist">
              {paymentRows.map((row, i) => (
                <label key={i} className={`rowitem ${selectedRow === i ? 'rowitem-on' : ''}`}>
                  <input
                    type="radio"
                    name="payment-row"
                    checked={selectedRow === i}
                    onChange={() => setSelectedRow(i)}
                  />
                  <span>
                    <strong>
                      {CURRENCY_SYMBOL}
                      {fmt2.format(Number(row.amount ?? 0))}
                    </strong>{' '}
                    · {row.currency ?? 'USD'}
                    {row.recipient ? ` · ${row.recipient}` : ''}
                  </span>
                </label>
              ))}
            </div>
            <button
              className="btn btn-primary"
              onClick={() => void fulfill()}
              disabled={selectedRow == null || busy != null}
            >
              {busy ?? 'Confirm payment & release USDC'}
            </button>
          </>
        )}

        {intentGone && (
          <p className="note">
            This intent no longer exists on-chain — it may have already been fulfilled or expired.
            Start over to buy again.
          </p>
        )}
        {error != null && <p className="error" role="alert">{friendlyCashinError(error)}</p>}
        {note != null && <p className="note">{note}</p>}

        <div className="order-actions">
          <button
            className="btn btn-ghost"
            onClick={() => void cancelIntent()}
            disabled={busy != null || paymentRows != null}
          >
            Cancel intent
          </button>
          <button className="btn btn-ghost" onClick={clearPurchase} disabled={busy != null}>
            Start over
          </button>
        </div>
      </div>
    );
  }

  // --- render: order selection -------------------------------------------------
  const cta = (() => {
    if (!selected) return null;
    if (!wallet.isConnected) return { text: 'Connect wallet', disabled: wallet.isConnecting };
    if (!amountWei || amountWei <= 0n) return { text: 'Enter an amount', disabled: true };
    if (minWei != null && maxWei != null && (amountWei < minWei || amountWei > maxWei))
      return {
        text: `This order accepts ${formatUsdc(minWei)}–${formatUsdc(maxWei)} USDC`,
        disabled: true,
      };
    if (wallet.onWrongChain) return { text: 'Switch to Base', disabled: wallet.isSwitching };
    return { text: 'Start purchase (sign intent)', disabled: false };
  })();

  const onPrimaryClick = () => {
    if (!selected) return;
    if (!wallet.isConnected) {
      const target = wallet.connectors[0];
      if (target) wallet.connect({ connector: target });
      return;
    }
    if (wallet.onWrongChain) {
      wallet.switchChain({ chainId: CHAIN.id });
      return;
    }
    void signal();
  };

  return (
    <div className="card">
      <header className="card-head">
        <h1>Buy USDC</h1>
        <span className={`badge badge-${CASH_ENV}`}>{CASH_ENV}</span>
      </header>
      <p className="subtitle">
        Fiat from a payment app → USDC on Base, via a Peer seller’s open order.
      </p>

      {/* Wallet row */}
      <div className="wallet-row">
        {wallet.isConnected && wallet.address ? (
          <>
            <span className="wallet-addr" title={wallet.address}>
              {shortAddress(wallet.address)}
            </span>
            {wallet.onWrongChain && (
              <button
                className="btn btn-ghost btn-small"
                onClick={() => wallet.switchChain({ chainId: CHAIN.id })}
                disabled={wallet.isSwitching}
              >
                Switch to Base
              </button>
            )}
            <button className="btn btn-ghost btn-small" onClick={() => wallet.disconnect()}>
              Disconnect
            </button>
          </>
        ) : (
          <div className="connect-row">
            {wallet.connectors.map((connector) => (
              <button
                key={connector.uid}
                className="btn btn-ghost btn-small"
                onClick={() => wallet.connect({ connector })}
                disabled={wallet.isConnecting}
              >
                Connect {connector.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected ? (
        <>
          <div className="order-card">
            <div className="order-card-row">
              <span className="pill pill-matched">{selected.platformLabel}</span>
              <span>
                {CURRENCY_SYMBOL}
                {fmt4.format(rate)} {CURRENCY}/USDC
              </span>
            </div>
            <p className="order-card-main">
              Pay <strong>{selected.payeeHandle}</strong>
            </p>
            <p className="field-hint">
              Seller {shortAddress(selected.depositor)} ·{' '}
              {formatUsdc(BigInt(selected.availableTokenAmount))} USDC available
            </p>
            <button className="btn btn-ghost btn-small" onClick={() => setSelected(null)}>
              ← Pick another seller
            </button>
          </div>

          <label className="field">
            <span className="field-label">Amount (USDC)</span>
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
            {minWei != null && maxWei != null && (
              <span className="field-hint">
                Min {formatUsdc(minWei)} · Max {formatUsdc(maxWei)} USDC
              </span>
            )}
          </label>

          <div className={`estimate ${fiatCost ? '' : 'estimate-empty'}`}>
            {fiatCost ? (
              <>
                <div className="estimate-amount">
                  {CURRENCY_SYMBOL}
                  {fmt2.format(fiatCost)}
                </div>
                <div className="estimate-detail">
                  you pay · you receive {amountWei ? formatUsdc(amountWei) : '0'} USDC
                </div>
                <div className="estimate-note">
                  Price set by the seller’s order — no extra fees shown. Signal and fulfill each
                  need a little ETH for gas on Base.
                </div>
              </>
            ) : (
              <div className="estimate-placeholder">Enter an amount to see what you pay.</div>
            )}
          </div>

          {error != null && <p className="error" role="alert">{friendlyCashinError(error)}</p>}

          {cta && (
            <button className="btn btn-primary" onClick={onPrimaryClick} disabled={cta.disabled}>
              {busy ?? cta.text}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="list-head">
            <p className="field-label">Open orders — sellers cashing out {CURRENCY}</p>
            <button
              className="btn btn-ghost btn-small"
              onClick={() => void loadOrders()}
              disabled={orders == null}
            >
              Refresh
            </button>
          </div>

          {orders == null && !ordersError && (
            <p className="note">Loading live orders…</p>
          )}
          {ordersError && (
            <>
              <p className="error" role="alert">
                {friendlyCashinError(ordersError)}
              </p>
              <button className="btn btn-ghost" onClick={() => void loadOrders()}>
                Retry
              </button>
            </>
          )}
          {orders != null && orders.length === 0 && (
            <p className="note">
              No open orders on {CASH_ENV} right now — liquidity depends on the Peer network.
              Refresh in a bit, or check peer.cash for active sellers.
            </p>
          )}
          {orders != null && orders.length > 0 && (
            <div className="rowlist">
              {orders.map((order, i) => (
                <button
                  key={`${order.depositId}-${i}`}
                  className="rowitem rowitem-btn"
                  onClick={() => pickOrder(order)}
                >
                  <span className="pill pill-matched">{order.platformLabel}</span>
                  <span className="rowitem-main">
                    <strong>{order.payeeHandle}</strong> ·{' '}
                    {formatUsdc(BigInt(order.availableTokenAmount))} USDC
                  </span>
                  <span className="rowitem-rate">
                    {CURRENCY_SYMBOL}
                    {fmt4.format(Number(order.price) / 1e18)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <p className="persist-note">
            Buying needs the <strong>Peer extension</strong> (Chrome) to verify your payment, and a
            small amount of ETH on Base for the two protocol transactions. This is an MVP demo —
            orders are real Peer liquidity.
          </p>
        </>
      )}
    </div>
  );
}