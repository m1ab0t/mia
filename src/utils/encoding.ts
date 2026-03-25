/**
 * Encoding utilities for format conversion
 */

/**
 * Convert a hex string to base64
 * Used for encoding binary data (like P2P keys) for display/QR code generation
 */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

/**
 * Format bytes as kilobytes with one decimal place
 * Used for human-readable size display in logs
 */
export function formatKilobytes(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}
