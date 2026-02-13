import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useBackendStore } from '../store/backendStore';
import { safeApi } from '../api/safeApi';
import { BackendOnlineBanner } from '../components/BackendOnlineBanner';
import { DashboardSkeleton } from '../components/LoadingSkeleton';
import { useT } from '../i18n/I18nProvider';
import { SensorChart } from '../components/SensorChart';

const gradientClass = "min-h-screen bg-gradient-to-br from-slate-50 via-purple-50/30 to-slate-50 text-slate-900";
const REFRESH_INTERVAL = 3000; // 3 seconds refresh interval
const MIN_FETCH_INTERVAL = 2000; // Minimum time between fetches (throttling)

export default function Dashboard() {
  const t = useT();
  const [overview, setOverview] = useState<any>(null);
  const [predictions, setPredictions] = useState<any[]>([]);
  const [aiStatus, setAiStatus] = useState<any>(null);
  const [mssqlStatus, setMssqlStatus] = useState<any>(null);
  const [mssqlRows, setMssqlRows] = useState<any[]>([]);
  const [mssqlDerived, setMssqlDerived] = useState<any>(null);
  const [machinesStats, setMachinesStats] = useState<any>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [sensorsStats, setSensorsStats] = useState<any>(null);
  const [predictionsStats, setPredictionsStats] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFallback, setIsFallback] = useState(false);
  const [selectedMachine] = useState<string>('BEX 92-28V');
  const [selectedMaterial, setSelectedMaterial] = useState<string>('Material 1');
  const [previousMaterial, setPreviousMaterial] = useState<string | null>(null);
  const [availableMaterials] = useState<string[]>(['Material 1', 'Material 2', 'Material 3']);
  const [materialChanges, setMaterialChanges] = useState<Array<{ material_id: string; timestamp: string }>>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isResetting, setIsResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [machineState, setMachineState] = useState<string>('IDLE');
  const [machineStates, setMachineStates] = useState<any>({});
  const [currentDashboardData, setCurrentDashboardData] = useState<any>(null);
  
  const backendStatus = useBackendStore((state) => state.status);
  const mountedRef = useRef(true);
  const lastFetchRef = useRef<number>(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    mountedRef.current = true;
    
    const fetchDashboardData = async (isInitial = false) => {
      // Throttle: Don't fetch if last fetch was too recent
      const now = Date.now();
      if (!isInitial && (now - lastFetchRef.current < MIN_FETCH_INTERVAL)) {
        return;
      }
      lastFetchRef.current = now;
      
      if (!isInitial) {
        setIsLoading(false); // Don't show loading on refresh
      }
      
      try {
        // Fetch all data in parallel - matching backend endpoints
        const [overviewResult, predictionsResult, aiResult, machinesStatsResult, sensorsStatsResult, predictionsStatsResult, mssqlStatusResult, mssqlLatestResult, mssqlDerivedResult, machineStatesResult, machinesResult, currentDashboardResult, materialChangesResult] = await Promise.all([
          safeApi.get('/dashboard/overview'),
          safeApi.get('/predictions?limit=30&sort=desc'),
          safeApi.get('/ai/status'),
          safeApi.get('/dashboard/machines/stats'),
          safeApi.get('/dashboard/sensors/stats'),
          safeApi.get('/dashboard/predictions/stats'),
          safeApi.get('/dashboard/extruder/status'),
          safeApi.get('/dashboard/extruder/latest?limit=50'),
          safeApi.get('/dashboard/extruder/derived?window_minutes=30'),
          safeApi.get('/machine-state/states/current'),
          safeApi.get('/machines'), // Fetch machines list to match names with IDs
          safeApi.get(`/dashboard/current?material_id=${encodeURIComponent(selectedMaterial)}`), // Single source of truth for dashboard data
          safeApi.get('/dashboard/material/changes?limit=50'), // Fetch material change events for chart markers
        ]);
        
        if (!mountedRef.current) return;
        
        // Debug: Log machine states response
        if (machineStatesResult.data) {
          console.log('Machine States API Response:', machineStatesResult.data);
          Object.entries(machineStatesResult.data).forEach(([machineId, stateInfo]) => {
            console.log(`Machine ${machineId}: state=${stateInfo.state}, confidence=${stateInfo.confidence}`);
          });
        }
        
        const hasFallback = overviewResult.fallback || predictionsResult.fallback || 
                           aiResult.fallback ||
                           machinesStatsResult.fallback || sensorsStatsResult.fallback || predictionsStatsResult.fallback ||
                           mssqlStatusResult.fallback || mssqlLatestResult.fallback || mssqlDerivedResult.fallback ||
                           machineStatesResult.fallback || currentDashboardResult.fallback;
        setIsFallback(hasFallback);
        
        // If AI is offline, disable live updates
        if (aiResult.fallback || (aiResult.data && aiResult.data.status !== 'healthy')) {
          setAutoRefresh(false);
        }
        
        // Batch state updates to prevent multiple re-renders
        if (overviewResult.data) setOverview(overviewResult.data);
        if (predictionsResult.data) setPredictions(Array.isArray(predictionsResult.data) ? predictionsResult.data : []);
        if (aiResult.data) setAiStatus(aiResult.data);
        if (mssqlStatusResult.data) setMssqlStatus(mssqlStatusResult.data);
        if ((mssqlLatestResult.data as any)?.rows) setMssqlRows(((mssqlLatestResult.data as any).rows as any[]) || []);
        if (mssqlDerivedResult.data) setMssqlDerived(mssqlDerivedResult.data);
        if (machinesStatsResult.data) setMachinesStats(machinesStatsResult.data);
        if (sensorsStatsResult.data) setSensorsStats(sensorsStatsResult.data);
        if (predictionsStatsResult.data) setPredictionsStats(predictionsStatsResult.data);
        if (currentDashboardResult.data) {
          setCurrentDashboardData(currentDashboardResult.data);
          // Update machine state from current dashboard data
          if (currentDashboardResult.data.machine_state) {
            setMachineState(currentDashboardResult.data.machine_state);
          }
        }
        
        // Update material changes for chart markers
        if (materialChangesResult.data && materialChangesResult.data.material_changes) {
          setMaterialChanges(materialChangesResult.data.material_changes || []);
        }
        
        // Update machine states
        if (machineStatesResult.data) {
          setMachineStates(machineStatesResult.data);
          
          // Find state for selected machine
          let selectedMachineState = 'IDLE'; // default
          const states = machineStatesResult.data;
          
          // Try to find machine ID from machines list
          let selectedMachineId: string | null = null;
          if (machinesResult.data && Array.isArray(machinesResult.data)) {
            const machine = machinesResult.data.find((m: any) => 
              m.name === selectedMachine || m.id === selectedMachine || String(m.id) === selectedMachine
            );
            if (machine) {
              selectedMachineId = String(machine.id);
              console.log(`Found machine: ${machine.name} (ID: ${selectedMachineId})`);
            }
          }
          
          // If we found a machine ID, use it to find the state
          if (selectedMachineId && states[selectedMachineId]) {
            const stateInfo = states[selectedMachineId] as any;
            if (stateInfo && stateInfo.state) {
              selectedMachineState = stateInfo.state;
              console.log(`✅ Found state for machine ${selectedMachineId}: ${selectedMachineState}`);
            }
          } else {
            // Fallback: use first machine's state if only one machine exists
            const machineIds = Object.keys(states);
            if (machineIds.length === 1) {
              const firstState = states[machineIds[0]] as any;
              if (firstState && firstState.state) {
                selectedMachineState = firstState.state;
                console.log(`Using first (and only) machine state: ${selectedMachineState}`);
              }
            } else if (machineIds.length > 0) {
              // Multiple machines - use the first one as fallback
              const firstState = states[machineIds[0]] as any;
              if (firstState && firstState.state) {
                selectedMachineState = firstState.state;
                console.log(`Using first available machine state: ${selectedMachineState} (from ${machineIds.length} machines)`);
              }
            } else {
              console.warn('No machine states found in API response');
            }
          }
          
          setMachineState(selectedMachineState);
        }
        
      } catch (error) {
        console.error('Dashboard fetch error:', error);
        if (mountedRef.current) {
          setIsFallback(true);
        }
      } finally {
        if (mountedRef.current) {
          setIsLoading(false);
        }
      }
    };
    
    // Initial fetch
    fetchDashboardData(true);
    
    // Real-time updates: Refresh every REFRESH_INTERVAL when online
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    
    intervalRef.current = setInterval(() => {
      if (mountedRef.current && backendStatus === 'online') {
        fetchDashboardData(false);
      }
    }, REFRESH_INTERVAL);
    
    return () => {
      mountedRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [backendStatus]);

  // Calculate anomalies count
  const anomaliesCount = predictions?.filter((p: any) => p.prediction === 'anomaly').length || 0;
  
  if (isLoading) {
    return (
      <div className={gradientClass}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <DashboardSkeleton />
        </div>
      </div>
    );
  }
  
  return (
    <div className={gradientClass}>
      <BackendOnlineBanner />
      <div className="max-w-[1920px] mx-auto px-6 py-6">
        {/* Top Header Section */}
        <div className="mb-8">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-6">
            <div>
              <h1 className="text-3xl text-slate-900 mb-2">
                Extruder Überwachungsdashboard
              </h1>
              <p className="text-slate-600 text-sm">
                Predictive Maintenance für Kunststoffextrusion
              </p>
            </div>
          </div>
          
          {/* Status Cards Row */}
          <div className="flex flex-wrap gap-4">
            <div className="bg-white/95 backdrop-blur-sm border border-slate-200/80 rounded-xl px-5 py-3 shadow-md hover:shadow-lg transition-all duration-300 hover:scale-[1.02] flex-1 min-w-[180px]">
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-2 h-2 rounded-full ${
                  isFallback || !aiStatus ? 'bg-rose-500' : 
                  (aiStatus.status === 'healthy' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500')
                }`}></div>
                <span className="text-xs text-slate-500">AI SERVICE</span>
              </div>
              <div className={`text-base ${
                isFallback || !aiStatus ? 'text-rose-600' : 
                (aiStatus.status === 'healthy' ? 'text-emerald-600' : 'text-amber-600')
              }`}>
                {isFallback || !aiStatus ? 'Offline' : (aiStatus.status === 'healthy' ? 'Healthy' : 'Degraded')}
              </div>
            </div>
            <div className="bg-white/95 backdrop-blur-sm border border-slate-200/80 rounded-xl px-5 py-3 shadow-md hover:shadow-lg transition-all duration-300 hover:scale-[1.02] flex-1 min-w-[180px]">
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-2 h-2 rounded-full ${
                  !mssqlStatus ? 'bg-slate-400' :
                  (!mssqlStatus.configured ? 'bg-amber-500' : 
                  (mssqlStatus.last_error ? 'bg-rose-500' : 'bg-emerald-500 animate-pulse'))
                }`}></div>
                <span className="text-xs text-slate-500">MSSQL</span>
              </div>
              <div className={`text-base ${
                !mssqlStatus ? 'text-slate-600' :
                (!mssqlStatus.configured ? 'text-amber-600' : 
                (mssqlStatus.last_error ? 'text-rose-600' : 'text-emerald-600'))
              }`}>
                {!mssqlStatus
                  ? 'Unknown'
                  : (!mssqlStatus.configured ? 'Not Configured' : (mssqlStatus.last_error ? 'Error' : 'Connected'))}
              </div>
              {mssqlStatus?.last_error ? (
                <div className="text-xs text-rose-700 mt-2 max-w-[260px] truncate" title={String(mssqlStatus.last_error)}>
                  {String(mssqlStatus.last_error)}
                </div>
              ) : null}
            </div>
            <div className="bg-white/95 backdrop-blur-sm border border-slate-200/80 rounded-xl px-5 py-3 shadow-md hover:shadow-lg transition-all duration-300 hover:scale-[1.02] flex-1 min-w-[180px]">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                <span className="text-xs text-slate-500">SYSTEM STATUS</span>
              </div>
              <div className="text-base text-emerald-600">All Systems Operational</div>
            </div>
          </div>
        </div>

        {/* Machine State Display */}
        <div className="bg-white/95 backdrop-blur-sm rounded-2xl p-6 border border-slate-200/80 shadow-lg hover:shadow-xl transition-all duration-300 mb-8">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
            <div className="flex-1">
              <h3 className="text-xl text-slate-900 mb-2">
                Machine State
              </h3>
              <div className="text-sm text-slate-600 leading-relaxed">
                State Definitions: OFF (Machine off/cold) | IDLE (Warm/ready) | HEATING (Warming up) | PRODUCTION (Process running) | COOLING (Cooling down)
              </div>
            </div>
            <div className="text-right lg:text-right">
              <div className="text-sm text-slate-500 mb-2">Current State</div>
              <div className={`inline-block text-xl px-4 py-2 rounded-lg ${
                machineState === 'PRODUCTION' ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' :
                machineState === 'HEATING' ? 'bg-amber-100 text-amber-800 border border-amber-300' :
                machineState === 'COOLING' ? 'bg-blue-100 text-blue-800 border border-blue-300' :
                machineState === 'IDLE' ? 'bg-slate-100 text-slate-800 border border-slate-300' :
                machineState === 'OFF' ? 'bg-red-100 text-red-800 border border-red-300' :
                'bg-gray-100 text-gray-800 border border-gray-300'
              }`}>
                {machineState}
              </div>
              <div className="text-sm text-slate-600 mt-3 space-y-1">
                {machineState === 'PRODUCTION' && <div className="flex items-center gap-2"><span className="text-emerald-600">🟢</span> Process active - Traffic light evaluation enabled</div>}
                {machineState === 'HEATING' && <div className="flex items-center gap-2"><span className="text-amber-600">🔥</span> Warming up - Preparing for production</div>}
                {machineState === 'COOLING' && <div className="flex items-center gap-2"><span className="text-blue-600">❄️</span> Cooling down - Post-production cycle</div>}
                {machineState === 'IDLE' && <div className="flex items-center gap-2"><span className="text-slate-600">⏸️</span> Ready - Waiting for production start</div>}
                {machineState === 'OFF' && <div className="flex items-center gap-2"><span className="text-red-600">🔴</span> Machine off - No heating active</div>}
              </div>
              {/* Learning Mode Indicator */}
              {currentDashboardData?.baseline_status === 'learning' && (
                <div className="mt-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="text-sm text-blue-800 flex items-center gap-2">
                    <span>📚</span> Baseline Learning Mode Active - Alarms Disabled
                  </div>
                </div>
              )}
              {/* Baseline Status */}
              {currentDashboardData?.baseline_status && currentDashboardData.baseline_status !== 'learning' && (
                <div className="mt-3 text-sm">
                  <span className="text-slate-600">Baseline:</span> 
                  <span className={`ml-2 ${
                    currentDashboardData.baseline_status === 'ready' ? 'text-emerald-600' : 
                    currentDashboardData.baseline_status === 'not_ready' ? 'text-amber-600' : 
                    'text-rose-600'
                  }`}>
                    {currentDashboardData.baseline_status === 'ready' ? '✅ Ready' : 
                     currentDashboardData.baseline_status === 'not_ready' ? '⏳ Not Ready' : 
                     '❌ Not Available'}
                  </span>
                </div>
              )}
              {/* Profile Status */}
              {currentDashboardData?.profile_status && (
                <div className="mt-2 text-sm">
                  <span className="text-slate-600">Profile:</span> 
                  <span className={`ml-2 ${
                    currentDashboardData.profile_status === 'active' ? 'text-emerald-600' : 'text-rose-600'
                  }`}>
                    {currentDashboardData.profile_status === 'active' ? '✅ Active' : '❌ Not Available'}
                  </span>
                  {currentDashboardData.profile_id && (
                    <span className="ml-2 text-xs text-slate-400">(ID: {currentDashboardData.profile_id.substring(0, 8)}...)</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Machine and Material Selection - Static Display */}
        <div className="bg-white/95 backdrop-blur-sm rounded-2xl p-6 border border-slate-200/80 shadow-lg hover:shadow-xl transition-all duration-300 mb-8">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:gap-8">
              <div>
                <h2 className="text-lg text-slate-900">
                  Produktionskonfiguration
                </h2>
              </div>
              <div className="px-4 py-2 bg-purple-50 rounded-lg border border-purple-200">
                <p className="text-base text-purple-900">Kunststoffwerk ZITTA GmbH</p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
              <div className="min-w-[140px] sm:min-w-[160px]">
                <label className="block text-xs text-slate-600 mb-2">Maschine</label>
                <div className="bg-white border border-slate-300 rounded-md px-4 py-2 text-sm text-slate-900 whitespace-nowrap text-center">
                  {selectedMachine}
                </div>
              </div>
              <div className="min-w-[140px] sm:min-w-[160px]">
                <label className="block text-xs text-slate-600 mb-2">Material</label>
                <select
                  value={selectedMaterial}
                  onChange={async (e) => {
                    const newMaterial = e.target.value;
                    const oldMaterial = selectedMaterial;
                    
                    // Log material change to backend
                    try {
                      await safeApi.post(`/dashboard/material/change?material_id=${encodeURIComponent(newMaterial)}${oldMaterial ? `&previous_material=${encodeURIComponent(oldMaterial)}` : ''}`);
                    } catch (error) {
                      console.error('Failed to log material change:', error);
                      // Continue even if logging fails
                    }
                    
                    setPreviousMaterial(oldMaterial);
                    setSelectedMaterial(newMaterial);
                    // Trigger data reload when material changes
                    lastFetchRef.current = 0;
                    fetchDashboardData(false);
                  }}
                  className="bg-white border border-slate-300 rounded-md px-4 py-2 text-sm text-slate-900 w-full cursor-pointer hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200"
                >
                  {availableMaterials.map((material) => (
                    <option key={material} value={material}>
                      {material}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* KPI Cards Section */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-8">
          {/* Schneckendrehzahl */}
          <div className="bg-white/95 backdrop-blur-sm rounded-2xl p-6 border border-slate-200/80 shadow-lg hover:shadow-2xl transition-all duration-300 hover:scale-[1.02] relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-50/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            <div className="relative z-10">
              <div className="text-sm text-slate-600 mb-3">Schneckendrehzahl (ScrewSpeed_rpm)</div>
              <div className="text-5xl mb-3">
                <span className={
                  machineState === 'PRODUCTION' ? 
                  (currentDashboardData?.metrics?.ScrewSpeed_rpm?.severity === 2 ? 'text-rose-600' :
                   currentDashboardData?.metrics?.ScrewSpeed_rpm?.severity === 1 ? 'text-amber-600' :
                   currentDashboardData?.metrics?.ScrewSpeed_rpm?.severity === 0 ? 'text-emerald-600' :
                   'text-slate-400') :
                  'text-slate-400'  // Neutral color when not in production
                }>
                  {currentDashboardData?.metrics?.ScrewSpeed_rpm?.current_value !== undefined 
                    ? currentDashboardData.metrics.ScrewSpeed_rpm.current_value.toFixed(1) 
                    : (mssqlRows?.[0]?.ScrewSpeed_rpm ? parseFloat(mssqlRows[0].ScrewSpeed_rpm).toFixed(1) : '--')}
                </span>
                <span className="text-2xl text-slate-500 ml-2">rpm</span>
              </div>
              {/* Baseline Mean */}
              {machineState === 'PRODUCTION' && currentDashboardData?.metrics?.ScrewSpeed_rpm?.baseline_mean !== undefined && (
                <div className="text-xs text-slate-600 mb-1">
                  Baseline Mean: {currentDashboardData.metrics.ScrewSpeed_rpm.baseline_mean.toFixed(1)} rpm
                </div>
              )}
              {/* Green Band */}
              {machineState === 'PRODUCTION' && currentDashboardData?.metrics?.ScrewSpeed_rpm?.green_band && (
                <div className="text-xs text-slate-600 mb-1">
                  Green Band: {currentDashboardData.metrics.ScrewSpeed_rpm.green_band.min.toFixed(1)} - {currentDashboardData.metrics.ScrewSpeed_rpm.green_band.max.toFixed(1)} rpm
                </div>
              )}
              {/* Deviation */}
              {machineState === 'PRODUCTION' && currentDashboardData?.metrics?.ScrewSpeed_rpm?.deviation !== undefined && (
                <div className={`text-xs mb-1 ${
                  Math.abs(currentDashboardData.metrics.ScrewSpeed_rpm.deviation) > 5 ? 'text-amber-600' : 'text-slate-600'
                }`}>
                  Deviation: {currentDashboardData.metrics.ScrewSpeed_rpm.deviation > 0 ? '+' : ''}{currentDashboardData.metrics.ScrewSpeed_rpm.deviation.toFixed(1)} rpm
                </div>
              )}
              <div className="text-xs text-slate-500 mb-1">
                Berechnung: Direkte Messung vom Drehzahlsensor
              </div>
              <div className="text-xs text-slate-500 mb-2">
                Referenz: {machineState === 'PRODUCTION' ? 'Materialabhängiger optimaler Bereich aus Baseline-Daten' : 'Prozessbewertung nur in PRODUCTION Zustand'}
              </div>
              <div className="text-xs text-slate-600">
                {machineState === 'PRODUCTION' ? (
                  <>
                    {currentDashboardData?.metrics?.ScrewSpeed_rpm?.severity === 0 && 
                      "🟢 Schneckendrehzahl stabil. Ruhiger Materialdurchsatz im optimalen Bereich für dieses Material."}
                    {currentDashboardData?.metrics?.ScrewSpeed_rpm?.severity === 1 && 
                      "🟠 Schneckendrehzahl weicht vom Referenzbereich ab. Mögliche Veränderung des Materialdurchsatzes oder beginnende Prozessinstabilität."}
                    {currentDashboardData?.metrics?.ScrewSpeed_rpm?.severity === 2 && 
                      "🔴 Schneckendrehzahl außerhalb des materialabhängigen Betriebsfensters. Risiko für Druckinstabilität, Qualitätsschwankungen oder Werkzeugbelastung."}
                    {currentDashboardData?.metrics?.ScrewSpeed_rpm?.severity === undefined && 
                      "⏳ Bewertung wird berechnet..."}
                  </>
                ) : (
                  `⏸️ Maschine im ${machineState} Zustand - keine Prozessbewertung`
                )}
              </div>
            </div>
          </div>

          {/* Schmelzedruck */}
          <div className="bg-white/95 backdrop-blur-sm rounded-2xl p-6 border border-slate-200/80 shadow-lg hover:shadow-2xl transition-all duration-300 hover:scale-[1.02] relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-50/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            <div className="relative z-10">
              <div className="text-sm text-slate-600 mb-3">Schmelzedruck (Pressure_bar)</div>
              <div className="text-5xl mb-3">
                <span className={
                  machineState === 'PRODUCTION' ? 
                  (currentDashboardData?.metrics?.Pressure_bar?.severity === 2 ? 'text-rose-600' :
                   currentDashboardData?.metrics?.Pressure_bar?.severity === 1 ? 'text-amber-600' :
                   currentDashboardData?.metrics?.Pressure_bar?.severity === 0 ? 'text-emerald-600' :
                   'text-slate-400') :
                  'text-slate-400'  // Neutral color when not in production
                }>
                  {currentDashboardData?.metrics?.Pressure_bar?.current_value !== undefined 
                    ? currentDashboardData.metrics.Pressure_bar.current_value.toFixed(1) 
                    : (mssqlRows?.[0]?.Pressure_bar ? parseFloat(mssqlRows[0].Pressure_bar).toFixed(1) : '--')}
                </span>
                <span className="text-2xl text-slate-500 ml-2">bar</span>
              </div>
              {/* Baseline Mean */}
              {machineState === 'PRODUCTION' && currentDashboardData?.metrics?.Pressure_bar?.baseline_mean !== undefined && (
                <div className="text-xs text-slate-600 mb-1">
                  Baseline Mean: {currentDashboardData.metrics.Pressure_bar.baseline_mean.toFixed(1)} bar
                </div>
              )}
              {/* Green Band */}
              {machineState === 'PRODUCTION' && currentDashboardData?.metrics?.Pressure_bar?.green_band && (
                <div className="text-xs text-slate-600 mb-1">
                  Green Band: {currentDashboardData.metrics.Pressure_bar.green_band.min.toFixed(1)} - {currentDashboardData.metrics.Pressure_bar.green_band.max.toFixed(1)} bar
                </div>
              )}
              {/* Deviation */}
              {machineState === 'PRODUCTION' && currentDashboardData?.metrics?.Pressure_bar?.deviation !== undefined && (
                <div className={`text-xs mb-1 ${
                  Math.abs(currentDashboardData.metrics.Pressure_bar.deviation) > 10 ? 'text-amber-600' : 'text-slate-600'
                }`}>
                  Deviation: {currentDashboardData.metrics.Pressure_bar.deviation > 0 ? '+' : ''}{currentDashboardData.metrics.Pressure_bar.deviation.toFixed(1)} bar
                </div>
              )}
              <div className="text-xs text-slate-500 mb-1">
                Berechnung: Direkte Messung vom Drucksensor im Extruder
              </div>
              <div className="text-xs text-slate-500 mb-2">
                Referenz: {machineState === 'PRODUCTION' ? 'Materialabhängiger optimaler Druckbereich aus historischen Prozessdaten' : 'Prozessbewertung nur in PRODUCTION Zustand'}
              </div>
              <div className="text-xs text-slate-600">
                {machineState === 'PRODUCTION' ? (
                  <>
                    {currentDashboardData?.metrics?.Pressure_bar?.severity === 0 && 
                      "🟢 Prozessdruck stabil. Gleichmäßiger Materialfluss ohne Anzeichen von Verstopfung oder Überlast."}
                    {currentDashboardData?.metrics?.Pressure_bar?.severity === 1 && 
                      "🟠 Abweichender Prozessdruck. Mögliche Änderungen in Materialviskosität, Temperaturverteilung oder beginnende Ablagerungen."}
                    {currentDashboardData?.metrics?.Pressure_bar?.severity === 2 && 
                      "🔴 Kritische Druckabweichung. Erhöhtes Risiko für Werkzeugüberlast, Materialabbau oder Produktionsstopp."}
                    {currentDashboardData?.metrics?.Pressure_bar?.severity === undefined && 
                      "⏳ Bewertung wird berechnet..."}
                  </>
                ) : (
                  `⏸️ Maschine im ${machineState} Zustand - keine Prozessbewertung`
                )}
              </div>
            </div>
          </div>

          {/* Durchschnittstemperatur */}
          <div className="bg-white/95 backdrop-blur-sm rounded-2xl p-6 border border-slate-200/80 shadow-lg hover:shadow-2xl transition-all duration-300 hover:scale-[1.02] relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-amber-50/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            <div className="relative z-10">
              <div className="text-sm text-slate-600 mb-3">Durchschnittstemperatur (Temp_Avg)</div>
              <div className="text-5xl mb-3">
                <span className={
                  machineState === 'PRODUCTION' ? 
                  (currentDashboardData?.metrics?.Temp_Avg?.severity === 2 ? 'text-rose-600' :
                   currentDashboardData?.metrics?.Temp_Avg?.severity === 1 ? 'text-amber-600' :
                   currentDashboardData?.metrics?.Temp_Avg?.severity === 0 ? 'text-emerald-600' :
                   mssqlDerived?.risk?.overall === 'red' ? 'text-rose-600' :
                   mssqlDerived?.risk?.overall === 'yellow' ? 'text-amber-600' :
                   mssqlDerived?.risk?.overall === 'green' ? 'text-emerald-600' :
                   'text-slate-400') :
                  'text-slate-400'  // Neutral color when not in production
                }>
                  {currentDashboardData?.metrics?.Temp_Avg?.current_value !== undefined 
                    ? currentDashboardData.metrics.Temp_Avg.current_value.toFixed(1) 
                    : (mssqlDerived?.derived?.Temp_Avg?.current?.toFixed(1) || '--')}
                </span>
                <span className="text-2xl text-slate-500 ml-2">°C</span>
              </div>
              <div className="text-xs text-slate-500 mb-1">
                Berechnung: (Zone1 + Zone2 + Zone3 + Zone4) ÷ 4
              </div>
              <div className="text-xs text-slate-500 mb-2">
                Referenz: {machineState === 'PRODUCTION' ? 'Materialabhängiger optimaler Temperaturbereich aus Baseline-Daten' : 'Prozessbewertung nur in PRODUCTION Zustand'}
              </div>
              <div className="text-xs text-slate-600">
                {machineState === 'PRODUCTION' ? (
                  <>
                    {currentDashboardData?.metrics?.Temp_Avg?.severity === 0 && 
                      "🟢 Gesamte Temperatur im optimalen Bereich. Gleichmäßige Plastifizierung sichergestellt."}
                    {currentDashboardData?.metrics?.Temp_Avg?.severity === 1 && 
                      "🟠 Temperatur außerhalb des optimalen Bereichs. Anpassung der Heizzone empfohlen."}
                    {currentDashboardData?.metrics?.Temp_Avg?.severity === 2 && 
                      "🔴 Kritische Temperaturabweichung. Risiko für Materialabbau oder unvollständige Plastifizierung."}
                    {currentDashboardData?.metrics?.Temp_Avg?.severity === undefined && 
                      (mssqlDerived?.derived?.Temp_Avg?.current ? (
                        <>
                          {mssqlDerived?.derived?.Temp_Avg?.current >= 180 && mssqlDerived?.derived?.Temp_Avg?.current <= 220 &&
                            "🟢 Gesamte Temperatur im optimalen Bereich. Gleichmäßige Plastifizierung sichergestellt."}
                          {((mssqlDerived?.derived?.Temp_Avg?.current < 180) || (mssqlDerived?.derived?.Temp_Avg?.current > 220)) &&
                            "🟠 Temperatur außerhalb des optimalen Bereichs. Anpassung der Heizzone empfohlen."}
                          {((mssqlDerived?.derived?.Temp_Avg?.current < 160) || (mssqlDerived?.derived?.Temp_Avg?.current > 240)) &&
                            "🔴 Kritische Temperaturabweichung. Risiko für Materialabbau oder unvollständige Plastifizierung."}
                        </>
                      ) : "⏳ Bewertung wird berechnet...")}
                  </>
                ) : (
                  `⏸️ Maschine im ${machineState} Zustand - keine Prozessbewertung`
                )}
              </div>
            </div>
          </div>

          {/* Temperaturspreizung */}
          <div className="bg-white/95 backdrop-blur-sm rounded-2xl p-6 border border-slate-200/80 shadow-lg hover:shadow-2xl transition-all duration-300 hover:scale-[1.02] relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-rose-50/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            <div className="relative z-10">
              <div className="text-sm text-slate-600 mb-3">Temperaturspreizung (Temp_Spread)</div>
              <div className="text-5xl mb-3">
                <span className={
                  currentDashboardData?.spread_status === 'red' ? 'text-rose-600' :
                  currentDashboardData?.spread_status === 'orange' ? 'text-amber-600' :
                  currentDashboardData?.spread_status === 'green' ? 'text-emerald-600' :
                  machineState === 'PRODUCTION' ? 
                  ((mssqlDerived?.derived?.Temp_Spread?.current || 0) > 8 ? 'text-rose-600' :
                   (mssqlDerived?.derived?.Temp_Spread?.current || 0) > 5 ? 'text-amber-600' :
                   'text-emerald-600') :
                  'text-slate-400'  // Neutral color when not in production
                }>
                  {currentDashboardData?.metrics?.Temp_Spread?.current_value !== undefined 
                    ? currentDashboardData.metrics.Temp_Spread.current_value.toFixed(1) 
                    : (mssqlDerived?.derived?.Temp_Spread?.current?.toFixed(1) || '--')}
                </span>
                <span className="text-2xl text-slate-500 ml-2">°C</span>
              </div>
              <div className="text-xs text-slate-500 mb-1">
                Berechnung: Max(Zone1-4) - Min(Zone1-4)
              </div>
              <div className="text-xs text-slate-500 mb-2">
                Referenz: {machineState === 'PRODUCTION' ? '≤5°C optimal, ≤8°C akzeptabel, >8°C kritisch' : 'Prozessbewertung nur in PRODUCTION Zustand'}
              </div>
              <div className="text-xs text-slate-600">
                {machineState === 'PRODUCTION' ? (
                  <>
                    {(currentDashboardData?.spread_status === 'green' || (currentDashboardData?.metrics?.Temp_Spread?.current_value || 0) <= 5) && 
                      "🟢 Homogene Temperaturverteilung. Saubere und gleichmäßige Plastifizierung."}
                    {(currentDashboardData?.spread_status === 'orange' || ((currentDashboardData?.metrics?.Temp_Spread?.current_value || 0) > 5 && (currentDashboardData?.metrics?.Temp_Spread?.current_value || 0) <= 8)) && 
                      "🟠 Temperaturzonen beginnen zu divergieren. Mögliche Heiz- oder Regelabweichungen."}
                    {(currentDashboardData?.spread_status === 'red' || (currentDashboardData?.metrics?.Temp_Spread?.current_value || 0) > 8) && 
                      "🔴 Starke Temperaturspreizung. Hohe Wahrscheinlichkeit für Prozessinstabilität, Sensor- oder Heizprobleme."}
                    {currentDashboardData?.spread_status === 'unknown' && 
                      "⏳ Bewertung wird berechnet..."}
                  </>
                ) : (
                  `⏸️ Maschine im ${machineState} Zustand - keine Prozessbewertung`
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Sensor Charts Section - UI Contract Implementation */}
        {machineState === 'PRODUCTION' && currentDashboardData?.baseline_status === 'ready' && (() => {
          // Prepare historical data for ScrewSpeed_rpm
          const screwSpeedHistorical = (mssqlRows || []).map((row: any, index: number) => ({
            timestamp: row.TrendDate || new Date(Date.now() - ((mssqlRows?.length || 0) - index) * 60000),
            value: parseFloat(row.ScrewSpeed_rpm) || 0,
          })).filter((d: any) => d.value > 0);

          // Prepare historical data for Pressure_bar
          const pressureHistorical = (mssqlRows || []).map((row: any, index: number) => ({
            timestamp: row.TrendDate || new Date(Date.now() - ((mssqlRows?.length || 0) - index) * 60000),
            value: parseFloat(row.Pressure_bar) || 0,
          })).filter((d: any) => d.value > 0);

          // Prepare historical data for Temp_Avg
          const tempAvgHistorical = (mssqlRows || []).map((row: any, index: number) => {
            const temps = [
              parseFloat(row.Temp_Zone1_C),
              parseFloat(row.Temp_Zone2_C),
              parseFloat(row.Temp_Zone3_C),
              parseFloat(row.Temp_Zone4_C),
            ].filter((t): t is number => !isNaN(t) && t > 0);
            const avg = temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : 0;
            return {
              timestamp: row.TrendDate || new Date(Date.now() - ((mssqlRows?.length || 0) - index) * 60000),
              value: avg,
            };
          }).filter((d: any) => d.value > 0);

          return (
            <div className="mb-8">
              <h2 className="text-xl text-slate-900 mb-4">
                Sensor Charts (Baseline Comparison)
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* ScrewSpeed_rpm Chart */}
                <SensorChart
                  key="ScrewSpeed_rpm"
                  sensorName="Schneckendrehzahl (ScrewSpeed_rpm)"
                  currentValue={currentDashboardData?.metrics?.ScrewSpeed_rpm?.current_value}
                  baselineMean={currentDashboardData?.metrics?.ScrewSpeed_rpm?.baseline_mean}
                  greenBand={currentDashboardData?.metrics?.ScrewSpeed_rpm?.green_band}
                  historicalData={screwSpeedHistorical}
                  severity={currentDashboardData?.metrics?.ScrewSpeed_rpm?.severity}
                  deviation={currentDashboardData?.metrics?.ScrewSpeed_rpm?.deviation}
                  baselineMaterial={currentDashboardData?.metrics?.ScrewSpeed_rpm?.baseline?.baseline_material || null}
                  stability={currentDashboardData?.metrics?.ScrewSpeed_rpm?.stability || null}
                  materialChanges={materialChanges}
                  unit="rpm"
                  baselineReady={currentDashboardData?.baseline_status === 'ready'}
                  isInProduction={machineState === 'PRODUCTION'}
                  height={300}
                />

                {/* Pressure_bar Chart */}
                <SensorChart
                  key="Pressure_bar"
                  sensorName="Schmelzedruck (Pressure_bar)"
                  currentValue={currentDashboardData?.metrics?.Pressure_bar?.current_value}
                  baselineMean={currentDashboardData?.metrics?.Pressure_bar?.baseline_mean}
                  greenBand={currentDashboardData?.metrics?.Pressure_bar?.green_band}
                  historicalData={pressureHistorical}
                  severity={currentDashboardData?.metrics?.Pressure_bar?.severity}
                  deviation={currentDashboardData?.metrics?.Pressure_bar?.deviation}
                  baselineMaterial={currentDashboardData?.metrics?.Pressure_bar?.baseline?.baseline_material || null}
                  stability={currentDashboardData?.metrics?.Pressure_bar?.stability || null}
                  materialChanges={materialChanges}
                  unit="bar"
                  baselineReady={currentDashboardData?.baseline_status === 'ready'}
                  isInProduction={machineState === 'PRODUCTION'}
                  height={300}
                />

                {/* Temperature Zones Charts */}
                {['Zone1_C', 'Zone2_C', 'Zone3_C', 'Zone4_C'].map((zone, index) => {
                  const zoneKey = `Temp_${zone}`;
                  const zoneHistorical = (mssqlRows || []).map((row: any, idx: number) => ({
                    timestamp: row.TrendDate || new Date(Date.now() - ((mssqlRows?.length || 0) - idx) * 60000),
                    value: parseFloat(row[zoneKey]) || 0,
                  })).filter((d: any) => d.value > 0);

                  const metricData = currentDashboardData?.metrics?.[zoneKey] || null;
                  const baselineMean = metricData?.baseline_mean || null;
                  const greenBand = metricData?.green_band || null;
                  const currentValue = metricData?.current_value || parseFloat(mssqlRows?.[0]?.[zoneKey]) || null;
                  const severity = metricData?.severity ?? (mssqlDerived?.risk?.sensors[zoneKey] === 'red' ? 2 : 
                                                           mssqlDerived?.risk?.sensors[zoneKey] === 'yellow' ? 1 :
                                                           mssqlDerived?.risk?.sensors[zoneKey] === 'green' ? 0 : null);
                  const deviation = metricData?.deviation || null;
                  const baselineMaterial = metricData?.baseline?.baseline_material || null;
                  const stability = metricData?.stability || null;

                  return (
                    <SensorChart
                      key={zoneKey}
                      sensorName={`Temperatur Zone ${index + 1} (${zoneKey})`}
                      currentValue={currentValue}
                      baselineMean={baselineMean}
                      greenBand={greenBand}
                      historicalData={zoneHistorical}
                      severity={severity}
                      deviation={deviation}
                      baselineMaterial={baselineMaterial}
                      stability={stability}
                      materialChanges={materialChanges}
                      unit="°C"
                      baselineReady={currentDashboardData?.baseline_status === 'ready'}
                      isInProduction={machineState === 'PRODUCTION'}
                      height={300}
                    />
                  );
                })}

                {/* Temp_Avg Chart */}
                <SensorChart
                  key="Temp_Avg"
                  sensorName="Durchschnittstemperatur (Temp_Avg)"
                  currentValue={currentDashboardData?.metrics?.Temp_Avg?.current_value || mssqlDerived?.derived?.Temp_Avg?.current}
                  baselineMean={currentDashboardData?.metrics?.Temp_Avg?.baseline_mean}
                  greenBand={currentDashboardData?.metrics?.Temp_Avg?.green_band}
                  historicalData={tempAvgHistorical}
                  severity={currentDashboardData?.metrics?.Temp_Avg?.severity}
                  deviation={currentDashboardData?.metrics?.Temp_Avg?.deviation}
                  baselineMaterial={currentDashboardData?.metrics?.Temp_Avg?.baseline?.baseline_material || null}
                  stability={currentDashboardData?.metrics?.Temp_Avg?.stability || null}
                  materialChanges={materialChanges}
                  unit="°C"
                  baselineReady={currentDashboardData?.baseline_status === 'ready'}
                  isInProduction={machineState === 'PRODUCTION'}
                  height={300}
                />
              </div>
            </div>
          );
        })()}

        <div className="mb-8">
          <h2 className="text-xl text-slate-900 mb-4">
            Temperaturzonen (Zone 1–4)
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {['Zone1_C', 'Zone2_C', 'Zone3_C', 'Zone4_C'].map((zone, index) => (
              <div key={zone} className="bg-white/95 backdrop-blur-sm rounded-2xl p-5 border border-slate-200/80 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-[1.02]">
                <div className="text-sm text-slate-600 mb-2">Zone {index + 1}</div>
                <div className="text-5xl mb-3">
                  <span className={
                    machineState === 'PRODUCTION' ? 
                    (mssqlDerived?.risk?.sensors[`Temp_${zone}`] === 'red' ? 'text-rose-600' :
                     mssqlDerived?.risk?.sensors[`Temp_${zone}`] === 'yellow' ? 'text-amber-600' :
                     mssqlDerived?.risk?.sensors[`Temp_${zone}`] === 'green' ? 'text-emerald-600' :
                     'text-slate-400') :
                    'text-slate-400'  // Neutral color when not in production
                  }>
                    {mssqlRows?.[0]?.[`Temp_${zone}`] ? parseFloat(mssqlRows[0][`Temp_${zone}`]).toFixed(1) : '--'}
                  </span>
                  <span className="text-3xl text-slate-500 ml-2">°C</span>
                </div>
                <div className="text-xs text-slate-500 mb-1">
                  Berechnung: Direkte Messung von Temperatursensor Zone {index + 1}
                </div>
                <div className="text-xs text-slate-600">
                  {machineState === 'PRODUCTION' ? (
                    <>
                      {mssqlDerived?.risk?.sensors[`Temp_${zone}`] === 'green' && 
                        "🟢 Temperaturzone im materialgerechten Bereich. Saubere Erwärmung ohne Auffälligkeiten."}
                      {mssqlDerived?.risk?.sensors[`Temp_${zone}`] === 'yellow' && 
                        "🟠 Temperaturabweichung festgestellt. Mögliche Änderungen im Heizverhalten oder Materialfluss."}
                      {mssqlDerived?.risk?.sensors[`Temp_${zone}`] === 'red' && 
                        "🔴 Kritische Temperaturabweichung. Risiko für unvollständige Plastifizierung, Materialabbau oder Qualitätsprobleme."}
                    </>
                  ) : (
                    `⏸️ Maschine im ${machineState} Zustand - keine Prozessbewertung`
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Stabilität */}
        <div className="mb-8">
          <h2 className="text-xl text-slate-900 mb-4">
            Stabilität (Time Spread / Fluktuation)
          </h2>
          <div className="bg-white/95 backdrop-blur-sm rounded-2xl p-6 border border-slate-200/80 shadow-lg">
            <div className="text-xs text-slate-500 mb-4">
              Calculation: stability_ratio = window_std / baseline_std
              <br />
              <span className="ml-2">window_std = Standard Deviation over Sliding Window</span>
              <br />
              <span className="ml-2">baseline_std = Learned Basic Standard Deviation</span>
            </div>
            <div className="text-xs text-slate-500 mb-4">
              Referenz:
              <br />
              <span className="ml-2">🟢 Stable: stability_ratio ≤ 1.2</span>
              <br />
              <span className="ml-2">🟠 Fluctuating: 1.2 &lt; stability_ratio ≤ 1.6</span>
              <br />
              <span className="ml-2">🔴 Unstable: stability_ratio &gt; 1.6</span>
              <br />
              <span className="ml-2 italic text-slate-400">
                Tooltip: Increased fluctuation compared to baseline
              </span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <div className="text-sm text-slate-500 mb-2">Prozessstabilität</div>
                <div className="text-2xl mb-2">
                  <span className={
                    machineState === 'PRODUCTION' ? 
                    (anomaliesCount > 2 ? 'text-rose-600' :
                     anomaliesCount > 0 ? 'text-amber-600' :
                     'text-emerald-600') :
                    'text-slate-400'  // Neutral color when not in production
                  }>
                    {anomaliesCount > 2 ? '🔴 Stark schwankend' :
                     anomaliesCount > 0 ? '🟠 Erhöhte Varianz' :
                     '🟢 Geringe Varianz'}
                  </span>
                </div>
                <div className="text-xs text-slate-600">
                  {machineState === 'PRODUCTION' ? (
                    <>
                      {anomaliesCount === 0 && 
                        "🟢 Prozess stabil. Keine ungewöhnlichen Schwankungen."}
                      {anomaliesCount > 0 && anomaliesCount <= 2 && 
                        "🟠 Erhöhte Prozessunruhe. Frühindikator für mögliche Abweichungen."}
                      {anomaliesCount > 2 && 
                        "🔴 Instabiler Prozess. Hohe Wahrscheinlichkeit für Qualitätsprobleme oder Störungen."}
                    </>
                  ) : (
                    `⏸️ Maschine im ${machineState} Zustand - keine Prozessbewertung`
                  )}
                </div>
              </div>
              <div>
                <div className="text-sm text-slate-500 mb-2">Anomalien in letzter Zeit</div>
                <div className="text-2xl mb-2">{anomaliesCount}</div>
                <div className="text-xs text-slate-600">
                  Anzahl der erkannten Abweichungen im Analysefenster
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Prozessbewertung */}
        <div className="mb-8">
          <h2 className="text-xl text-slate-900 mb-4">
            Prozessbewertung (Gesamttext)
          </h2>
          <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-md">
            <div className={`text-lg mb-4 px-4 py-3 rounded-lg ${
              machineState === 'PRODUCTION' ? (
                mssqlDerived?.risk?.overall === 'green' ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' :
                mssqlDerived?.risk?.overall === 'yellow' ? 'bg-amber-100 text-amber-800 border border-amber-300' :
                mssqlDerived?.risk?.overall === 'red' ? 'bg-rose-100 text-rose-800 border border-rose-300' :
                'bg-slate-100 text-slate-800 border border-slate-300'
              ) : 'bg-slate-100 text-slate-800 border border-slate-300'
            }`}>
              {machineState === 'PRODUCTION' ? (
                <>
                  {mssqlDerived?.risk?.overall === 'green' && "🟢 GRÜNER PROZESSZUSTAND"}
                  {mssqlDerived?.risk?.overall === 'yellow' && "🟠 ORANGER PROZESSZUSTAND"}
                  {mssqlDerived?.risk?.overall === 'red' && "🔴 ROTER PROZESSZUSTAND"}
                </>
              ) : (
                `⏸️ Maschine im ${machineState} Zustand - keine Prozessbewertung`
              )}
            </div>
            <div className="text-slate-700 leading-relaxed">
              {machineState === 'PRODUCTION' ? (
                <>
                  {mssqlDerived?.risk?.overall === 'green' && 
                    "Der Extrusionsprozess ist stabil. Alle wesentlichen Parameter liegen im materialabhängigen Referenzbereich. Kein Handlungsbedarf."}
                  {mssqlDerived?.risk?.overall === 'yellow' && 
                    "Der Prozess zeigt Abweichungen vom optimalen Betriebszustand. Empfehlung: Überwachung verstärken und mögliche Ursachen prüfen."}
                  {mssqlDerived?.risk?.overall === 'red' && 
                    "Kritischer Prozesszustand. Hohes Risiko für Chargenverlust oder Anlagenbelastung. Eingriff empfohlen."}
                </>
              ) : (
                `⏸️ Maschine im ${machineState} Zustand - keine Prozessbewertung`
              )}
            </div>
          </div>
        </div>
        
        {/* Bottom Widgets - Removed */}
        
        {/* Live Data Table - Removed */}
        {/* OPC UA Status - Removed */}
      </div>
    </div>
  );
}