declare const __MIA_VERSION__: string;
declare const __MIA_COMMIT__: string;

// ── Vendor type shims (untyped npm packages) ──────────────────────────────
// Moved from src/p2p/types.d.ts so all ambient declarations live in one place.

declare module 'hyperswarm' {
  import { EventEmitter } from 'events';

  interface SwarmOptions {
    keyPair?: { publicKey: Buffer; secretKey: Buffer };
    seed?: Buffer;
    maxPeers?: number;
    firewall?: (remotePublicKey: Buffer) => boolean;
    dht?: any;
  }

  interface JoinOptions {
    server?: boolean;
    client?: boolean;
  }

  interface Discovery {
    flushed(): Promise<void>;
    destroy(): Promise<void>;
  }

  class Hyperswarm extends EventEmitter {
    constructor(options?: SwarmOptions);
    join(topic: Buffer, options?: JoinOptions): Discovery;
    leave(topic: Buffer): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', listener: (conn: any, info: any) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export default Hyperswarm;
}

declare module 'b4a' {
  export function from(data: string | Buffer | Uint8Array, encoding?: string): Buffer;
  export function toString(buffer: Buffer, encoding?: string): string;
  export function alloc(size: number, fill?: number): Buffer;
  export function allocUnsafe(size: number): Buffer;
  export function concat(buffers: Buffer[]): Buffer;
  export function isBuffer(obj: any): boolean;
  export function equals(a: Buffer, b: Buffer): boolean;
  export function compare(a: Buffer, b: Buffer): number;
  export function copy(source: Buffer, target: Buffer, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
}
