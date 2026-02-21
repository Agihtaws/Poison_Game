import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CCA3BQE4O4BXRWVZW4ASD2CKQ443ZCSH73JN25G43IO7ILUOVCI7R4LP",
  }
} as const

export const Errors = {
  1: {message:"GameNotFound"},
  2: {message:"NotPlayer"},
  3: {message:"WrongPhase"},
  4: {message:"AlreadyCommitted"},
  5: {message:"NotYourTurn"},
  6: {message:"TileAlreadyRevealed"},
  7: {message:"InvalidTileIndex"},
  8: {message:"InvalidProof"},
  9: {message:"GameAlreadyEnded"},
  10: {message:"SelfPlay"}
}

export enum Phase {
  WaitingForCommits = 0,
  Playing = 1,
  Finished = 2,
}

export type DataKey = {tag: "Game", values: readonly [u32]} | {tag: "GameHubAddress", values: void} | {tag: "Admin", values: void};

export enum TileType {
  Normal = 0,
  Poison = 1,
  Shield = 2,
}


export interface GameState {
  current_turn: u32;
  has_pending_attack: boolean;
  p1_revealed: Array<RevealedTile>;
  p2_revealed: Array<RevealedTile>;
  pending_attack_tile: u32;
  phase: Phase;
  player1: string;
  player1_commitment: Buffer;
  player1_committed: boolean;
  player1_points: i128;
  player1_score: i64;
  player2: string;
  player2_commitment: Buffer;
  player2_committed: boolean;
  player2_points: i128;
  player2_score: i64;
  skip_next_turn: boolean;
  winner: u32;
}


export interface RevealedTile {
  tile_index: u32;
  tile_type: u32;
}

export interface Client {
  /**
   * Construct and simulate a attack transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current turn player attacks a tile on the OPPONENT'S board
   */
  attack: ({session_id, attacker, tile_index}: {session_id: u32, attacker: string, tile_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_hub: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_hub: ({new_hub}: {new_hub: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read game state (for frontend polling)
   */
  get_game: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<GameState>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a start_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Both players call this together (multi-sig) to register the game
   */
  start_game: ({session_id, player1, player2, player1_points, player2_points}: {session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a commit_board transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Each player submits their board commitment hash BEFORE game starts
   */
  commit_board: ({session_id, player, board_hash}: {session_id: u32, player: string, board_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a respond_to_attack transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Defender responds with tile type + ZK proof
   */
  respond_to_attack: ({session_id, defender, tile_type, proof_blob}: {session_id: u32, defender: string, tile_type: u32, proof_blob: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, game_hub}: {admin: string, game_hub: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, game_hub}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACgAAAAAAAAAMR2FtZU5vdEZvdW5kAAAAAQAAAAAAAAAJTm90UGxheWVyAAAAAAAAAgAAAAAAAAAKV3JvbmdQaGFzZQAAAAAAAwAAAAAAAAAQQWxyZWFkeUNvbW1pdHRlZAAAAAQAAAAAAAAAC05vdFlvdXJUdXJuAAAAAAUAAAAAAAAAE1RpbGVBbHJlYWR5UmV2ZWFsZWQAAAAABgAAAAAAAAAQSW52YWxpZFRpbGVJbmRleAAAAAcAAAAAAAAADEludmFsaWRQcm9vZgAAAAgAAAAAAAAAEEdhbWVBbHJlYWR5RW5kZWQAAAAJAAAAAAAAAAhTZWxmUGxheQAAAAo=",
        "AAAAAwAAAAAAAAAAAAAABVBoYXNlAAAAAAAAAwAAAAAAAAARV2FpdGluZ0ZvckNvbW1pdHMAAAAAAAAAAAAAAAAAAAdQbGF5aW5nAAAAAAEAAAAAAAAACEZpbmlzaGVkAAAAAg==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAwAAAAEAAAAAAAAABEdhbWUAAAABAAAABAAAAAAAAAAAAAAADkdhbWVIdWJBZGRyZXNzAAAAAAAAAAAAAAAAAAVBZG1pbgAAAA==",
        "AAAAAwAAAAAAAAAAAAAACFRpbGVUeXBlAAAAAwAAAAAAAAAGTm9ybWFsAAAAAAAAAAAAAAAAAAZQb2lzb24AAAAAAAEAAAAAAAAABlNoaWVsZAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAACUdhbWVTdGF0ZQAAAAAAABIAAAAAAAAADGN1cnJlbnRfdHVybgAAAAQAAAAAAAAAEmhhc19wZW5kaW5nX2F0dGFjawAAAAAAAQAAAAAAAAALcDFfcmV2ZWFsZWQAAAAD6gAAB9AAAAAMUmV2ZWFsZWRUaWxlAAAAAAAAAAtwMl9yZXZlYWxlZAAAAAPqAAAH0AAAAAxSZXZlYWxlZFRpbGUAAAAAAAAAE3BlbmRpbmdfYXR0YWNrX3RpbGUAAAAABAAAAAAAAAAFcGhhc2UAAAAAAAfQAAAABVBoYXNlAAAAAAAAAAAAAAdwbGF5ZXIxAAAAABMAAAAAAAAAEnBsYXllcjFfY29tbWl0bWVudAAAAAAD7gAAACAAAAAAAAAAEXBsYXllcjFfY29tbWl0dGVkAAAAAAAAAQAAAAAAAAAOcGxheWVyMV9wb2ludHMAAAAAAAsAAAAAAAAADXBsYXllcjFfc2NvcmUAAAAAAAAHAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAAEnBsYXllcjJfY29tbWl0bWVudAAAAAAD7gAAACAAAAAAAAAAEXBsYXllcjJfY29tbWl0dGVkAAAAAAAAAQAAAAAAAAAOcGxheWVyMl9wb2ludHMAAAAAAAsAAAAAAAAADXBsYXllcjJfc2NvcmUAAAAAAAAHAAAAAAAAAA5za2lwX25leHRfdHVybgAAAAAAAQAAAAAAAAAGd2lubmVyAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAADFJldmVhbGVkVGlsZQAAAAIAAAAAAAAACnRpbGVfaW5kZXgAAAAAAAQAAAAAAAAACXRpbGVfdHlwZQAAAAAAAAQ=",
        "AAAAAAAAADpDdXJyZW50IHR1cm4gcGxheWVyIGF0dGFja3MgYSB0aWxlIG9uIHRoZSBPUFBPTkVOVCdTIGJvYXJkAAAAAAAGYXR0YWNrAAAAAAADAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAhhdHRhY2tlcgAAABMAAAAAAAAACnRpbGVfaW5kZXgAAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAAA",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAACZSZWFkIGdhbWUgc3RhdGUgKGZvciBmcm9udGVuZCBwb2xsaW5nKQAAAAAACGdldF9nYW1lAAAAAQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAEAAAPpAAAH0AAAAAlHYW1lU3RhdGUAAAAAAAAD",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAEBCb3RoIHBsYXllcnMgY2FsbCB0aGlzIHRvZ2V0aGVyIChtdWx0aS1zaWcpIHRvIHJlZ2lzdGVyIHRoZSBnYW1lAAAACnN0YXJ0X2dhbWUAAAAAAAUAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAAB3BsYXllcjEAAAAAEwAAAAAAAAAHcGxheWVyMgAAAAATAAAAAAAAAA5wbGF5ZXIxX3BvaW50cwAAAAAACwAAAAAAAAAOcGxheWVyMl9wb2ludHMAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAEJFYWNoIHBsYXllciBzdWJtaXRzIHRoZWlyIGJvYXJkIGNvbW1pdG1lbnQgaGFzaCBCRUZPUkUgZ2FtZSBzdGFydHMAAAAAAAxjb21taXRfYm9hcmQAAAADAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAAAAAAACmJvYXJkX2hhc2gAAAAAA+4AAAAgAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIZ2FtZV9odWIAAAATAAAAAA==",
        "AAAAAAAAACtEZWZlbmRlciByZXNwb25kcyB3aXRoIHRpbGUgdHlwZSArIFpLIHByb29mAAAAABFyZXNwb25kX3RvX2F0dGFjawAAAAAAAAQAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAACGRlZmVuZGVyAAAAEwAAAAAAAAAJdGlsZV90eXBlAAAAAAAABAAAAAAAAAAKcHJvb2ZfYmxvYgAAAAAADgAAAAEAAAPpAAAAAgAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    attack: this.txFromJSON<Result<void>>,
        get_hub: this.txFromJSON<string>,
        set_hub: this.txFromJSON<null>,
        upgrade: this.txFromJSON<null>,
        get_game: this.txFromJSON<Result<GameState>>,
        get_admin: this.txFromJSON<string>,
        set_admin: this.txFromJSON<null>,
        start_game: this.txFromJSON<Result<void>>,
        commit_board: this.txFromJSON<Result<void>>,
        respond_to_attack: this.txFromJSON<Result<void>>
  }
}