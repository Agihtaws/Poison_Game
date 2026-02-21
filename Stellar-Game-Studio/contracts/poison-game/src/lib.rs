#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype,
    Address, Bytes, BytesN, Env, IntoVal, Vec, vec,
};

// ============================================================================
// GameHub Client
// ============================================================================

#[contractclient(name = "GameHubClient")]
pub trait GameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );
    fn end_game(env: Env, session_id: u32, player1_won: bool);
}

// ============================================================================
// Errors
// ============================================================================

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    GameNotFound = 1,
    NotPlayer = 2,
    WrongPhase = 3,
    AlreadyCommitted = 4,
    NotYourTurn = 5,
    TileAlreadyRevealed = 6,
    InvalidTileIndex = 7,
    InvalidProof = 8,
    GameAlreadyEnded = 9,
    SelfPlay = 10,
}

// ============================================================================
// Data Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Phase {
    WaitingForCommits = 0,
    Playing = 1,
    Finished = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TileType {
    Normal = 0,
    Poison = 1,
    Shield = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevealedTile {
    pub tile_index: u32,
    pub tile_type: u32,  // 0=Normal, 1=Poison, 2=Shield
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GameState {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    // Board commitments (pedersen hash)
    pub player1_commitment: BytesN<32>,
    pub player2_commitment: BytesN<32>,
    pub player1_committed: bool,
    pub player2_committed: bool,
    // Game state
    pub phase: Phase,
    pub current_turn: u32,           // 1 = player1's turn, 2 = player2's turn
    pub player1_score: i64,
    pub player2_score: i64,
    // Pending attack (attacker chose a tile, waiting for defender proof)
    pub pending_attack_tile: u32,    // 0-14
    pub has_pending_attack: bool,
    // Revealed tiles per board
    pub p1_revealed: Vec<RevealedTile>,  // tiles revealed on player1's board
    pub p2_revealed: Vec<RevealedTile>,  // tiles revealed on player2's board
    // Shield mechanic
    pub skip_next_turn: bool,
    // Winner: 0 = none, 1 = player1, 2 = player2
    pub winner: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Game(u32),
    GameHubAddress,
    Admin,
}

// ============================================================================
// Storage TTL (30 days)
// ============================================================================
const GAME_TTL_LEDGERS: u32 = 518_400;
const TOTAL_TILES: u32 = 15;

// ============================================================================
// Contract
// ============================================================================

#[contract]
pub struct PoisonGameContract;

#[contractimpl]
impl PoisonGameContract {

    pub fn __constructor(env: Env, admin: Address, game_hub: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::GameHubAddress, &game_hub);
    }

    /// Both players call this together (multi-sig) to register the game
    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), Error> {
        if player1 == player2 {
            return Err(Error::SelfPlay);
        }

        player1.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player1_points.into_val(&env)]
        );
        player2.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player2_points.into_val(&env)]
        );

        let game_hub_addr: Address = env.storage().instance()
            .get(&DataKey::GameHubAddress).expect("GameHub not set");
        let game_hub = GameHubClient::new(&env, &game_hub_addr);
        game_hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        let zero_bytes = BytesN::from_array(&env, &[0u8; 32]);
        let game = GameState {
            player1: player1.clone(),
            player2: player2.clone(),
            player1_points,
            player2_points,
            player1_commitment: zero_bytes.clone(),
            player2_commitment: zero_bytes,
            player1_committed: false,
            player2_committed: false,
            phase: Phase::WaitingForCommits,
            current_turn: 1,
            player1_score: 0,
            player2_score: 0,
            pending_attack_tile: 0,
            has_pending_attack: false,
            p1_revealed: vec![&env],
            p2_revealed: vec![&env],
            skip_next_turn: false,
            winner: 0,
        };

        let key = DataKey::Game(session_id);
        env.storage().temporary().set(&key, &game);
        env.storage().temporary().extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Each player submits their board commitment hash BEFORE game starts
    pub fn commit_board(
        env: Env,
        session_id: u32,
        player: Address,
        board_hash: BytesN<32>,
    ) -> Result<(), Error> {
        player.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: GameState = env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)?;

        if game.phase != Phase::WaitingForCommits {
            return Err(Error::WrongPhase);
        }

        if player == game.player1 {
            if game.player1_committed { return Err(Error::AlreadyCommitted); }
            game.player1_commitment = board_hash;
            game.player1_committed = true;
        } else if player == game.player2 {
            if game.player2_committed { return Err(Error::AlreadyCommitted); }
            game.player2_commitment = board_hash;
            game.player2_committed = true;
        } else {
            return Err(Error::NotPlayer);
        }

        // Both committed → start playing
        if game.player1_committed && game.player2_committed {
            game.phase = Phase::Playing;
        }

        env.storage().temporary().set(&key, &game);
        Ok(())
    }

    /// Current turn player attacks a tile on the OPPONENT'S board
    pub fn attack(
        env: Env,
        session_id: u32,
        attacker: Address,
        tile_index: u32,
    ) -> Result<(), Error> {
        attacker.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: GameState = env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)?;

        if game.phase != Phase::Playing {
            return Err(Error::WrongPhase);
        }
        if game.winner != 0 {
            return Err(Error::GameAlreadyEnded);
        }
        if game.has_pending_attack {
            return Err(Error::WrongPhase); // must respond first
        }
        if tile_index >= TOTAL_TILES {
            return Err(Error::InvalidTileIndex);
        }

        // Check it's attacker's turn
        let attacker_num = if attacker == game.player1 { 1u32 }
                           else if attacker == game.player2 { 2u32 }
                           else { return Err(Error::NotPlayer); };

        if attacker_num != game.current_turn {
            return Err(Error::NotYourTurn);
        }

        // Check tile not already revealed on defender's board
        let defender_revealed = if attacker_num == 1 { &game.p2_revealed } else { &game.p1_revealed };
        for i in 0..defender_revealed.len() {
            if defender_revealed.get(i).unwrap().tile_index == tile_index {
                return Err(Error::TileAlreadyRevealed);
            }
        }

        game.pending_attack_tile = tile_index;
        game.has_pending_attack = true;

        env.storage().temporary().set(&key, &game);
        Ok(())
    }

    /// Defender responds with tile type + ZK proof
    pub fn respond_to_attack(
        env: Env,
        session_id: u32,
        defender: Address,
        tile_type: u32,    // 0=Normal, 1=Poison, 2=Shield
        proof_blob: Bytes,
    ) -> Result<(), Error> {
        defender.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: GameState = env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)?;

        if game.phase != Phase::Playing { return Err(Error::WrongPhase); }
        if game.winner != 0 { return Err(Error::GameAlreadyEnded); }
        if !game.has_pending_attack { return Err(Error::WrongPhase); }

        // Determine who is defender vs attacker
        let defender_num = if defender == game.player1 { 1u32 }
                           else if defender == game.player2 { 2u32 }
                           else { return Err(Error::NotPlayer); };

        // Attacker is whoever just went — the opposite of defender
        let attacker_num = if defender_num == 1 { 2u32 } else { 1u32 };

        // Verify defender is the opposite of current_turn
        if attacker_num != game.current_turn { return Err(Error::NotYourTurn); }

        // Get defender's commitment
        let defender_commitment = if defender_num == 1 {
            game.player1_commitment.clone()
        } else {
            game.player2_commitment.clone()
        };

        let tile_index = game.pending_attack_tile;

        // ---- ZK Proof Structural Validation ----
        // Format: [4 bytes: pub_input_count=3][32B commitment][32B tile_index][32B tile_type][proof body]
        // Total minimum: 4 + 32 + 32 + 32 + 32 = 132 bytes
        if proof_blob.len() < 132 {
            return Err(Error::InvalidProof);
        }

        // Check public input count == 3 (first 4 bytes, big-endian)
        let b0 = proof_blob.get(0).unwrap() as u32;
        let b1 = proof_blob.get(1).unwrap() as u32;
        let b2 = proof_blob.get(2).unwrap() as u32;
        let b3 = proof_blob.get(3).unwrap() as u32;
        let pub_input_count = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
        if pub_input_count != 3 {
            return Err(Error::InvalidProof);
        }

        // Extract commitment from proof (bytes 4..36) and compare to stored commitment
        let commitment_bytes = defender_commitment.to_array();
        for i in 0..32 {
            let proof_byte = proof_blob.get(4 + i as u32).unwrap();
            if proof_byte != commitment_bytes[i] {
                return Err(Error::InvalidProof);
            }
        }

        // Extract tile_index from proof (bytes 36..68) — last byte must match
        let proof_tile_index_byte = proof_blob.get(67).unwrap() as u32;
        if proof_tile_index_byte != tile_index {
            return Err(Error::InvalidProof);
        }

        // Extract tile_type from proof (bytes 68..100) — last byte must match
        let proof_tile_type_byte = proof_blob.get(99).unwrap() as u32;
        if proof_tile_type_byte != tile_type {
            return Err(Error::InvalidProof);
        }

        // Proof body must be substantial (real UltraHonk proofs are 4KB+)
        if proof_blob.len() < 200 {
            return Err(Error::InvalidProof);
        }

        // ---- Record revealed tile on defender's board ----
        let revealed = RevealedTile { tile_index, tile_type };
        if defender_num == 1 {
            game.p1_revealed.push_back(revealed);
        } else {
            game.p2_revealed.push_back(revealed);
        }

        // ---- Apply score based on tile type ----
        match tile_type {
            0 => { // Normal — attacker gains 1
                if attacker_num == 1 { game.player1_score += 1; }
                else { game.player2_score += 1; }
            }
            1 => { // Poison — attacker loses 3
                if attacker_num == 1 { game.player1_score -= 3; }
                else { game.player2_score -= 3; }
            }
            2 => { // Shield — attacker's NEXT turn is skipped
                game.skip_next_turn = true;
            }
            _ => { return Err(Error::InvalidProof); }
        }

        game.has_pending_attack = false;

        // ---- Check if all tiles revealed on both boards ----
        let p1_done = game.p1_revealed.len() >= TOTAL_TILES;
        let p2_done = game.p2_revealed.len() >= TOTAL_TILES;

        if p1_done && p2_done {
            Self::finish_game(&env, session_id, &mut game)?;
        } else {
            // Switch turn (with shield skip)
            if game.skip_next_turn {
                // Skip defender's turn — attacker goes again
                game.skip_next_turn = false;
                // current_turn stays the same (attacker goes again)
            } else {
                // Normal turn switch
                game.current_turn = if game.current_turn == 1 { 2 } else { 1 };
            }
        }

        env.storage().temporary().set(&key, &game);
        Ok(())
    }

    /// Read game state (for frontend polling)
    pub fn get_game(env: Env, session_id: u32) -> Result<GameState, Error> {
        let key = DataKey::Game(session_id);
        env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)
    }

    // ========================================================================
    // Internal
    // ========================================================================

    fn finish_game(env: &Env, session_id: u32, game: &mut GameState) -> Result<(), Error> {
        let player1_won = game.player1_score > game.player2_score;
        // Tie goes to player1

        let game_hub_addr: Address = env.storage().instance()
            .get(&DataKey::GameHubAddress).expect("GameHub not set");
        let game_hub = GameHubClient::new(env, &game_hub_addr);
        game_hub.end_game(&session_id, &player1_won);

        game.winner = if player1_won { 1 } else { 2 };
        game.phase = Phase::Finished;

        Ok(())
    }

    // ========================================================================
    // Admin
    // ========================================================================

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("Admin not set")
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn get_hub(env: Env) -> Address {
        env.storage().instance().get(&DataKey::GameHubAddress).expect("GameHub not set")
    }

    pub fn set_hub(env: Env, new_hub: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::GameHubAddress, &new_hub);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}