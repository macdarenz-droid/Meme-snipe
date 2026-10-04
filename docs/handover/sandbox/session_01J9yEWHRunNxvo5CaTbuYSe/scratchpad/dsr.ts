import { deflatedSharpe, skewness, kurtosis } from '/home/user/Meme-snipe/packages/core/src/stats/index.ts';
const registry = Array.from({ length: 20 }, (_, i) => ({ trialId: `t${i}`, sharpe: 0.05 + 0.004 * i, nTrades: 600 }));
for (let b = 0.24; b <= 0.4; b += 0.005) {
  const r = Array.from({ length: 600 }, (_, i) => (i % 10 < 3 ? b : -0.1));
  const u = deflatedSharpe(r, registry).dsr, c = deflatedSharpe(r, registry, { clamp: true }).dsr;
  if (u >= 0.95 && c < 0.95) console.log(b.toFixed(3), u.toFixed(4), c.toFixed(4), skewness(r).toFixed(3), kurtosis(r).toFixed(3));
}
