// Frontend wrapper for the cp210x_driver Rust commands.
//
// Mirrors the Rust DriverState enum in src-tauri/src/cp210x_driver.rs. The
// Rust side serializes the enum as { "kind": "healthy" } etc. via
// #[serde(tag = "kind", rename_all = "snake_case")], so the TS discriminated
// union maps 1:1.
//
// Outside the Tauri runtime (browser dev preview, web build for studio) we
// return { kind: 'unknown' } so the UI can fall back to the manual flow
// instead of pretending it knows the driver state.

import { invoke } from '@tauri-apps/api/core';

export type DriverState =
  | { kind: 'healthy' }
  | { kind: 'blocked_by_policy' }
  | { kind: 'other_error'; code: number }
  | { kind: 'device_absent' }
  | { kind: 'unknown' };

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function checkDriverState(): Promise<DriverState> {
  if (!isTauri()) return { kind: 'unknown' };
  try {
    return await invoke<DriverState>('check_cp210x_driver_state');
  } catch (e) {
    console.error('check_cp210x_driver_state failed:', e);
    return { kind: 'unknown' };
  }
}

export async function installDriver(): Promise<void> {
  if (!isTauri()) throw new Error('installDriver requires the Tauri runtime');
  await invoke('install_cp210x_driver');
}
