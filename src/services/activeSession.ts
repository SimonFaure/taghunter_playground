// Tiny module-level signal for "is a launched game currently running".
//
// The launched-game session lives as local state inside GameList.tsx; App.tsx
// has no view of it. The update flow needs to know -- before relaunching to
// apply an update -- whether a game is in progress, so it can warn the
// operator first. Lifting all of GameList's state into App just for this would
// be heavy; a module-level flag GameList sets/clears is enough.
//
// The LAN "mother" session is queried separately via the Rust command
// `client_describe_local_role`; this flag only covers the in-app game view.

let gameActive = false;

export function setGameActive(active: boolean): void {
  gameActive = active;
}

export function isGameActive(): boolean {
  return gameActive;
}
