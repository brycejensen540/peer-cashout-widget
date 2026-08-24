import {
  createCashClient,
  type CashCapabilities,
  type CashClient,
  type CashError,
  isCashError,
  isUserRejectedError,
} from '@zkp2p/cash';
import { CASH_ENV } from '../config';

// ---------------------------------------------------------------------------
// One shared Peer Cash client for the whole app.
//
// createCashClient gives us the small typed verb set:
//   capabilities()          — which platforms/currencies exist
//   estimate()              — live oracle rate ≈ (never a locked quote)
//   cashout()               — deposit USDC + register the merchant payee
//   order() / watch()       — resume / live-watch an order by depositId
//   withdraw()              — the one unwind verb (return unmatched USDC)
//
// `referrer` is an analytics-only ERC-8021 attribution code; it costs nothing
// and helps the Peer team see integrations. No secrets or API keys here.
// ---------------------------------------------------------------------------

export const CASH: CashClient = createCashClient({
  environment: CASH_ENV,
  referrer: 'peer-cashout-widget',
});

/** Sync discovery: the static platform/currency/amount catalog for this env. */
export const CAPS: CashCapabilities = CASH.capabilities();

/** Turn a user-typed error into a short, human sentence. */
export function friendlyError(error: unknown): string {
  if (isUserRejectedError(error)) {
    return 'You cancelled the wallet request — nothing was sent.';
  }
  if (isCashError(error)) {
    const e = error as CashError;
    switch (e.code) {
      case 'INSUFFICIENT_TOKEN_BALANCE':
        return 'Not enough USDC in your wallet for this amount. Fund your wallet and try again.';
      case 'TRANSACTION_REJECTED':
        return 'You rejected the wallet request — nothing was sent.';
      case 'AMOUNT_BELOW_MINIMUM':
        return 'Amount is below the 0.01 USDC minimum.';
      case 'PAYEE_VERIFICATION_REQUIRED':
        return 'This platform requires a verified identity for new payees. Use a handle already registered on Peer, or pick another platform.';
      case 'PAYEE_REGISTRATION_FAILED':
        return 'The payee could not be registered. Check the handle format and try again.';
      case 'SIGNER_CHAIN_MISMATCH':
        return 'Your wallet is on the wrong network. Switch it to Base and try again.';
      case 'SIGNER_CHAIN_UNAVAILABLE':
        return 'Could not read your wallet’s network. Reconnect and make sure it is on Base.';
      case 'ORDER_NOT_FOUND':
      case 'INDEXER_LAG':
        return 'The order is still being indexed — this can take a few seconds. Refresh status in a moment.';
      case 'INDEXER_UNAVAILABLE':
        return 'The Peer indexer is momentarily unavailable. Please retry.';
      case 'ESCROW_PAUSED':
        return 'The protocol escrow is paused right now. Your funds remain withdrawable — try again later.';
      default:
        // Every CashError ships with a ready-made remediation sentence.
        return e.remediation || e.message;
    }
  }
  if (error instanceof Error) return error.message;
  return 'Peer Cash could not start this cash-out. Please try again.';
}
