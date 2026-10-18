// The one log line of a failed startup. These errors name keys or paths, never values: config
// (also a bad GALLERY_* limit), the profile, Vast filters and the object-store setup. Any other
// error is reduced to its name, so nothing it carries can reach the log.
const SAFE = new Set(["ConfigError", "ProfileError", "VastError", "ObjectStoreError"]);

export function startupMessage(err: unknown): string {
  const text = err instanceof Error ? (SAFE.has(err.name) ? err.message : err.name) : "error";
  return `startup failed: ${text}`;
}
