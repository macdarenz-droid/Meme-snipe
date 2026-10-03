// Special functions and distributions used by the statistics. Pure double-precision math, no dependencies.
// Sources: Lanczos log-gamma (g = 7, n = 9; Numerical Recipes 3rd ed. §6.1); regularized incomplete beta and gamma by
// continued fractions with the modified Lentz method (Numerical Recipes 3rd ed. §6.2, §6.4); normal quantile by
// Acklam's rational approximation refined with Newton steps on the exact CDF.

const EPS = 1e-15;
const FPMIN = 1e-300;
const MAXIT = 1000;

/** The one Lanczos coefficient of magnitude 1,000 or more (its sign is applied in the table). */
const LANCZOS_C2 = 1259.1392167224028;

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -LANCZOS_C2, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0. */
export const logGamma = (x: number): number => {
  if (!(x > 0)) throw new RangeError(`logGamma needs x > 0, got ${x}`);
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
};

const betaContinuedFraction = (a: number, b: number, x: number): number => {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h;
  }
  throw new Error(`incomplete beta did not converge (a=${a}, b=${b}, x=${x})`);
};

/** Regularized incomplete beta I_x(a, b). */
export const incompleteBeta = (x: number, a: number, b: number): number => {
  if (!(a > 0) || !(b > 0)) throw new RangeError(`incompleteBeta needs a, b > 0, got ${a}, ${b}`);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
};

/** Quantile of the Beta(a, b) distribution, by bisection on I_x(a, b) to full double precision. */
export const betaQuantile = (p: number, a: number, b: number): number => {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`p must be in [0, 1], got ${p}`);
  if (p === 0) return 0;
  if (p === 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-17; i++) {
    const mid = (lo + hi) / 2;
    if (incompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

/** Upper regularized incomplete gamma Q(a, x) = 1 − P(a, x). */
export const incompleteGammaUpper = (a: number, x: number): number => {
  if (!(a > 0)) throw new RangeError(`incompleteGammaUpper needs a > 0, got ${a}`);
  if (x <= 0) return 1;
  const lnFront = -x + a * Math.log(x) - logGamma(a);
  if (x < a + 1) {
    // Series for P, then Q = 1 − P.
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let n = 0; n < MAXIT; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) return 1 - sum * Math.exp(lnFront);
    }
    throw new Error(`incomplete gamma series did not converge (a=${a}, x=${x})`);
  }
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAXIT; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return Math.exp(lnFront) * h;
  }
  throw new Error(`incomplete gamma fraction did not converge (a=${a}, x=${x})`);
};

/** Standard normal density. */
export const normalPdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Standard normal CDF Φ(x), via erfc(|x|/√2) = Q(1/2, x²/2) so both tails keep full relative precision. */
export const normalCdf = (x: number): number => {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const tail = 0.5 * incompleteGammaUpper(0.5, (x * x) / 2);
  return x >= 0 ? 1 - tail : tail;
};

const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

const acklam = (p: number): number => {
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }
  if (p > 1 - pLow) return -acklam(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) /
    (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
};

/** Standard normal quantile Φ⁻¹(p). */
export const normalQuantile = (p: number): number => {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`p must be in [0, 1], got ${p}`);
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  if (p > 0.5) return -normalQuantile(1 - p);
  let x = acklam(p);
  for (let i = 0; i < 3; i++) x -= (normalCdf(x) - p) / normalPdf(x);
  return x;
};

/** Student t CDF with ν degrees of freedom. */
export const studentTCdf = (t: number, df: number): number => {
  if (!(df > 0)) throw new RangeError(`df must be > 0, got ${df}`);
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
};

/** Student t quantile with ν degrees of freedom, by bisection on the CDF. */
export const studentTQuantile = (p: number, df: number): number => {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be in (0, 1), got ${p}`);
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  if (p === 0.5) return 0;
  let lo = 0;
  let hi = 1;
  while (studentTCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-15 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};
