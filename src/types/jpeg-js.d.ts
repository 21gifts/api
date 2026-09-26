declare module 'pngjs' {
  export class PNG {
    constructor(opts: { width: number; height: number });
    data: Buffer;
    width: number;
    height: number;
    static sync: {
      read(buffer: Buffer): PNG;
      write(png: PNG): Buffer;
    };
  }
}

declare module 'jpeg-js' {
  export function decode(
    bytes: Uint8Array,
    opts?: { useTArray?: boolean; maxResolutionInMP?: number; formatAsRGBA?: boolean },
  ): { width: number; height: number; data: Uint8Array };
  export function encode(
    image: { data: Uint8Array; width: number; height: number },
    quality?: number,
  ): { data: Uint8Array };
}
