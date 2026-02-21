fn main(
    board_layout: [Field; 15],
    salt: Field,
    commitment: pub Field,
    tile_index: pub Field,
    tile_type_result: pub Field,
) {
    // --- Constraint 1: Commitment must match pedersen hash of board + salt ---
    let hash_inputs: [Field; 16] = [
        board_layout[0],  board_layout[1],  board_layout[2],
        board_layout[3],  board_layout[4],  board_layout[5],
        board_layout[6],  board_layout[7],  board_layout[8],
        board_layout[9],  board_layout[10], board_layout[11],
        board_layout[12], board_layout[13], board_layout[14],
        salt
    ];
    let computed_commitment = std::hash::pedersen_hash(hash_inputs);
    assert(computed_commitment == commitment, "Commitment mismatch");

    // --- Constraint 2: tile_index must be valid (0 to 14) ---
    let idx = tile_index as u64;
    assert(idx <= 14, "Tile index out of range");

    // --- Constraint 3: tile at tile_index must match claimed tile_type_result ---
    // Safe dynamic index via loop (avoids any backend indexing issues)
    let mut actual_tile: Field = 0;
    for i in 0..15 {
        if (i as Field) == tile_index {
            actual_tile = board_layout[i];
        }
    }
    assert(actual_tile == tile_type_result, "Tile type mismatch");

    // --- Constraint 4: All tile values must be 0 (Normal), 1 (Poison), or 2 (Shield) ---
    for i in 0..15 {
        let tile = board_layout[i] as u64;
        assert(tile <= 2, "Invalid tile value");
    }

    // --- Constraint 5: Exactly 2 Poison tiles (value == 1) ---
    let mut poison_count: u64 = 0;
    for i in 0..15 {
        if board_layout[i] as u64 == 1 {
            poison_count += 1;
        }
    }
    assert(poison_count == 2, "Must have exactly 2 poison tiles");

    // --- Constraint 6: Exactly 1 Shield tile (value == 2) ---
    let mut shield_count: u64 = 0;
    for i in 0..15 {
        if board_layout[i] as u64 == 2 {
            shield_count += 1;
        }
    }
    assert(shield_count == 1, "Must have exactly 1 shield tile");
}

// ---- Test to print the real commitment hash ----
#[test]
fn get_commitment() {
    // Board: indices 3 and 12 are Poison (1), index 8 is Shield (2), rest Normal (0)
    let layout: [Field; 15] = [0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0];
    let salt: Field = 99999;
    let inputs: [Field; 16] = [
        layout[0],  layout[1],  layout[2],
        layout[3],  layout[4],  layout[5],
        layout[6],  layout[7],  layout[8],
        layout[9],  layout[10], layout[11],
        layout[12], layout[13], layout[14],
        salt
    ];
    let h = std::hash::pedersen_hash(inputs);
    println(h);
}