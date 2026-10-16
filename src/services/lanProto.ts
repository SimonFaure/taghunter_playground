/**
 * LAN protocol of this build - mirrors `LAN_PROTO` in lan_server.rs. Every
 * device of a fleet must run the same one: a mother refuses satellite calls
 * without a matching `X-Lan-Proto` header (HTTP 426), and satellites refuse a
 * mother on another one. Bump ONLY for a breaking LAN change, never per release.
 * Standalone module so api.ts can import it without an import cycle.
 */
export const LAN_PROTO = 2;
export const LAN_PROTO_HEADER = 'X-Lan-Proto';
