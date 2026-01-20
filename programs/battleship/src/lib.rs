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

        let mut game_account =
            LightAccount::<GameState>::new_init(&crate::ID, Some(address), output_state_tree_index);

        game_account.game_id = game_id;
        game_account.grid = grid;
        game_account.ship_cells = ship_cells;
        game_account.hits = 0;
        game_account.attacks_made = 0;
        game_account.is_game_over = false;

        msg!(
            "Game {} created! Ship placed at ({}, {}) {}",
            game_id,
            ship_start_x,
            ship_start_y,
            if is_horizontal {
                "horizontally"
            } else {
                "vertically"
            }
        );

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(game_account)?
            .with_new_addresses(&[
                address_tree_info.into_new_address_params_assigned_packed(address_seed, Some(0))
            ])
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

        // Check game is not over
        if current_game.is_game_over {
            msg!("Game is already over!");
            return Err(BattleshipError::GameOver.into());
        }

        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let mut game_account =
            LightAccount::<GameState>::new_mut(&crate::ID, &account_meta, current_game)?;

        let index = (attack_y as usize * GRID_SIZE) + attack_x as usize;
        let cell = game_account.grid[index];

        // Check if already attacked this cell
        if cell == CELL_HIT || cell == CELL_MISS {
            msg!("Cell ({}, {}) already attacked!", attack_x, attack_y);
            return Err(BattleshipError::AlreadyAttacked.into());
        }

        game_account.attacks_made += 1;

        // Process attack
        if cell == CELL_SHIP {
            game_account.grid[index] = CELL_HIT;
            game_account.hits += 1;
            msg!(
                "💥 HIT at ({}, {})! Hits: {}/{}",
                attack_x,
                attack_y,
                game_account.hits,
                SHIP_LENGTH
            );

            // Check if ship is sunk
            if game_account.hits >= SHIP_LENGTH as u8 {
                game_account.is_game_over = true;
                msg!(
                    "🎉 GAME OVER! Ship sunk in {} attacks!",
                    game_account.attacks_made
                );
            }
        } else {
            game_account.grid[index] = CELL_MISS;
            msg!(
                "💨 MISS at ({}, {}). Attacks: {}",
                attack_x,
                attack_y,
                game_account.attacks_made
            );
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
    pub game_id: u64,                  // Unique game identifier
    pub grid: [u8; GRID_CELLS],        // 5x5 grid (flattened): 0=empty, 1=ship, 2=hit, 3=miss
    pub ship_cells: [u8; SHIP_LENGTH], // Indices where ship is placed
    pub hits: u8,                      // Number of hits on ship
    pub attacks_made: u8,              // Total attacks made
    pub is_game_over: bool,            // True when ship is sunk
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
}
