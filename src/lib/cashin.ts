import {
  Zkp2pClient,
  apiGetOrderbook,
  apiGetPayeeDetails,
  getContracts,
  SUPPORTED_CHAIN_IDS,
} from '@zkp2p/sdk';
import { parseAbi, parseEventLogs, type Address, type Log, type PublicClient, type WalletClient } from 'viem';
import { CHAIN, CASH_ENV, CURRENCY } from '../config';

// ---------------------------------------------------------------------------
// Cash-IN (fiat → USDC) — the taker/buyer side of the Peer protocol.
//
// The user is a BUYER: they take a maker's live cash-out order from the
// orderbook, signal an on-chain intent (reserves USDC in the maker's escrow),
// pay the maker's payment-app handle, and the TEE-attested proof releases the
// USDC to their wallet.
//
// The full flow is the documented Peer onramp integration:
//   1. browse      apiGetOrderbook()                     — open maker orders
//   2. signal      client.signalIntent()                 — reserve + commit (wallet tx)
//   3. pay+prove   Peer extension (captureMode buyerTee) — encrypted payment proof
//   4. fulfill     client.fulfillIntent()                — on-chain release to buyer
//
// Unlike the cash-out side (which `@zkp2p/cash` wraps), the buyer verbs live in
// the underlying `@zkp2p/sdk` — `@zkp2p/cash` only exposes maker-side helpers.
// ---------------------------------------------------------------------------

type RuntimeEnvKey = 'production' | 'preproduction' | 'staging';

const CURATOR_BY_ENV: Record<RuntimeEnvKey, string> = {
  production: 'https://api.zkp2p.xyz',
  preproduction: 'https://api-preprod.zkp2p.xyz',
  staging: 'https://api-staging.zkp2p.xyz',
};

/** Curator base URL for the configured environment — mirrors @zkp2p/cash. */
export const CASHIN_CURATOR_URL: string =
  CURATOR_BY_ENV[CASH_ENV as RuntimeEnvKey] ?? 'https://api.zkp2p.xyz';

/** Buyer TEE attestation service — derives from the curator host. */
export const ATTESTATION_SERVICE_URL =
  CASH_ENV === 'staging'
    ? 'https://attestation-service-staging.zkp2p.xyz'
    : 'https://attestation-service.zkp2p.xyz';

/**
 * The escrow the CURRENT deployment accepts intents against. The orderbook can
 * return rows on retired escrows (not signalable by anything); we drop those so
 * the user never picks an order the client would reject.
 */
export const SIGNALABLE_ESCROW = getContracts(SUPPORTED_CHAIN_IDS.BASE_MAINNET, CASH_ENV).addresses
  .escrowV2?.toLowerCase();

/** Per-platform buyer capture config (from the Peer docs metadata-index table). */
export interface PlatformConfig {
  platform: string;
  label: string;
  /** Provider template action, e.g. `transfer_venmo`. */
  actionType: string;
  /** Verifiers that need the source metadata row index. */
  includeMetadataIndex: boolean;
}

export const CASHIN_PLATFORMS: PlatformConfig[] = [
  { platform: 'venmo', label: 'Venmo', actionType: 'transfer_venmo', includeMetadataIndex: true },
  { platform: 'wise', label: 'Wise', actionType: 'transfer_wise', includeMetadataIndex: false },
  { platform: 'revolut', label: 'Revolut', actionType: 'transfer_revolut', includeMetadataIndex: true },
  { platform: 'cashapp', label: 'Cash App', actionType: 'transfer_cashapp', includeMetadataIndex: true },
];

/** A live maker order, enriched with the maker's plaintext payee handle. */
export interface CashinOrder {
  depositId: string;
  depositIdOnContract?: string;
  escrowAddress: Address;
  depositor: string;
  paymentPlatform: string;
  currency: string;
  /** Maker's conversion rate, 18-decimal fixed point (fiat per USDC). */
  price: string;
  /** Available USDC (6-decimal base units). */
  availableTokenAmount: string;
  intentAmountMin: string;
  intentAmountMax: string;
  payeeDetailsHash: string;
  /** Resolved payment-app handle to pay (e.g. `@andrew-w`). */
  payeeHandle: string;
  /** Human platform label. */
  platformLabel: string;
}

/**
 * Fetch the open orderbook (makers selling USDC) for the configured env and
 * currency, keeping only rows the current escrow can actually signal against.
 * Pure read — no wallet, no side effects.
 */
export async function fetchOrderbook(): Promise<CashinOrder[]> {
  const response = await apiGetOrderbook(
    {
      currency: CURRENCY,
      chainId: CHAIN.id,
      sortBy: 'price',
      sortDirection: 'asc',
      limit: 40,
      showSmallOrders: true,
      hideExtremeSpread: true,
    },
    { baseApiUrl: CASHIN_CURATOR_URL, runtimeEnv: CASH_ENV, timeoutMs: 15000 },
  );

const usable = response.entries.filter((entry) => {
    // Skip rows on retired escrows (see SIGNALABLE_ESCROW above) and platforms
    // this widget can't drive (no provider template).
    if (SIGNALABLE_ESCROW && entry.escrowAddress.toLowerCase() !== SIGNALABLE_ESCROW) return false;
    return CASHIN_PLATFORMS.some((p) => p.platform === entry.paymentPlatform);
  });

  // Resolve maker handles in parallel — a sequential loop made the book load
  // painfully slow (one round trip per order).
  const handles = await Promise.all(
    usable.map((entry) =>
      fetchMakerHandle(entry.paymentPlatform, entry.payeeDetailsHash).catch(() => null),
    ),
  );

  return usable.map((entry, i) => {
    const config = CASHIN_PLATFORMS.find((p) => p.platform === entry.paymentPlatform)!;
    return {
      depositId: entry.depositId,
      depositIdOnContract: entry.depositIdOnContract,
      escrowAddress: entry.escrowAddress as Address,
      depositor: entry.depositor,
      paymentPlatform: entry.paymentPlatform,
      currency: entry.currency,
      price: entry.price,
      availableTokenAmount: entry.availableTokenAmount,
      intentAmountMin: entry.intentAmountMin,
      intentAmountMax: entry.intentAmountMax,
      payeeDetailsHash: entry.payeeDetailsHash,
      payeeHandle: handles[i] ?? 'hidden',
      platformLabel: config.label,
    };
  });
}

/** Resolve a maker's plaintext payee handle from the curator by hashed id. */
export async function fetchMakerHandle(platform: string, hashedOnchainId: string): Promise<string> {
  const res = await apiGetPayeeDetails(
    { hashedOnchainId, processorName: platform },
    CASHIN_CURATOR_URL,
    15000,
  );
  return res.responseObject.offchainId;
}

/** Build the taker-side client for the connected wallet. */
export function createCashinClient(walletClient: WalletClient): Zkp2pClient {
  return new Zkp2pClient({
    walletClient,
    chainId: CHAIN.id,
    runtimeEnv: CASH_ENV,
    baseApiUrl: CASHIN_CURATOR_URL,
  });
}

/** Create a read-only cash-in client (no account needed) for status checks. */
export function createReadOnlyCashinClient(publicClient: PublicClient): Zkp2pClient {
  // Zkp2pClient wants a WalletClient for its type, but status reads only need
  // the public half when no signing method is called. Pass a minimal stand-in
  // so the constructor accepts it.
  const walletClient = {
    account: undefined,
    chain: { id: CHAIN.id },
    transport: publicClient.transport,
  } as unknown as WalletClient;
  return createCashinClient(walletClient);
}

// --- intent lifecycle helpers ----------------------------------------------

/** The IntentSignaled event, per the Peer onramp guide. */
export const INTENT_SIGNALED_ABI = parseAbi([
  'event IntentSignaled(bytes32 indexed intentHash, address indexed escrow, uint256 indexed depositId, bytes32 paymentMethod, address owner, address to, uint256 amount, bytes32 fiatCurrency, uint256 conversionRate, uint256 timestamp)',
]);

/**
 * Derive the intent hash from the signalIntent() receipt. The docs are
 * explicit: decode the event — do not take the latest entry from getIntents(),
 * since an account can hold multiple open intents with no read ordering.
 */
export function intentHashFromReceipt(receipt: { logs: readonly Log[] }): `0x${string}` | null {
  const [event] = parseEventLogs({
    abi: INTENT_SIGNALED_ABI,
    logs: receipt.logs as unknown as Parameters<typeof parseEventLogs>[0]['logs'],
    eventName: 'IntentSignaled',
  });
  return event ? (event.args.intentHash as `0x${string}`) : null;
}

// --- Peer extension (buyer TEE capture) -------------------------------------

export interface BuyerTeeRow {
  amount?: string;
  currency?: string;
  date?: string;
  hidden: boolean;
  originalIndex: number;
  params?: Record<string, string | number | boolean>;
  paymentId?: string;
  recipient?: string;
}

/** Flat-params check — rows without usable params can't build a proof. */
export function isBuyerTeeRow(value: unknown): value is BuyerTeeRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as BuyerTeeRow;
  return (
    typeof row.originalIndex === 'number' &&
    typeof row.params === 'object' &&
    row.params !== null &&
    !Array.isArray(row.params) &&
    Object.values(row.params).every(
      (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    )
  );
}

/**
 * Build the Buyer TEE proof input from the selected metadata row + the
 * extension's encrypted session material.
 */
export function buildBuyerTeeProof(
  row: BuyerTeeRow,
  encryptedSessionMaterial: string,
  config: PlatformConfig,
): Record<string, unknown> {
  if (!row.params) throw new Error('Selected payment row is missing its provider metadata.');
  if (config.includeMetadataIndex && !Number.isInteger(row.originalIndex)) {
    throw new Error('Selected payment row is missing its provider metadata index.');
  }
  return {
    proofType: 'buyerTee',
    encryptedSessionMaterial,
    params: {
      ...row.params,
      ...(config.includeMetadataIndex ? { index: row.originalIndex } : {}),
    },
    actionPlatform: config.platform,
    actionType: config.actionType,
  };
}

/** Extension 0.6.3+ is the minimum for buyer TEE verification. */
export function isPeerExtension063OrNewer(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  if (major !== 0) return major > 0;
  if (minor !== 6) return minor > 6;
  return patch >= 3;
}

// --- errors ------------------------------------------------------------------

/** Short, human copy for the common cash-in failure modes. */
export function friendlyCashinError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  if (/user rejected|declined by user|user denied/i.test(lower)) {
    return 'You cancelled the wallet request — nothing was sent.';
  }
  if (/wrong chain|chain.*mismatch|not on base|unsupported chain/i.test(lower)) {
    return 'Your wallet is on the wrong network. Switch it to Base and try again.';
  }
  if (/insufficient.*(gas|funds|balance)|max fee|underpriced/i.test(lower)) {
    return 'Your wallet has no gas for this transaction. Add a little ETH on Base and retry.';
  }
  if (/intent.*(expired|no longer)|deposit.*(closed|no longer|unavailable)|taken/i.test(lower)) {
    return 'That order is no longer available — another buyer may have taken it. Pick another order.';
  }
  if (/orchestrator|escrow.*not.*(found|signal)|not.*signalable|deposit.*not found/i.test(lower)) {
    return 'This order is on an older protocol escrow and can no longer be filled here. Pick another order.';
  }
  if (/attestation|verification failed|payment.*(not found|does not match)|no matching/i.test(lower)) {
    return 'The payment could not be verified. Make sure you paid the exact maker, amount and currency shown.';
  }
  return msg || 'Peer Cash could not start this purchase. Please try again.';
}