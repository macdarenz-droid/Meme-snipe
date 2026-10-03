import qrcode from 'qrcode-generator';

/**
 * Module grid for a QR code (true is dark), byte mode, error correction level M,
 * smallest version that fits. Encoding is done by the qrcode-generator package
 * (docs/DECISIONS.md, Funding screens); no quiet zone is included.
 */
export type QrMatrix = boolean[][];

export function encodeQr(text: string): QrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}
