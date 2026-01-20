#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::{prelude::*, AnchorDeserialize, AnchorSerialize};
use light_sdk::{
    account::LightAccount,
    address::v2::derive_address,
    cpi::{v2::CpiAccounts, CpiSigner},
    derive_light_cpi_signer,
    instruction::{account_meta::CompressedAccountMeta, PackedAddressTreeInfo, ValidityProof},
    LightDiscriminator,
};
use light_sdk_types::ADDRESS_TREE_V2;

declare_id!("3gogNiRRhYTAT5UJUh4QCQ7XksCgrRr8dhGGMqjM3HLp");

pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("3gogNiRRhYTAT5UJUh4QCQ7XksCgrRr8dhGGMqjM3HLp");

/// Grid constants
pub const GRID_SIZE: usize = 5;
pub const GRID_CELLS: usize = GRID_SIZE * GRID_SIZE; // 25 cells
pub const SHIP_LENGTH: usize = 4;

/// Cell states
pub const CELL_EMPTY: u8 = 0;
pub const CELL_SHIP: u8 = 1;
pub const CELL_HIT: u8 = 2;
pub const CELL_MISS: u8 = 3;

#[program]
pub mod battleship {
    use super::*;
    use light_sdk::cpi::{
        v2::LightSystemProgramCpi, InvokeLightSystemProgram, LightCpiInstruction,
    };

    /// Creates a new game with ship placement
    /// ship_start_x, ship_start_y: Starting coordinates (0-4)
    /// is_horizontal: true = horizontal placement, false = vertical
    pub fn create_game<'info>(
        ctx: Context<'_, '_, '_, 'info, GameAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        game_id: u64,
        ship_start_x: u8,
        ship_start_y: u8,
        is_horizontal: bool,
        board_hash: [u8; 32],
    ) -> Result<()> {
        // Validate ship placement
        if ship_start_x >= GRID_SIZE as u8 || ship_start_y >= GRID_SIZE as u8 {
            msg!("Invalid ship start position");
            return Err(BattleshipError::InvalidPosition.into());
        }

        // Check ship fits in grid
        if is_horizontal {
            if ship_start_x + SHIP_LENGTH as u8 > GRID_SIZE as u8 {
                msg!("Ship doesn't fit horizontally");
                return Err(BattleshipError::ShipOutOfBounds.into());
            }
        } else {
            if ship_start_y + SHIP_LENGTH as u8 > GRID_SIZE as u8 {
                msg!("Ship doesn't fit vertically");
                return Err(BattleshipError::ShipOutOfBounds.into());
            }
        }

        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let address_tree_pubkey = address_tree_info
            .get_tree_pubkey(&light_cpi_accounts)
            .map_err(|_| ErrorCode::AccountNotEnoughKeys)?;

        if address_tree_pubkey.to_bytes() != ADDRESS_TREE_V2 {
            msg!("Invalid address tree");
            return Err(ProgramError::InvalidAccountData.into());
        }

        let (address, address_seed) = derive_address(
            &[b"battleship", &game_id.to_le_bytes()],
            &address_tree_pubkey,
            &crate::ID,
        );
        msg!("Derived Address: {:?}", address);
        msg!("Program ID: {:?}", crate::ID);

        // Initialize grid with empty cells
        let mut grid = [CELL_EMPTY; GRID_CELLS];
        let mut ship_cells = [0u8; SHIP_LENGTH];

        // Place ship on grid
        for i in 0..SHIP_LENGTH {
            let (x, y) = if is_horizontal {
                (ship_start_x + i as u8, ship_start_y)
            } else {
                (ship_start_x, ship_start_y + i as u8)
            };
            let index = (y as usize * GRID_SIZE) + x as usize;
            grid[index] = CELL_SHIP;
            ship_cells[i] = index as u8;
        }

        msg!(
            "Game {} created by {:?}! Waiting for Player B.",
            game_id,
            ctx.accounts.signer.key()
        );

        let mut game_account =
            LightAccount::<GameState>::new_init(&crate::ID, Some(address), output_state_tree_index);

        game_account.game_id = game_id;
        game_account.player_a = ctx.accounts.signer.key();
        game_account.player_b = Pubkey::default();
        game_account.current_turn = 1; // Player A starts
        game_account.game_status = 0; // Waiting for B

        // Init Player A
        game_account.grid_a = grid;
        game_account.board_hash_a = board_hash;
        game_account.hits_a = 0;

        // Init Player B (Empty)
        game_account.grid_b = [CELL_EMPTY; GRID_CELLS];
        game_account.board_hash_b = [0u8; 32];
        game_account.hits_b = 0;

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(game_account)?
            .with_new_addresses(&[
                address_tree_info.into_new_address_params_assigned_packed(address_seed, Some(0))
            ])
            .invoke(light_cpi_accounts)?;

        Ok(())
    }

    /// Join an existing game as Player B
    /// ship_start_x, ship_start_y: Starting coordinates (0-4)
    /// is_horizontal: true = horizontal placement, false = vertical
    pub fn join_game<'info>(
        ctx: Context<'_, '_, '_, 'info, GameAccounts<'info>>,
        proof: ValidityProof,
        current_game: GameState,
        account_meta: CompressedAccountMeta,
        ship_start_x: u8,
        ship_start_y: u8,
        is_horizontal: bool,
        board_hash: [u8; 32],
    ) -> Result<()> {
        // Validate game status
        if current_game.game_status != 0 {
            msg!("Game is not in waiting state (Status: {})", current_game.game_status);
            return Err(ProgramError::InvalidAccountData.into());
        }

        // Validate ship placement
         if ship_start_x >= GRID_SIZE as u8 || ship_start_y >= GRID_SIZE as u8 {
            msg!("Invalid ship start position");
            return Err(BattleshipError::InvalidPosition.into());
        }

        // Check ship fits in grid
        if is_horizontal {
            if ship_start_x + SHIP_LENGTH as u8 > GRID_SIZE as u8 {
                msg!("Ship doesn't fit horizontally");
                return Err(BattleshipError::ShipOutOfBounds.into());
            }
        } else {
            if ship_start_y + SHIP_LENGTH as u8 > GRID_SIZE as u8 {
                msg!("Ship doesn't fit vertically");
                return Err(BattleshipError::ShipOutOfBounds.into());
            }
        }

        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let mut game_account =
            LightAccount::<GameState>::new_mut(&crate::ID, &account_meta, current_game)?;

        // Set Player B
        game_account.player_b = ctx.accounts.signer.key();
        game_account.game_status = 1; // Active

        // Initialize grid B with empty cells
        let mut grid = [CELL_EMPTY; GRID_CELLS];
        let mut ship_cells = [0u8; SHIP_LENGTH];

        // Place ship on grid B
        for i in 0..SHIP_LENGTH {
            let (x, y) = if is_horizontal {
                (ship_start_x + i as u8, ship_start_y)
            } else {
                (ship_start_x, ship_start_y + i as u8)
            };
            let index = (y as usize * GRID_SIZE) + x as usize;
            grid[index] = CELL_SHIP;
            ship_cells[i] = index as u8;
        }

        game_account.grid_b = grid;
        game_account.board_hash_b = board_hash;
        game_account.hits_b = 0;

        msg!(
            "Player B joined! Game {} is now Active! Ship at ({}, {})",
            game_account.game_id,
            ship_start_x,
            ship_start_y
        );

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(game_account)?
            .invoke(light_cpi_accounts)?;

        Ok(())
    }
    /// Attack a cell at (x, y) coordinates
    pub fn attack<'info>(
        ctx: Context<'_, '_, '_, 'info, GameAccounts<'info>>,
        proof: ValidityProof,
        current_game: GameState,
        account_meta: CompressedAccountMeta,
        attack_x: u8,
        attack_y: u8,
    ) -> Result<()> {
        // Validate coordinates
        if attack_x >= GRID_SIZE as u8 || attack_y >= GRID_SIZE as u8 {
            msg!("Attack coordinates out of bounds");
            return Err(BattleshipError::InvalidPosition.into());
        }

        // Check game is active
        if current_game.game_status != 1 {
            msg!("Game is not active!");
            return Err(BattleshipError::GameOver.into());
        }

        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let mut game_account =
            LightAccount::<GameState>::new_mut(&crate::ID, &account_meta, current_game)?;


        // Determine target grid and update logic based on turn
        if game_account.current_turn == 1 {
            // Player A attacking Player B
            if game_account.player_a != ctx.accounts.signer.key() {
                msg!("Not Player A's turn!");
                return Err(BattleshipError::NotPlayerTurn.into());
            }

            let index = (attack_y as usize * GRID_SIZE) + attack_x as usize;
            let cell = game_account.grid_b[index];

            if cell == CELL_HIT || cell == CELL_MISS {
                msg!("Cell ({}, {}) already attacked!", attack_x, attack_y);
                return Err(BattleshipError::AlreadyAttacked.into());
            }

            if cell == CELL_SHIP {
                game_account.grid_b[index] = CELL_HIT;
                game_account.hits_b += 1;
                msg!("💥 HIT on Player B!");
                if game_account.hits_b >= SHIP_LENGTH as u8 {
                    game_account.game_status = 2; // A Won
                    msg!("🎉 Player A Wins!");
                }
            } else {
                game_account.grid_b[index] = CELL_MISS;
                msg!("💨 MISS on Player B.");
            }
            
            // Switch turn to B
            game_account.current_turn = 2;
        } else {
            // Player B attacking Player A
            if game_account.player_b != ctx.accounts.signer.key() {
                msg!("Not Player B's turn!");
                return Err(BattleshipError::NotPlayerTurn.into());
            }

            let index = (attack_y as usize * GRID_SIZE) + attack_x as usize;
            let cell = game_account.grid_a[index];

            if cell == CELL_HIT || cell == CELL_MISS {
                msg!("Cell ({}, {}) already attacked!", attack_x, attack_y);
                return Err(BattleshipError::AlreadyAttacked.into());
            }

            if cell == CELL_SHIP {
                game_account.grid_a[index] = CELL_HIT;
                game_account.hits_a += 1;
                msg!("� HIT on Player A!");
                if game_account.hits_a >= SHIP_LENGTH as u8 {
                    game_account.game_status = 3; // B Won
                    msg!("🎉 Player B Wins!");
                }
            } else {
                game_account.grid_a[index] = CELL_MISS;
                msg!("💨 MISS on Player A.");
            }

            // Switch turn to A
            game_account.current_turn = 1;
        }

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(game_account)?
            .invoke(light_cpi_accounts)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct GameAccounts<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
}

/// The game state stored as a compressed account
#[event]
#[derive(Clone, Debug, Default, LightDiscriminator)]
pub struct GameState {
    pub game_id: u64,
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub current_turn: u8, // 1 = A, 2 = B
    pub game_status: u8,  // 0 = Waiting, 1 = Active, 2 = A Won, 3 = B Won

    // Player A
    pub grid_a: [u8; GRID_CELLS],
    pub board_hash_a: [u8; 32], // Noir Pedersen Hash (bytes)
    pub hits_a: u8,

    // Player B
    pub grid_b: [u8; GRID_CELLS],
    pub board_hash_b: [u8; 32], // Noir Pedersen Hash (bytes)
    pub hits_b: u8,
}

#[error_code]
pub enum BattleshipError {
    #[msg("Invalid position: coordinates out of bounds")]
    InvalidPosition,
    #[msg("Ship placement out of bounds")]
    ShipOutOfBounds,
    #[msg("Cell already attacked")]
    AlreadyAttacked,
    #[msg("Game is already over")]
    GameOver,
    #[msg("Not player's turn")]
    NotPlayerTurn,
}
