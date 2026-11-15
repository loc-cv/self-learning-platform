// Engine version, written into snapshots and session logs. A snapshot or replay recorded by
// another engine version is refused or flagged (docs/ARCHITECTURE.md §2.7, §2.8). Bump it when a
// change makes old snapshots unreadable or old replays diverge.
export const ENGINE_VERSION = '0.1.0';
