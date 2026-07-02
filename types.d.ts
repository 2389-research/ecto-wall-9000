// ABOUTME: Ambient type declarations for ECTO-WALL 9000's no-build-step JS.
// ABOUTME: Covers CDN URL imports (MediaPipe) and shared landmark shapes used across modules.

/** MediaPipe Tasks Vision is imported at runtime from a pinned CDN URL. */
declare module 'https://*';

/** A single normalized landmark as produced by MediaPipe (before display mapping). */
interface MPLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}
