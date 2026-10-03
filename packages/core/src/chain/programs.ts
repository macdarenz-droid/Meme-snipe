// Program and account addresses the decoders check against (docs/ARCHITECTURE.md section 4).
import type { Address } from './bytes.ts';

const a = (s: string) => s as Address;

export const PUMP_PROGRAM = a('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM_PROGRAM = a('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_FEES_PROGRAM = a('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const TOKEN_PROGRAM = a('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = a('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ADDRESS_LOOKUP_TABLE_PROGRAM = a('AddressLookupTab1e1111111111111111111111111');
export const SYSTEM_PROGRAM = a('11111111111111111111111111111111');
/** Wrapped SOL (SPL Token) and the Token-2022 native mint. */
export const NATIVE_MINT = a('So11111111111111111111111111111111111111112');
export const NATIVE_MINT_2022 = a('9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP');
export const PUMP_GLOBAL = a('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_FEE_CONFIG = a('8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt');
export const PUMP_AMM_FEE_CONFIG = a('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');
export const PUMP_AMM_GLOBAL_CONFIG = a('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
