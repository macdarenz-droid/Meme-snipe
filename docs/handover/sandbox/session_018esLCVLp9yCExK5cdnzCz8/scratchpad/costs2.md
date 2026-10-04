Conservative scenario, PumpSwap: an exit attempt fails 44% of the time and each failure pays 155,000 lamports (0.7728 expected); rent back 85.5%; a close that fails without dust pays one more failed attempt. SOL $119.26.

| Setup | Size | Fee/side | Fees+impact (both legs) | Fixed (lamports) | Fixed % | Break-even move | Break-even, no rent back |
|---|---|---|---|---|---|---|---|
| young PumpSwap (at migration, ~411 SOL cap) | $2 | 1.25% | 2.51% | 414,009 | 2.47% | **4.98%** | 12.69% |
| young PumpSwap (at migration, ~411 SOL cap) | $5 | 1.25% | 2.56% | 414,009 | 0.99% | **3.55%** | 6.64% |
| young PumpSwap (at migration, ~411 SOL cap) | $20 | 1.25% | 2.85% | 414,009 | 0.25% | **3.09%** | 3.87% |
| U1 survivor ($50k quote, ~9995 SOL cap) | $2 | 0.95% | 1.89% | 414,009 | 2.47% | **4.36%** | 12.08% |
| U1 survivor ($50k quote, ~9995 SOL cap) | $5 | 0.95% | 1.90% | 414,009 | 0.99% | **2.89%** | 5.98% |
| U1 survivor ($50k quote, ~9995 SOL cap) | $20 | 0.95% | 1.96% | 414,009 | 0.25% | **2.21%** | 2.98% |
| U1 survivor at the 1.15% tier (upper bound) | $2 | 1.15% | 2.28% | 414,009 | 2.47% | **4.75%** | 12.47% |
| U1 survivor at the 1.15% tier (upper bound) | $5 | 1.15% | 2.29% | 414,009 | 0.99% | **3.28%** | 6.37% |
| U1 survivor at the 1.15% tier (upper bound) | $20 | 1.15% | 2.35% | 414,009 | 0.25% | **2.60%** | 3.37% |

| Setup | Size | +10/−5 | +20/−10 | +30/−15 | +50/−20 |
|---|---|---|---|---|---|
| young | $2 | 66.5% | 49.9% | 44.4% | 35.7% |
| young | $5 | 57.0% | 45.2% | 41.2% | 33.6% |
| young | $20 | 54.0% | 43.6% | 40.2% | 33.0% |
| u1 | $2 | 62.4% | 47.9% | 43.0% | 34.8% |
| u1 | $5 | 52.6% | 43.0% | 39.8% | 32.7% |
| u1 | $20 | 48.0% | 40.7% | 38.2% | 31.7% |
| u1-1.15 | $2 | 65.0% | 49.2% | 43.9% | 35.4% |
| u1-1.15 | $5 | 55.2% | 44.3% | 40.6% | 33.3% |
| u1-1.15 | $20 | 50.7% | 42.0% | 39.1% | 32.3% |
