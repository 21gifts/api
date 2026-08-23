declare module 'light-bolt11-decoder' {
  export interface Bolt11Section {
    name?: string;
    value?: string | number;
  }

  export interface DecodedBolt11Invoice {
    sections: Bolt11Section[];
  }

  export function decode(pr: string): DecodedBolt11Invoice;
  export default function decodeDefault(pr: string): DecodedBolt11Invoice;
}
