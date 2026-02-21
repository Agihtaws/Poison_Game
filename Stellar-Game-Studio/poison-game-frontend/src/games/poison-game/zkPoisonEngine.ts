/**
 * zkPoisonEngine.ts
 * =================
 * Browser-side ZK proof engine for the Poison Game.
 *
 * Uses:
 *   @noir-lang/noir_js      — witness generation from circuit
 *   @aztec/bb.js            — UltraHonk proof generation + pedersen hash
 *   @noir-lang/acvm_js      — WASM module (must init before Noir)
 *   @noir-lang/noirc_abi    — WASM module (must init before Noir)
 *
 * Two operations this engine performs:
 *   1. computeBoardHash()    — pedersen_hash([t0..t14, salt])
 *                              This is what gets stored on-chain via commit_board()
 *
 *   2. generateTileProof()   — full UltraHonk proof that:
 *                               - board_layout hashes to commitment
 *                               - tile at tile_index == tile_type_result
 *                               - layout has exactly 2 Poison + 1 Shield
 *                              This is submitted via respond_to_attack()
 *
 * Circuit public inputs order (MUST match main.nr exactly):
 *   [0] commitment       — pedersen hash of board + salt
 *   [1] tile_index       — 0 to 14
 *   [2] tile_type_result — 0=Normal 1=Poison 2=Shield
 */

import { Barretenberg, UltraHonkBackend, Fr } from '@aztec/bb.js';
import { Noir } from '@noir-lang/noir_js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** 0 = Normal, 1 = Poison, 2 = Shield */
export type TileValue = 0 | 1 | 2;

export interface TileProofResult {
  /** Serialized blob to pass directly to respond_to_attack() */
  proofBlob: Buffer;
  /** Raw public inputs (hex strings) — for debugging */
  publicInputs: string[];
  /** How long proof generation took in ms */
  durationMs: number;
}

// ─── Singleton Engine ─────────────────────────────────────────────────────────

class ZkPoisonEngine {
  private static _instance: ZkPoisonEngine | null = null;

  private bb: Barretenberg | null = null;
  private backend: UltraHonkBackend | null = null;
  private noir: Noir | null = null;

  private _ready = false;
  private _initPromise: Promise<void> | null = null;

  // ── Singleton accessor ──────────────────────────────────────────────────────

  static getInstance(): ZkPoisonEngine {
    if (!ZkPoisonEngine._instance) {
      ZkPoisonEngine._instance = new ZkPoisonEngine();
    }
    return ZkPoisonEngine._instance;
  }

  get isReady(): boolean {
    return this._ready;
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  /**
   * Initialize the engine.
   * Safe to call multiple times — caches the promise so it only runs once.
   */
  async init(): Promise<void> {
    if (this._ready) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  private async _doInit(): Promise<void> {
    try {
      console.log('[ZK] Initializing Noir WASM modules...');

      // ── Step 1: Init both WASM modules Noir needs ──────────────────────────
      // These must be initialized BEFORE creating any Noir instance.
      // The ?url suffix is a Vite feature that gives us the WASM file URL at build time.
      const [initACVM, initNoirC] = await Promise.all([
        import('@noir-lang/acvm_js').then((m) => m.default as (w: Response | URL) => Promise<void>),
        import('@noir-lang/noirc_abi').then((m) => m.default as (w: Response | URL) => Promise<void>),
      ]);

      const [acvmUrl, noircUrl] = await Promise.all([
        import('@noir-lang/acvm_js/web/acvm_js_bg.wasm?url').then((m) => m.default as string),
        import('@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm?url').then((m) => m.default as string),
      ]);

      await Promise.all([initACVM(fetch(acvmUrl)), initNoirC(fetch(noircUrl))]);
      console.log('[ZK] Noir WASM modules ready');

      // ── Step 2: Load compiled circuit JSON ────────────────────────────────
      // Copy circuits/poison_game/target/poison_game.json
      // to poison-game-frontend/public/circuit/poison_game.json
      const res = await fetch('/circuit/poison_game.json');
      if (!res.ok) {
        throw new Error(
          `Cannot load circuit JSON: ${res.status} ${res.statusText}.\n` +
          `Make sure you copied circuits/poison_game/target/poison_game.json ` +
          `to poison-game-frontend/public/circuit/poison_game.json`
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const circuit = await res.json() as any;
      console.log('[ZK] Circuit JSON loaded');

      // ── Step 3: Init Barretenberg (single thread — browser safe) ──────────
      // threads: 1 avoids the SharedArrayBuffer requirement (COOP/COEP headers).
      // Multi-thread would be ~2x faster but requires special server config.
      this.bb = await Barretenberg.new({ threads: 1 });
      console.log('[ZK] Barretenberg initialized');

      // ── Step 4: Create Noir executor and UltraHonk backend ────────────────
      this.noir = new Noir(circuit);
      // Pass the barretenberg instance to share the already-initialized WASM
      this.backend = new UltraHonkBackend(circuit.bytecode, this.bb);
      console.log('[ZK] Noir + UltraHonkBackend ready');

      this._ready = true;
      console.log('[ZK] ✅ Engine fully initialized');
    } catch (err) {
      // Reset so caller can retry
      this._initPromise = null;
      this._ready = false;
      console.error('[ZK] Initialization failed:', err);
      throw err;
    }
  }

  private assertReady(): asserts this is { bb: Barretenberg; backend: UltraHonkBackend; noir: Noir } {
    if (!this._ready || !this.bb || !this.backend || !this.noir) {
      throw new Error('ZkPoisonEngine is not initialized. Call await zkPoisonEngine.init() first.');
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Compute the board commitment hash.
   *
   * Matches the Noir circuit constraint exactly:
   *   let hash_inputs: [Field; 16] = [...board_layout, salt];
   *   let computed = std::hash::pedersen_hash(hash_inputs);
   *
   * @param layout  15 tile values (0=Normal, 1=Poison, 2=Shield)
   * @param salt    Random bigint chosen when placing tiles (save to localStorage!)
   * @returns       32-byte Buffer — pass this to commit_board()
   */
  async computeBoardHash(layout: TileValue[], salt: bigint): Promise<Buffer> {
    this.assertReady();

    if (layout.length !== 15) {
      throw new Error(`layout must have exactly 15 tiles, got ${layout.length}`);
    }

    // Build 16 Fr elements: [tile0, tile1, ..., tile14, salt]
    // Fr wraps a BN254 field element — same as Noir's Field type
    const inputs: Fr[] = [
      ...layout.map((t) => new Fr(BigInt(t))),
      new Fr(salt),
    ];

    // hash_index = 0 matches Noir's std::hash::pedersen_hash (no explicit index arg)
    const hashFr = await this.bb.pedersenHash(inputs, 0);

    // toBuffer() returns a 32-byte Uint8Array (big-endian field element)
    const commitment = Buffer.from(hashFr.toBuffer());
    console.log('[ZK] Board commitment:', commitment.toString('hex'));
    return commitment;
  }

  /**
   * Generate a ZK proof for a tile reveal.
   *
   * This proves (without revealing the full board):
   *   - pedersen_hash(board_layout || salt) == commitment  (board is authentic)
   *   - board_layout[tile_index] == tile_type_result        (tile type is honest)
   *   - all tile values are 0, 1, or 2                      (valid board)
   *   - exactly 2 Poison tiles exist                        (no cheating with poisons)
   *   - exactly 1 Shield tile exists                        (no cheating with shields)
   *
   * @param layout      Full 15-tile board (PRIVATE — never sent anywhere)
   * @param salt        The same salt used in computeBoardHash (PRIVATE)
   * @param commitment  The 32-byte commitment already on-chain
   * @param tileIndex   Which tile the opponent attacked (0–14)
   * @param tileType    The actual tile type at tileIndex (0/1/2)
   * @returns           Serialized proof blob for respond_to_attack()
   */
  async generateTileProof(
    layout: TileValue[],
    salt: bigint,
    commitment: Buffer,
    tileIndex: number,
    tileType: TileValue,
  ): Promise<TileProofResult> {
    this.assertReady();

    if (layout.length !== 15) throw new Error('layout must have 15 tiles');
    if (tileIndex < 0 || tileIndex > 14) throw new Error('tileIndex must be 0–14');
    if (![0, 1, 2].includes(tileType)) throw new Error('tileType must be 0, 1, or 2');

    // Verify the claimed tile type matches the actual layout (catch bugs early)
    if (layout[tileIndex] !== tileType) {
      throw new Error(
        `Mismatch: layout[${tileIndex}] = ${layout[tileIndex]} but tileType = ${tileType}. ` +
        `The claimed tile type must match your actual board.`
      );
    }

    console.log(`[ZK] Generating proof: tile[${tileIndex}] = ${['Normal','Poison','Shield'][tileType]}`);

    // ── Build circuit inputs ────────────────────────────────────────────────
    // MUST match the Noir fn main() signature exactly:
    //   board_layout: [Field; 15]   → array of decimal strings
    //   salt: Field                 → decimal string
    //   commitment: pub Field       → hex string with 0x prefix
    //   tile_index: pub Field       → decimal string
    //   tile_type_result: pub Field → decimal string
    const inputs = {
      board_layout: layout.map((t) => t.toString()),
      salt: salt.toString(),
      commitment: '0x' + commitment.toString('hex'),
      tile_index: tileIndex.toString(),
      tile_type_result: tileType.toString(),
    };

    const start = Date.now();

    // ── Step 1: Witness generation ──────────────────────────────────────────
    console.log('[ZK] Generating witness...');
    const { witness } = await this.noir.execute(inputs);
    console.log('[ZK] Witness done in', Date.now() - start, 'ms');

    // ── Step 2: Proof generation ────────────────────────────────────────────
    console.log('[ZK] Generating UltraHonk proof...');
    const proveStart = Date.now();
    const { proof, publicInputs } = await this.backend.generateProof(witness);
    const durationMs = Date.now() - start;
    console.log('[ZK] Proof done in', Date.now() - proveStart, 'ms  (total:', durationMs, 'ms)');
    console.log('[ZK] Public inputs:', publicInputs);
    console.log('[ZK] Proof size:', proof.length, 'bytes');

    // ── Step 3: Self-verify before sending to chain ─────────────────────────
    // Catches any encoding issues before wasting a transaction
    const valid = await this.backend.verifyProof({ proof, publicInputs });
    if (!valid) {
      throw new Error('[ZK] Self-verification FAILED. Proof is invalid — not submitting.');
    }
    console.log('[ZK] ✅ Self-verified OK');

    // ── Step 4: Serialize for contract ─────────────────────────────────────
    const proofBlob = this.serializeProofForChain(proof, publicInputs);

    return { proofBlob, publicInputs, durationMs };
  }

  /**
   * Serialize proof data into the exact byte format the Soroban contract expects.
   *
   * Contract validation in respond_to_attack() checks:
   *   bytes [0..3]   = uint32 BE public input count = 3
   *   bytes [4..35]  = commitment (must == stored player commitment on chain)
   *   byte  [67]     = last byte of tile_index field (must == tile_index)
   *   byte  [99]     = last byte of tile_type field  (must == tile_type)
   *   total length   >= 200 (real UltraHonk proofs are ~4–8 KB, easily passes)
   *
   * Layout:
   *   [4 bytes]   u32 BE = 3
   *   [32 bytes]  public_input[0] = commitment
   *   [32 bytes]  public_input[1] = tile_index
   *   [32 bytes]  public_input[2] = tile_type_result
   *   [N bytes]   proof body (UltraHonk bytes, typically 4–8 KB)
   */
  serializeProofForChain(proof: Uint8Array, publicInputs: string[]): Buffer {
    if (publicInputs.length !== 3) {
      throw new Error(`Expected 3 public inputs, got ${publicInputs.length}`);
    }

    // Header: 4 bytes, uint32 big-endian = 3
    const header = Buffer.alloc(4);
    header.writeUInt32BE(3, 0);

    // Each public input: strip 0x prefix, pad to 64 hex chars (32 bytes), decode
    const pubInputBuffers = publicInputs.map((pi, idx) => {
      const hex = pi.startsWith('0x') ? pi.slice(2) : pi;
      if (hex.length > 64) {
        throw new Error(`Public input ${idx} has ${hex.length} hex chars (max 64 = 32 bytes)`);
      }
      return Buffer.from(hex.padStart(64, '0'), 'hex');
    });

    const proofBody = Buffer.from(proof);
    const result = Buffer.concat([header, ...pubInputBuffers, proofBody]);

    console.log('[ZK] Serialized proof blob:', result.length, 'bytes total');
    return result;
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  /**
   * Generate a cryptographically random salt as a bigint.
   * Call this once when placing tiles and save to localStorage.
   */
  static generateSalt(): bigint {
    const bytes = new Uint8Array(31); // 31 bytes = 248 bits, safely within BN254 field
    crypto.getRandomValues(bytes);
    let salt = 0n;
    for (const b of bytes) {
      salt = (salt << 8n) | BigInt(b);
    }
    return salt;
  }

  /**
   * Save board layout + salt to localStorage.
   * MUST be called immediately after commit_board() succeeds.
   * If this data is lost, the player cannot respond to attacks.
   */
  static saveBoard(sessionId: number, playerNum: 1 | 2, layout: TileValue[], salt: bigint): void {
    const key = `pg_board_${sessionId}_p${playerNum}`;
    localStorage.setItem(key, JSON.stringify({
      layout,
      salt: salt.toString(),
    }));
    console.log('[ZK] Board saved to localStorage, key:', key);
  }

  /**
   * Load board layout + salt from localStorage.
   * Returns null if not found (player needs to re-enter their board).
   */
  static loadBoard(sessionId: number, playerNum: 1 | 2): { layout: TileValue[]; salt: bigint } | null {
    const key = `pg_board_${sessionId}_p${playerNum}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      const { layout, salt } = JSON.parse(raw);
      return { layout: layout as TileValue[], salt: BigInt(salt) };
    } catch {
      return null;
    }
  }

  /**
   * Clear saved board from localStorage after game is over.
   */
  static clearBoard(sessionId: number, playerNum: 1 | 2): void {
    const key = `pg_board_${sessionId}_p${playerNum}`;
    localStorage.removeItem(key);
  }
}

// Export singleton instance
export const zkPoisonEngine = ZkPoisonEngine.getInstance();
export { ZkPoisonEngine };