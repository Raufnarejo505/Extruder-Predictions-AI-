import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  ReferenceLine,
  ReferenceArea,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

interface SensorChartProps {
  /** Sensor/metric name */
  sensorName: string;
  /** Current value */
  currentValue: number | null | undefined;
  /** Baseline mean */
  baselineMean: number | null | undefined;
  /** Green band (min/max) */
  greenBand: { min: number; max: number } | null | undefined;
  /** Historical data points for live curve */
  historicalData: Array<{ timestamp: string | Date; value: number }>;
  /** Current severity: 0=green, 1=orange, 2=red, -1=unknown */
  severity: number | null | undefined;
  /** Deviation from baseline (absolute or percentage) */
  deviation: number | null | undefined;
  /** Baseline material ID */
  baselineMaterial: string | null | undefined;
  /** Stability state: "green" | "orange" | "red" | "unknown" */
  stability?: string | null | undefined;
  /** Material change events for vertical markers */
  materialChanges?: Array<{ material_id: string; timestamp: string }>;
  /** Unit for display */
  unit: string;
  /** Whether baseline is ready */
  baselineReady: boolean;
  /** Whether machine is in PRODUCTION state */
  isInProduction: boolean;
  /** Chart height */
  height?: number;
}

export const SensorChart: React.FC<SensorChartProps> = ({
  sensorName,
  currentValue,
  baselineMean,
  greenBand,
  historicalData,
  severity,
  deviation,
  baselineMaterial,
  stability,
  materialChanges = [],
  unit,
  baselineReady,
  isInProduction,
  height = 300,
}) => {
  // Determine curve color based on severity
  const curveColor = useMemo(() => {
    if (severity === 2) return '#ef4444'; // red-500
    if (severity === 1) return '#f59e0b'; // amber-500
    if (severity === 0) return '#10b981'; // emerald-500
    return '#94a3b8'; // slate-400 (unknown/neutral)
  }, [severity]);

  // Prepare chart data
  const chartData = useMemo(() => {
    return historicalData.map((point) => {
      const timestampDate = typeof point.timestamp === 'string' ? new Date(point.timestamp) : point.timestamp;
      return {
        timestamp: typeof point.timestamp === 'string' ? point.timestamp : point.timestamp.toISOString(),
        value: point.value,
        // Format timestamp for display
        timeLabel: timestampDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
        // Store timestamp as Date object for comparison
        timestampDate: timestampDate,
      };
    });
  }, [historicalData]);
  
  // Prepare material change markers (find closest data points)
  const materialChangeMarkers = useMemo(() => {
    if (!materialChanges || materialChanges.length === 0 || chartData.length === 0) {
      return [];
    }
    
    return materialChanges
      .map((change) => {
        const changeTime = new Date(change.timestamp);
        // Find the closest data point
        let closestPoint = chartData[0];
        let minDiff = Math.abs(changeTime.getTime() - closestPoint.timestampDate.getTime());
        
        for (const point of chartData) {
          const diff = Math.abs(changeTime.getTime() - point.timestampDate.getTime());
          if (diff < minDiff) {
            minDiff = diff;
            closestPoint = point;
          }
        }
        
        // Only include if within reasonable time range (e.g., within 1 hour of chart data)
        const maxDiff = 60 * 60 * 1000; // 1 hour in milliseconds
        if (minDiff <= maxDiff) {
          return {
            x: closestPoint.timeLabel,
            material_id: change.material_id,
            timestamp: change.timestamp,
          };
        }
        return null;
      })
      .filter((marker): marker is { x: string; material_id: string; timestamp: string } => marker !== null);
  }, [materialChanges, chartData]);

  // Status text
  const statusText = useMemo(() => {
    if (severity === 2) return '🔴 RED - Critical deviation';
    if (severity === 1) return '🟠 ORANGE - Slight deviation';
    if (severity === 0) return '🟢 GREEN - Within baseline';
    return '⚪ UNKNOWN - No evaluation';
  }, [severity]);

  // Deviation text
  const deviationText = useMemo(() => {
    if (deviation === null || deviation === undefined) return null;
    const absDev = Math.abs(deviation);
    const pctDev = baselineMean && baselineMean !== 0 
      ? ((absDev / baselineMean) * 100).toFixed(1) 
      : null;
    
    if (pctDev) {
      return `Deviation: ${deviation > 0 ? '+' : ''}${deviation.toFixed(2)} ${unit} (${pctDev}%)`;
    }
    return `Deviation: ${deviation > 0 ? '+' : ''}${deviation.toFixed(2)} ${unit}`;
  }, [deviation, baselineMean, unit]);

  // Don't show chart if not in PRODUCTION or baseline not ready
  if (!isInProduction || !baselineReady) {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 flex items-center justify-center" style={{ height }}>
        <div className="text-center">
          <p className="text-slate-600 font-medium mb-2">
            Baseline comparison available only during active production.
          </p>
          <p className="text-sm text-slate-500">
            {!isInProduction && `Machine state: ${isInProduction ? 'PRODUCTION' : 'Not in PRODUCTION'}`}
            {!baselineReady && 'Baseline not ready'}
          </p>
        </div>
      </div>
    );
  }

  // Don't show chart if no baseline data
  if (!baselineMean || !greenBand) {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 flex items-center justify-center" style={{ height }}>
        <div className="text-center">
          <p className="text-slate-600 font-medium mb-2">
            Baseline data not available
          </p>
          <p className="text-sm text-slate-500">
            Waiting for baseline calculation...
          </p>
        </div>
      </div>
    );
  }

  // Chart domain calculation
  const allValues = [
    ...chartData.map(d => d.value),
    baselineMean,
    greenBand.min,
    greenBand.max,
    currentValue,
  ].filter((v): v is number => v !== null && v !== undefined);

  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const range = maxValue - minValue;
  const padding = range * 0.1; // 10% padding

  const yDomain = [minValue - padding, maxValue + padding];

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      {/* Chart Header */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-lg font-semibold text-slate-900">{sensorName}</h3>
          {/* Stability Dot Indicator */}
          {stability && stability !== 'unknown' && (
            <div
              className="w-3 h-3 rounded-full"
              style={{
                backgroundColor:
                  stability === 'green' ? '#10b981' :
                  stability === 'orange' ? '#f59e0b' :
                  stability === 'red' ? '#ef4444' : '#94a3b8',
              }}
              title={`Stability: ${stability}`}
            />
          )}
        </div>
        {baselineMaterial && (
          <p className="text-xs text-slate-600">
            Baseline (Material: <span className="font-medium">{baselineMaterial}</span>)
          </p>
        )}
        {!baselineMaterial && (
          <p className="text-xs text-slate-600">Baseline</p>
        )}
      </div>

      {/* Status and Deviation Info */}
      <div className="mb-4 flex flex-wrap gap-4 text-sm">
        <div>
          <span className="font-medium text-slate-700">Status: </span>
          <span className={severity === 2 ? 'text-rose-600' : severity === 1 ? 'text-amber-600' : severity === 0 ? 'text-emerald-600' : 'text-slate-500'}>
            {statusText}
          </span>
        </div>
        {deviationText && (
          <div>
            <span className="font-medium text-slate-700">Deviation: </span>
            <span className={Math.abs(deviation || 0) > (baselineMean * 0.1) ? 'text-amber-600' : 'text-slate-600'}>
              {deviationText}
            </span>
          </div>
        )}
        {currentValue !== null && currentValue !== undefined && (
          <div>
            <span className="font-medium text-slate-700">Current: </span>
            <span className="font-semibold" style={{ color: curveColor }}>
              {currentValue.toFixed(2)} {unit}
            </span>
          </div>
        )}
      </div>

      {/* Chart */}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="timeLabel"
              tick={{ fill: '#64748b', fontSize: 11 }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={yDomain}
              tick={{ fill: '#64748b', fontSize: 11 }}
              label={{ value: unit, angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: '#64748b' } }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#ffffff',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
              }}
              labelStyle={{ color: '#1e293b', fontWeight: '600' }}
              formatter={(value: number, name: string) => {
                if (name === 'value') return [`${value.toFixed(2)} ${unit}`, 'Live Value'];
                if (name === 'baseline') return [`${value.toFixed(2)} ${unit}`, 'Baseline Mean'];
                return [value, name];
              }}
            />
            <Legend
              wrapperStyle={{ paddingTop: '10px' }}
              iconType="line"
            />

            {/* Green Baseline Band (shaded area between min and max) */}
            <ReferenceArea
              y1={greenBand.min}
              y2={greenBand.max}
              fill="#10b981"
              fillOpacity={0.15}
              stroke="none"
            />

            {/* Dashed Baseline Mean Line */}
            <ReferenceLine
              y={baselineMean}
              stroke="#10b981"
              strokeWidth={2}
              strokeDasharray="5 5"
              label={{ value: `Baseline Mean (${baselineMean.toFixed(2)} ${unit})`, position: 'right', fill: '#10b981', fontSize: 11 }}
            />

            {/* Vertical Markers for Material Changes */}
            {materialChangeMarkers.map((marker, index) => (
              <ReferenceLine
                key={`material-change-${index}-${marker.timestamp}`}
                x={marker.x}
                stroke="#6366f1"
                strokeWidth={2}
                strokeDasharray="3 3"
                label={{ 
                  value: `Material: ${marker.material_id}`, 
                  position: 'top', 
                  fill: '#6366f1', 
                  fontSize: 9,
                  offset: 5
                }}
              />
            ))}

            {/* Live Value Curve (colored by status) */}
            <Line
              type="monotone"
              dataKey="value"
              stroke={curveColor}
              strokeWidth={2.5}
              dot={{ fill: curveColor, r: 3 }}
              activeDot={{ r: 5 }}
              name="Live Value"
              isAnimationActive={true}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Chart Footer Info */}
      <div className="mt-4 text-xs text-slate-500 space-y-1">
        <div>
          <span className="font-medium">Green Band:</span> {greenBand.min.toFixed(2)} - {greenBand.max.toFixed(2)} {unit}
        </div>
        <div>
          <span className="font-medium">Baseline Mean:</span> {baselineMean.toFixed(2)} {unit}
        </div>
      </div>
    </div>
  );
};
