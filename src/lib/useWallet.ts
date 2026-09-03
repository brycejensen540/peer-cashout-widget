import { useAccount, useConnect, useConnectorClient, useDisconnect, useSwitchChain } from 'wagmi';
import { CHAIN } from '../config';

// ---------------------------------------------------------------------------
// Shared wallet state for every widget screen. One hook instead of repeating
// the wagmi spread in each form.
// ---------------------------------------------------------------------------

export function useWallet() {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useConnectorClient();

  return {
    address,
    isConnected,
    chainId,
    connectors,
    connect,
    isConnecting,
    disconnect,
    switchChain,
    isSwitching,
    walletClient,
    onWrongChain: isConnected && chainId != null && chainId !== CHAIN.id,
  };
}