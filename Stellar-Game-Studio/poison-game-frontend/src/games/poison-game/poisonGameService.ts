/**
 * poisonGameService.ts
 * ====================
 * Service layer for the Poison Game Soroban contract.
 *
 * Contract: CCA3BQE4O4BXRWVZW4ASD2CKQ443ZCSH73JN25G43IO7ILUOVCI7R4LP
 *
 * Methods in this file:
 *   Multi-sig start flow (both players must sign):
 *     prepareStartGame()       — Player 1: sign auth entry, export XDR
 *     parseAuthEntry()         — Parse Player 1's auth entry to extract session info
 *     importAndSignAuthEntry() — Player 2: inject P1 auth + sign own entry
 *     finalizeStartGame()      — Submit fully-signed transaction
 *     startGame()              — Quickstart: both players sign in one call (dev wallets only)
 *
 *   Single-player game actions (one signature each):
 *     commitBoard()            — Submit board commitment hash (after tile placement)
 *     attack()                 — Pick a tile on opponent's board
 *     respondToAttack()        — Reveal tile type + submit ZK proof
 *
 *   Read-only:
 *     getGame()                — Poll game state (no auth needed)
 */

import {
  Client as PoisonGameClient,
  type GameState,
  Phase,
} from './bindings';
import {
  NETWORK_PASSPHRASE,
  RPC_URL,
  DEFAULT_METHOD_OPTIONS,
  DEFAULT_AUTH_TTL_MINUTES,
  MULTI_SIG_AUTH_TTL_MINUTES,
} from '@/utils/constants';
import {
  contract,
  TransactionBuilder,
  StrKey,
  xdr,
  Address,
  authorizeEntry,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { signAndSendViaLaunchtube } from '@/utils/transactionHelper';
import { calculateValidUntilLedger } from '@/utils/ledgerUtils';
import { injectSignedAuthEntry } from '@/utils/authEntryUtils';
import { getFundedSimulationSourceAddress } from '@/utils/simulationUtils';

type ClientOptions = contract.ClientOptions;

// ─── Service Class ────────────────────────────────────────────────────────────

export class PoisonGameService {
  private baseClient: PoisonGameClient;
  private contractId: string;

  constructor(contractId: string) {
    this.contractId = contractId;
    // Unauthenticated client for read-only calls (getGame)
    this.baseClient = new PoisonGameClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private createSigningClient(
    publicKey: string,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ): PoisonGameClient {
    return new PoisonGameClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey,
      ...signer,
    } as ClientOptions);
  }

  private extractErrorFromDiagnostics(transactionResponse: any): string {
    try {
      console.error('[PoisonGameService] Transaction response:', JSON.stringify(transactionResponse, null, 2));

      const diagnosticEvents =
        transactionResponse?.diagnosticEventsXdr ||
        transactionResponse?.diagnostic_events ||
        [];

      for (const event of diagnosticEvents) {
        if (event?.topics) {
          const topics = Array.isArray(event.topics) ? event.topics : [];
          const hasErrorTopic = topics.some(
            (topic: any) => topic?.symbol === 'error' || topic?.error
          );
          if (hasErrorTopic && event.data) {
            if (typeof event.data === 'string') return event.data;
            if (event.data.vec && Array.isArray(event.data.vec)) {
              const messages = event.data.vec
                .filter((item: any) => item?.string)
                .map((item: any) => item.string);
              if (messages.length > 0) return messages.join(': ');
            }
          }
        }
      }

      const status = transactionResponse?.status || 'Unknown';
      return `Transaction ${status}. Check browser console for details.`;
    } catch {
      return 'Transaction failed with unknown error';
    }
  }

  // ── Read-only ────────────────────────────────────────────────────────────────

  /**
   * Fetch current game state from chain.
   * Returns null if game doesn't exist yet (not an error — expected during lobby).
   */
  async getGame(sessionId: number): Promise<GameState | null> {
    try {
      const tx = await this.baseClient.get_game({ session_id: sessionId });
      const result = await tx.simulate();
      if (result.result.isOk()) {
        return result.result.unwrap();
      }
      console.log('[getGame] Game not found for session:', sessionId);
      return null;
    } catch (err) {
      console.log('[getGame] Error querying game:', err);
      return null;
    }
  }

  // ── Multi-sig start game flow ────────────────────────────────────────────────

  /**
   * STEP 1 — Player 1: prepare transaction and export signed auth entry.
   *
   * Player 1 signs their own auth entry. Does NOT broadcast yet.
   * Returns a base64 XDR string to share with Player 2.
   */
  async prepareStartGame(
    sessionId: number,
    player1: string,
    player2: string,
    player1Points: bigint,
    player2Points: bigint,
    player1Signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<string> {
    // Build with Player 2 as source (they will broadcast)
    const buildClient = new PoisonGameClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: player2,
    });

    const tx = await buildClient.start_game(
      { session_id: sessionId, player1, player2, player1_points: player1Points, player2_points: player2Points },
      DEFAULT_METHOD_OPTIONS
    );

    console.log('[prepareStartGame] Simulated, extracting auth entries');

    if (!tx.simulationData?.result?.auth) {
      throw new Error('No auth entries in simulation — check contract and simulation source');
    }

    const authEntries = tx.simulationData.result.auth;
    console.log('[prepareStartGame] Auth entries found:', authEntries.length);

    // Find Player 1's stubbed auth entry by matching address
    let player1AuthEntry = null;
    for (let i = 0; i < authEntries.length; i++) {
      try {
        const entryAddress = authEntries[i].credentials().address().address();
        const entryStr = Address.fromScAddress(entryAddress).toString();
        console.log(`[prepareStartGame] Entry ${i}:`, entryStr);
        if (entryStr === player1) {
          player1AuthEntry = authEntries[i];
          break;
        }
      } catch {
        continue;
      }
    }

    if (!player1AuthEntry) {
      throw new Error(`Auth entry for Player 1 (${player1}) not found in simulation`);
    }

    const validUntilLedger = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, MULTI_SIG_AUTH_TTL_MINUTES);

    if (!player1Signer.signAuthEntry) {
      throw new Error('Wallet does not support signAuthEntry');
    }

    const signedAuthEntry = await authorizeEntry(
      player1AuthEntry,
      async (preimage) => {
        const signResult = await player1Signer.signAuthEntry!(
          preimage.toXDR('base64'),
          { networkPassphrase: NETWORK_PASSPHRASE, address: player1 }
        );
        if (signResult.error) {
          throw new Error(`signAuthEntry failed: ${signResult.error.message}`);
        }
        return Buffer.from(signResult.signedAuthEntry, 'base64');
      },
      validUntilLedger,
      NETWORK_PASSPHRASE
    );

    const xdrStr = signedAuthEntry.toXDR('base64');
    console.log('[prepareStartGame] ✅ Auth entry signed, XDR length:', xdrStr.length);
    return xdrStr;
  }

  /**
   * Parse Player 1's signed auth entry to extract session ID, player address, and points.
   * Used by Player 2's UI to auto-fill game join form.
   */
  parseAuthEntry(authEntryXdr: string): {
    sessionId: number;
    player1: string;
    player1Points: bigint;
    functionName: string;
  } {
    try {
      const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64');

      const player1 = Address.fromScAddress(
        authEntry.credentials().address().address()
      ).toString();

      const contractFn = authEntry.rootInvocation().function().contractFn();
      const functionName = contractFn.functionName().toString();

      if (functionName !== 'start_game') {
        throw new Error(`Expected start_game, got ${functionName}`);
      }

      const args = contractFn.args();
      if (args.length !== 2) {
        throw new Error(`Expected 2 args in auth entry, got ${args.length}`);
      }

      const sessionId = args[0].u32();
      const player1Points = args[1].i128().lo().toBigInt();

      console.log('[parseAuthEntry]', { sessionId, player1, player1Points: player1Points.toString() });
      return { sessionId, player1, player1Points, functionName };
    } catch (err: any) {
      throw new Error(`Failed to parse auth entry: ${err.message}`);
    }
  }

  /**
   * STEP 2 — Player 2: inject Player 1's auth, sign own auth, return full XDR.
   */
  async importAndSignAuthEntry(
    player1SignedAuthEntryXdr: string,
    player2Address: string,
    player2Points: bigint,
    player2Signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<string> {
    const gameParams = this.parseAuthEntry(player1SignedAuthEntryXdr);

    if (player2Address === gameParams.player1) {
      throw new Error('Cannot play against yourself. Player 2 must be a different wallet.');
    }

    const buildClient = new PoisonGameClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: player2Address,
    });

    const tx = await buildClient.start_game(
      {
        session_id: gameParams.sessionId,
        player1: gameParams.player1,
        player2: player2Address,
        player1_points: gameParams.player1Points,
        player2_points: player2Points,
      },
      DEFAULT_METHOD_OPTIONS
    );

    console.log('[importAndSignAuthEntry] Transaction rebuilt with Player 2');

    const validUntilLedger = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, MULTI_SIG_AUTH_TTL_MINUTES);

    // Inject Player 1's signed auth entry into the transaction
    const txWithInjected = await injectSignedAuthEntry(
      tx,
      player1SignedAuthEntryXdr,
      player2Address,
      player2Signer,
      validUntilLedger
    );
    console.log('[importAndSignAuthEntry] Injected Player 1 auth entry');

    // Player 2 signs their own auth entry if needed
    const player2Client = this.createSigningClient(player2Address, player2Signer);
    const player2Tx = player2Client.txFromXDR(txWithInjected.toXDR());

    const needsSigning = await player2Tx.needsNonInvokerSigningBy();
    console.log('[importAndSignAuthEntry] Still needs signing:', needsSigning);

    if (needsSigning.includes(player2Address)) {
      await player2Tx.signAuthEntries({ expiration: validUntilLedger });
    }

    const result = player2Tx.toXDR();
    console.log('[importAndSignAuthEntry] ✅ Full tx XDR ready for finalize');
    return result;
  }

  /**
   * STEP 3 — Either player: re-simulate and broadcast the fully-signed transaction.
   */
  async finalizeStartGame(
    txXdr: string,
    signerAddress: string,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(signerAddress, signer);
    const tx = client.txFromXDR(txXdr);

    // CRITICAL: must re-simulate after all auth entries are injected
    await tx.simulate();

    const validUntilLedger = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedger
    );
    return sentTx.result;
  }

  /**
   * Quickstart: run the full three-step multi-sig flow using dev wallets.
   * Both signers are provided, so no manual XDR sharing needed.
   */
  async startGame(
    sessionId: number,
    player1: string,
    player2: string,
    player1Points: bigint,
    player2Points: bigint,
    player1Signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    player2Signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ) {
    const placeholder = await getFundedSimulationSourceAddress([player1, player2]);

    const authEntryXdr = await this.prepareStartGame(
      sessionId,
      player1,
      placeholder,
      player1Points,
      player1Points,
      player1Signer
    );

    const fullTxXdr = await this.importAndSignAuthEntry(
      authEntryXdr,
      player2,
      player2Points,
      player2Signer
    );

    return this.finalizeStartGame(fullTxXdr, player2, player2Signer);
  }

  // ── Single-player game actions ───────────────────────────────────────────────

  /**
   * Submit board commitment hash on-chain.
   *
   * Call this AFTER:
   *   1. Player placed their tiles in the UI
   *   2. zkPoisonEngine.computeBoardHash() computed the 32-byte hash
   *   3. ZkPoisonEngine.saveBoard() saved layout+salt to localStorage
   *
   * @param boardHash  32-byte Buffer from zkPoisonEngine.computeBoardHash()
   */
  async commitBoard(
    sessionId: number,
    playerAddress: string,
    boardHash: Buffer,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<void> {
    const client = this.createSigningClient(playerAddress, signer);

    const tx = await client.commit_board(
      {
        session_id: sessionId,
        player: playerAddress,
        board_hash: boardHash,
      },
      DEFAULT_METHOD_OPTIONS
    );

    const validUntilLedger = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedger
      );

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const msg = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        throw new Error(`commit_board failed: ${msg}`);
      }

      console.log('[commitBoard] ✅ Board committed for session', sessionId);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('commit_board transaction failed — check if game is in WaitingForCommits phase');
      }
      throw err;
    }
  }

  /**
   * Attack a tile on the OPPONENT's board.
   *
   * Only callable when:
   *   - game.phase === Phase.Playing
   *   - game.current_turn matches your player number
   *   - game.has_pending_attack === false
   *
   * @param tileIndex  0–14
   */
  async attack(
    sessionId: number,
    attackerAddress: string,
    tileIndex: number,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<void> {
    if (tileIndex < 0 || tileIndex > 14) {
      throw new Error(`tileIndex must be 0–14, got ${tileIndex}`);
    }

    const client = this.createSigningClient(attackerAddress, signer);

    const tx = await client.attack(
      {
        session_id: sessionId,
        attacker: attackerAddress,
        tile_index: tileIndex,
      },
      DEFAULT_METHOD_OPTIONS
    );

    const validUntilLedger = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedger
      );

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const msg = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        throw new Error(`attack failed: ${msg}`);
      }

      console.log('[attack] ✅ Attacked tile', tileIndex, 'in session', sessionId);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('attack transaction failed — check turn, pending attack state, and tile index');
      }
      throw err;
    }
  }

  /**
   * Respond to an incoming attack with tile type + ZK proof.
   *
   * Call this when:
   *   - game.has_pending_attack === true
   *   - You are the defender (the player whose board was attacked)
   *
   * The proof blob comes from zkPoisonEngine.generateTileProof()
   * which auto-reads your layout from localStorage and generates the proof.
   *
   * @param tileType   0=Normal, 1=Poison, 2=Shield
   * @param proofBlob  Buffer from zkPoisonEngine.generateTileProof().proofBlob
   */
  async respondToAttack(
    sessionId: number,
    defenderAddress: string,
    tileType: 0 | 1 | 2,
    proofBlob: Buffer,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<void> {
    if (![0, 1, 2].includes(tileType)) {
      throw new Error(`tileType must be 0, 1, or 2 — got ${tileType}`);
    }
    if (proofBlob.length < 132) {
      throw new Error(`proofBlob too small (${proofBlob.length} bytes) — not a valid ZK proof`);
    }

    const client = this.createSigningClient(defenderAddress, signer);

    const tx = await client.respond_to_attack(
      {
        session_id: sessionId,
        defender: defenderAddress,
        tile_type: tileType,
        proof_blob: proofBlob,
      },
      DEFAULT_METHOD_OPTIONS
    );

    const validUntilLedger = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedger
      );

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const msg = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        throw new Error(`respond_to_attack failed: ${msg}`);
      }

      console.log('[respondToAttack] ✅ Responded with tile type', tileType, 'in session', sessionId);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('respond_to_attack failed — check proof validity and that attack is pending');
      }
      throw err;
    }
  }
}

// ── Export singleton factory ───────────────────────────────────────────────────
// Import POISON_GAME_CONTRACT from constants and pass it here in the component.
// Example: const service = new PoisonGameService(POISON_GAME_CONTRACT);