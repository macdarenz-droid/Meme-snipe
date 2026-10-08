// @solana/kit's type declarations name DOM globals: the Web Crypto types `CryptoKey` and `CryptoKeyPair`, and
// `AddEventListenerOptions`. The repository compiles against Node's types only (tsconfig lib es2023, @types/node 22,
// where the last one is module-local), so they are declared here from Node's own types. Types only: nothing here
// exists at run time. Ported from Snipe-solana card C03 (#6 @ 6ae4d62).
import type { webcrypto } from 'node:crypto';

declare global {
  type CryptoKey = webcrypto.CryptoKey;
  type CryptoKeyPair = webcrypto.CryptoKeyPair;
  type AddEventListenerOptions = Exclude<Parameters<EventTarget['addEventListener']>[2], boolean | undefined>;
}
