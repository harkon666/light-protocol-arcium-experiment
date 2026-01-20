import { Noir } from '@noir-lang/noir_js';
import initNoirC from '@noir-lang/noirc_abi';
import initACVM from '@noir-lang/acvm_js';

// @ts-ignore - JSON import
import battleshipCircuit from '../circuits/battleship.json';

let noirInstance: Noir | null = null;
let wasmInitialized = false;

/**
 * Initialize WASM modules for browser
 */
async function initWasm(): Promise<void> {
  if (wasmInitialized) return;

  // Initialize WASM modules
  await Promise.all([
    initACVM(),
    initNoirC()
  ]);

  wasmInitialized = true;
}

/**
 * Initialize Noir instance (singleton pattern)
 */
export async function initNoir(): Promise<Noir> {
  if (noirInstance) return noirInstance;

  // Must init WASM first in browser
  await initWasm();

  noirInstance = new Noir(battleshipCircuit as any);
  return noirInstance;
}

/**
 * Generate a Pedersen Hash commitment for a ship placement
 * 
 * @param x - Ship start X coordinate (0-4)
 * @param y - Ship start Y coordinate (0-4)  
 * @param orientation - 0 = horizontal, 1 = vertical
 * @param salt - Random number for privacy
 * @returns Hex string of the 32-byte hash
 */
export async function generateBoardHash(
  x: number,
  y: number,
  orientation: number,
  salt: bigint
): Promise<string> {
  const noir = await initNoir();

  const input = {
    ship_x: x,
    ship_y: y,
    orientation: orientation,
    salt: salt.toString()
  };

  const { returnValue } = await noir.execute(input);

  // Convert Field to hex string
  const hashHex = returnValue.toString();
  const hex = hashHex.replace(/^0x/, '');
  const paddedHex = hex.padStart(64, '0');

  return paddedHex;
}

/**
 * Generate a cryptographically secure random salt
 */
export function generateRandomSalt(): bigint {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  let hex = '';
  for (const byte of array) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return BigInt('0x' + hex);
}
