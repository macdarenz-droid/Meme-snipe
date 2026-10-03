import { Empty } from '../components/ui.tsx';
import { formatUsd } from '../lib/format.ts';
import type { CostItemView } from './types.ts';

export function CostBreakdown({ costs }: { costs: CostItemView[] }) {
  if (costs.length === 0) return <Empty title="No costs yet" />;
  const total = costs.reduce((s, c) => s + c.usd, 0);
  const max = Math.max(...costs.map((c) => c.usd), 0.000001);
  const sorted = [...costs].sort((a, b) => b.usd - a.usd);
  return (
    <div className="costs">
      <table className="bars">
        <caption className="sr-only">Costs by type</caption>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.label}>
              <th scope="row">{c.label}</th>
              <td className="bar-cell" aria-hidden="true">
                <span className="bar" style={{ width: `${(c.usd / max) * 100}%` }} />
              </td>
              <td className="num">{formatUsd(c.usd)}</td>
              <td className="num muted">{total ? `${Math.round((c.usd / total) * 100)}%` : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td />
            <td className="num">{formatUsd(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
