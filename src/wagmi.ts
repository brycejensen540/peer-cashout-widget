import { http, createConfig } from 'wagmi';
import { coinbaseWallet, injected } from 'wagmi/connectors';
import { CHAIN } from './config';

// ---------------------------------------------------------------------------
// wagmi config: Base mainnet + the two most common browser wallet connectors.
// The wallet must sign on Base — the Peer Cash SDK rejects other chains with
// SIGNER_CHAIN_MISMATCH. Use only "injected" if you want a lighter build.
// ---------------------------------------------------------------------------

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [
    injected(), // MetaMask, Rabby, Coinbase Wallet browser, Frame, etc.
    coinbaseWallet({ appName: 'Peer Cash-out Widget' }),
  ],
  transports: {
    [CHAIN.id]: http(), // public Base RPC (fine for an MVP; swap for a keyed RPC in prod)
  },
});
