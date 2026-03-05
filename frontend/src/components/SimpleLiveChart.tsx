import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

export interface SimpleLiveChartDataPoint {
  timestamp: string | Date;
  value: number;
}

export interface SimpleLiveChartProps {
  /** Chart title (e.g. "Temperaturspreizung (Temp_Spread)") */
  title: string;
  /** Optional legend/subtitle (e.g. "Bewertung ohne Baseline: ≤5°C 🟢, 5–8°C 🟠, >8°C 🔴") */
  legend?: string;
  /** Data points with timestamp and value */
  data: SimpleLiveChartDataPoint[];
  /** Y-axis unit (e.g. "°C", "bar", "rpm") */
  unit: string;
  /** Line (and dots) color (default green) */
  lineColor?: string;
  /** Chart height in pixels */
  height?: number;
}

/**
 * Simple live line chart matching the Temperaturspreizung (Temp_Spread) style:
 * time on X-axis, value on Y-axis, continuous line with dots, grid, tooltip.
 * Use this for all sensor charts so they display consistently.
 */
export const SimpleLiveChart: React.FC<SimpleLiveChartProps> = ({
  title,
  legend,
  data,
  unit,
  lineColor = '#10b981',
  height = 300,
}) => {
  const chartData = React.useMemo(() => {
    return data.map((d) => {
      const ts = typeof d.timestamp === 'string' ? new Date(d.timestamp) : d.timestamp;
      return {
        ...d,
        timeLabel: ts.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
      };
    });
  }, [data]);

  // Y-axis domain: use data range with minimum span so near-constant data doesn't look like a flat line at the edge
  const yDomain = React.useMemo((): [number, number] => {
    const values = chartData.map((d) => Number(d.value)).filter((v) => typeof v === 'number' && !isNaN(v));
    if (values.length === 0) return [0, 100];
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const minRange = Math.max(mean * 0.02, 1, range * 1.1);
    const half = minRange / 2;
    if (range < minRange * 0.5) {
      return [mean - half, mean + half];
    }
    const padding = range * 0.05 || 1;
    return [minVal - padding, maxVal + padding];
  }, [chartData]);

  return (
    <div className="bg-white/95 backdrop-blur-sm border-2 border-slate-200/80 rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all duration-300">
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <h3 className="text-xl font-bold text-slate-900">{title}</h3>
        </div>
        {legend && (
          <p className="text-xs text-slate-600">
            {legend}
          </p>
        )}
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="timeLabel"
              tick={{ fill: '#64748b', fontSize: 11 }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={yDomain}
              tick={{ fill: '#64748b', fontSize: 11 }}
              tickFormatter={(value: number) => Number(value).toFixed(0)}
              label={{
                value: unit,
                angle: -90,
                position: 'insideLeft',
                style: { textAnchor: 'middle', fill: '#64748b' },
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#ffffff',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
              }}
              labelStyle={{ color: '#1e293b', fontWeight: '600' }}
              // Show the exact data value (2 decimals) while Y-axis ticks stay integers
              formatter={(value: number) => [`${Number(value).toFixed(2)} ${unit}`, title]}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={lineColor}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5 }}
              name={title}
              isAnimationActive={true}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
