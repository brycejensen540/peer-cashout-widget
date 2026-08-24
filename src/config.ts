import { base } from 'viem/chains';
import type { RuntimeEnv } from '@zkp2p/cash';

// ---------------------------------------------------------------------------
// Widget configuration — the only place you should need to touch for now.
//
// Environment: 'staging' | 'preproduction' | 'production'
//   - staging is the safe default for testing. NOTE: all three environments
//     run against the SAME Base mainnet chain + real Base USDC — the env only
//     selects the Peer curator/indexer API backend, not a testnet.
//   - Override at build/run time with VITE_CASH_ENV (see .env.example).
// ---------------------------------------------------------------------------

const rawEnv: string | undefined = import.meta.env.VITE_CASH_ENV as
  | string
  | undefined;

export const CASH_ENV: RuntimeEnv =
  rawEnv === 'production' || rawEnv === 'preproduction' ? rawEnv : 'staging';

/** The chain USDC lives on. All Peer Cash environments use Base mainnet. */
export const CHAIN = base;

/** Fiat currency offered to buyers. USD is supported by every payout rail. */
export const CURRENCY = 'USD' as const;

/** Display name for the currency used in the UI. */
export const CURRENCY_SYMBOL = '$';
