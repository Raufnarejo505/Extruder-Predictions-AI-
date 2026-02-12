from datetime import datetime, timedelta
from typing import Dict, Any, List, Tuple, Optional
from functools import lru_cache
import time
import os
import re
import statistics

from fastapi import APIRouter, Depends, Query, HTTPException
from loguru import logger
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_session, get_current_user, require_viewer
from app.models.user import User
from app.models.machine import Machine
from app.models.sensor import Sensor
from app.models.prediction import Prediction
from app.models.alarm import Alarm
from app.models.sensor_data import SensorData

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


_extruder_last_attempt_at: datetime | None = None
_extruder_last_success_at: datetime | None = None
_extruder_last_error_at: datetime | None = None
_extruder_last_error: str | None = None

# Simple in-memory cache (can be replaced with Redis)
_cache: Dict[str, tuple] = {}
CACHE_TTL = 10  # seconds - reduced for faster alarm updates


def get_cached(key: str):
    """Get cached value if not expired"""
    if key in _cache:
        value, timestamp = _cache[key]
        if time.time() - timestamp < CACHE_TTL:
            return value
        del _cache[key]
    return None


def set_cached(key: str, value: Any):
    """Set cached value"""
    _cache[key] = (value, time.time())


@router.get("/overview")
async def get_overview(
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(require_viewer),
):
    """Get dashboard overview statistics"""
    cache_key = "dashboard:overview"
    cached = get_cached(cache_key)
    if cached:
        return cached
    
    # Run all queries in parallel for better performance
    import asyncio
    
    yesterday = datetime.utcnow() - timedelta(days=1)
    
    # Execute all queries concurrently using asyncio.gather
    machine_count, sensor_count, active_alarms, recent_predictions, machines_online = await asyncio.gather(
        session.scalar(select(func.count(Machine.id))),
        session.scalar(select(func.count(Sensor.id))),
        session.scalar(select(func.count(Alarm.id)).where(Alarm.status.in_(["open", "acknowledged"]))),
        session.scalar(select(func.count(Prediction.id)).where(Prediction.timestamp >= yesterday)),
        session.scalar(select(func.count(Machine.id)).where(Machine.status == "online")),
        return_exceptions=True
    )
    
    # Handle any exceptions
    machine_count = machine_count if not isinstance(machine_count, Exception) else 0
    sensor_count = sensor_count if not isinstance(sensor_count, Exception) else 0
    active_alarms = active_alarms if not isinstance(active_alarms, Exception) else 0
    recent_predictions = recent_predictions if not isinstance(recent_predictions, Exception) else 0
    machines_online = machines_online if not isinstance(machines_online, Exception) else 0
    
    result = {
        "machines": {
            "total": machine_count or 0,
            "online": machines_online or 0,
        },
        "sensors": {
            "total": sensor_count or 0,
        },
        "alarms": {
            "active": active_alarms or 0,
        },
        "predictions": {
            "last_24h": recent_predictions or 0,
        },
    }
    
    set_cached(cache_key, result)
    return result


@router.get("/extruder/latest")
async def get_extruder_latest_rows(
    current_user: User = Depends(require_viewer),
    limit: int = Query(200, ge=1, le=5000),
):
    global _extruder_last_attempt_at, _extruder_last_success_at, _extruder_last_error_at, _extruder_last_error
    _extruder_last_attempt_at = datetime.utcnow()

    host = (os.getenv("MSSQL_HOST") or "").strip()
    port_raw = (os.getenv("MSSQL_PORT") or "1433").strip()
    user = (os.getenv("MSSQL_USER") or "").strip()
    password = os.getenv("MSSQL_PASSWORD")
    database = (os.getenv("MSSQL_DATABASE") or "HISTORISCH").strip()
    table_raw = (os.getenv("MSSQL_TABLE") or "Tab_Actual").strip()
    schema_raw = (os.getenv("MSSQL_SCHEMA") or "dbo").strip()

    try:
        port = int(port_raw)
    except Exception:
        _extruder_last_error = "Invalid MSSQL_PORT"
        _extruder_last_error_at = datetime.utcnow()
        raise HTTPException(status_code=500, detail="Invalid MSSQL_PORT")

    if not host or not user or not password:
        _extruder_last_error = "MSSQL is not configured"
        _extruder_last_error_at = datetime.utcnow()
        raise HTTPException(status_code=500, detail="MSSQL is not configured")

    schema = schema_raw
    table = table_raw
    if "." in table_raw:
        parts = [p for p in table_raw.split(".") if p]
        if len(parts) != 2:
            _extruder_last_error = "Invalid MSSQL table identifier"
            _extruder_last_error_at = datetime.utcnow()
            raise HTTPException(status_code=500, detail="Invalid MSSQL table identifier")
        schema, table = parts[0], parts[1]

    if not re.fullmatch(r"[A-Za-z0-9_]+", schema or "") or not re.fullmatch(r"[A-Za-z0-9_]+", table or ""):
        _extruder_last_error = "Invalid MSSQL schema/table identifier"
        _extruder_last_error_at = datetime.utcnow()
        raise HTTPException(status_code=500, detail="Invalid MSSQL schema/table identifier")

    def _fetch_sync() -> Dict[str, Any]:
        import pymssql

        table_sql = f"[{schema}].[{table}]"
        # MSSQL 2000 does not support parentheses around TOP value
        query = (
            f"SELECT TOP {int(limit)} "
            f"TrendDate, "
            f"Val_4 AS ScrewSpeed_rpm, "
            f"Val_6 AS Pressure_bar, "
            f"Val_7 AS Temp_Zone1_C, "
            f"Val_8 AS Temp_Zone2_C, "
            f"Val_9 AS Temp_Zone3_C, "
            f"Val_10 AS Temp_Zone4_C "
            f"FROM {table_sql} "
            f"ORDER BY TrendDate DESC"
        )

        s = query.strip().lower()
        if not s.startswith("select") or ";" in s:
            raise ValueError("Unsafe SQL blocked")

        conn = pymssql.connect(
            server=host,
            user=user,
            password=password,
            database=database,
            port=port,
            login_timeout=10,
            timeout=10,
        )
        try:
            try:
                conn.autocommit(True)
            except Exception:
                pass

            cur = conn.cursor(as_dict=True)
            try:
                cur.execute("SET NOCOUNT ON")
                cur.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
            except Exception:
                pass

            cur.execute(query)
            rows = cur.fetchall() or []
            out = []
            for r in rows:
                td = r.get("TrendDate")
                if isinstance(td, datetime):
                    trend_date = td.isoformat()
                elif td is None:
                    trend_date = None
                else:
                    trend_date = str(td)

                out.append(
                    {
                        "TrendDate": trend_date,
                        "ScrewSpeed_rpm": r.get("ScrewSpeed_rpm"),
                        "Pressure_bar": r.get("Pressure_bar"),
                        "Temp_Zone1_C": r.get("Temp_Zone1_C"),
                        "Temp_Zone2_C": r.get("Temp_Zone2_C"),
                        "Temp_Zone3_C": r.get("Temp_Zone3_C"),
                        "Temp_Zone4_C": r.get("Temp_Zone4_C"),
                    }
                )

            out.reverse()
            return {"rows": out}
        finally:
            try:
                conn.close()
            except Exception:
                pass

    try:
        import asyncio
        result = await asyncio.to_thread(_fetch_sync)
        _extruder_last_success_at = datetime.utcnow()
        _extruder_last_error = None
        _extruder_last_error_at = None
        return result
    except HTTPException:
        raise
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        msg = msg.replace(password or "", "***")
        if len(msg) > 500:
            msg = msg[:500] + "..."

        logger.exception("MSSQL extruder read failed")
        _extruder_last_error = msg
        _extruder_last_error_at = datetime.utcnow()
        raise HTTPException(status_code=502, detail="Failed to read MSSQL extruder data")


@router.get("/extruder/status")
async def get_extruder_status(
    current_user: User = Depends(require_viewer),
):
    host = (os.getenv("MSSQL_HOST") or "").strip()
    port_raw = (os.getenv("MSSQL_PORT") or "1433").strip()
    user = (os.getenv("MSSQL_USER") or "").strip()
    password = os.getenv("MSSQL_PASSWORD")
    database = (os.getenv("MSSQL_DATABASE") or "HISTORISCH").strip()
    table_raw = (os.getenv("MSSQL_TABLE") or "Tab_Actual").strip()
    schema_raw = (os.getenv("MSSQL_SCHEMA") or "dbo").strip()

    schema = schema_raw
    table = table_raw
    if "." in table_raw:
        parts = [p for p in table_raw.split(".") if p]
        if len(parts) == 2:
            schema, table = parts[0], parts[1]

    configured = bool(host and user and password)
    try:
        port = int(port_raw)
    except Exception:
        port = None

    return {
        "configured": configured,
        "host": host or None,
        "port": port,
        "database": database or None,
        "schema": schema or None,
        "table": table or None,
        "last_attempt_at": _extruder_last_attempt_at.isoformat() if _extruder_last_attempt_at else None,
        "last_success_at": _extruder_last_success_at.isoformat() if _extruder_last_success_at else None,
        "last_error_at": _extruder_last_error_at.isoformat() if _extruder_last_error_at else None,
        "last_error": _extruder_last_error,
    }


@router.get("/extruder/derived")
async def get_extruder_derived_kpis(
    current_user: User = Depends(require_viewer),
    window_minutes: int = Query(30, ge=5, le=1440, description="Time window in minutes to analyze"),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """
    Step 1–4: Read recent data, compute baseline, derived metrics, and risk indicators.
    
    IMPORTANT: Process evaluation (traffic-light, baseline, risk scores) only runs in PRODUCTION state.
    When machine is OFF/HEATING/IDLE/COOLING, returns empty/neutral values.
    
    Returns:
      - window_minutes: requested window
      - rows: raw rows in the window
      - baseline: per-sensor rolling baseline (mean) and normal range (mean ± 1 std) - only in PRODUCTION
      - derived: Temp_Avg, Temp_Spread, stability flags - only in PRODUCTION
      - risk: per-sensor risk level (green/yellow/red) and overall risk - only in PRODUCTION
    """
    import pymssql
    from datetime import datetime, timedelta

    global _extruder_last_attempt_at, _extruder_last_success_at, _extruder_last_error_at, _extruder_last_error
    _extruder_last_attempt_at = datetime.utcnow()

    # Load config from environment
    host = os.getenv("MSSQL_HOST")
    port_raw = os.getenv("MSSQL_PORT", "1433")
    user = os.getenv("MSSQL_USER")
    password = os.getenv("MSSQL_PASSWORD")
    database = (os.getenv("MSSQL_DATABASE") or "HISTORISCH").strip()
    table_raw = (os.getenv("MSSQL_TABLE") or "Tab_Actual").strip()
    schema_raw = (os.getenv("MSSQL_SCHEMA") or "dbo").strip()

    schema = schema_raw
    table = table_raw
    if "." in table_raw:
        parts = [p for p in table_raw.split(".") if p]
        if len(parts) == 2:
            schema, table = parts[0], parts[1]

    # Validate config
    try:
        port = int(port_raw)
    except Exception:
        _extruder_last_error_at = datetime.utcnow()
        _extruder_last_error = "Invalid MSSQL_PORT"
        raise HTTPException(status_code=500, detail="Invalid MSSQL_PORT")

    if not (host and user and password):
        _extruder_last_error_at = datetime.utcnow()
        _extruder_last_error = "Missing MSSQL connection config"
        raise HTTPException(status_code=500, detail="Missing MSSQL connection config")

    # Step 1: Read latest data within time window
    cutoff = datetime.utcnow() - timedelta(minutes=window_minutes)
    conn = None
    try:
        conn = pymssql.connect(
            server=host,
            port=port,
            user=user,
            password=password,
            database=database,
            as_dict=True,
            login_timeout=10,
        )
        cursor = conn.cursor()
        # Use SQL 2000 compatible syntax
        sql = f"""
        SELECT TOP 200
            TrendDate,
            Val_4 AS ScrewSpeed_rpm,
            Val_6 AS Pressure_bar,
            Val_7 AS Temp_Zone1_C,
            Val_8 AS Temp_Zone2_C,
            Val_9 AS Temp_Zone3_C,
            Val_10 AS Temp_Zone4_C
        FROM [{schema}].[{table}]
        WHERE TrendDate >= DATEADD(minute, -{window_minutes}, GETDATE())
        ORDER BY TrendDate DESC
        """
        cursor.execute(sql)
        rows_raw = cursor.fetchall()
        # Ensure TrendDate is datetime
        rows = []
        for r in rows_raw:
            td = r.get("TrendDate")
            if isinstance(td, datetime):
                rows.append(r)
        # Reverse to chronological order (oldest first)
        rows = list(reversed(rows))
        _extruder_last_success_at = datetime.utcnow()
        _extruder_last_error = None
        _extruder_last_error_at = None
    except pymssql.exceptions.OperationalError as e:
        _extruder_last_error_at = datetime.utcnow()
        _extruder_last_error = f"MSSQL connection failed: {str(e)[:200]}"
        logger.error(f"MSSQL connection error in /extruder/derived: {e}")
        # Return empty data instead of raising exception when MSSQL is unavailable
        rows = []
    except Exception as e:
        _extruder_last_error_at = datetime.utcnow()
        _extruder_last_error = str(e)
        logger.error(f"MSSQL extruder/derived error: {e}")
        # Return empty data instead of raising exception
        rows = []
    finally:
        try:
            if conn:
                conn.close()
        except Exception:
            pass

    # Check machine state - only calculate baselines/risk in PRODUCTION
    from app.services.machine_state_manager import MachineStateService
    state_service = MachineStateService(session)
    
    # Get the extruder machine (assuming single machine for now)
    machines = await session.scalars(select(Machine).where(Machine.name == "Extruder-SQL").limit(1))
    machine = machines.first()
    
    is_in_production = False
    current_state = None
    machine_state_str = "UNKNOWN"
    if machine:
        current_state = await state_service.get_current_state(str(machine.id))
        if current_state:
            machine_state_str = current_state.state.value
            is_in_production = (machine_state_str == "PRODUCTION")
    
    if not rows:
        return {
            "window_minutes": window_minutes,
            "rows": [],
            "baseline": {},
            "derived": {},
            "risk": {"overall": "unknown", "sensors": {}},
            "risk_score": None,  # N/A when no data
            "machine_state": machine_state_str,
            "evaluation_enabled": is_in_production,
        }
    
    # Helper to extract numeric values safely
    def as_float(val):
        try:
            return float(val) if val is not None else None
        except Exception:
            return None

    # Step 2: Baseline calculation per sensor, operating-point aware
    sensor_keys = ["ScrewSpeed_rpm", "Pressure_bar", "Temp_Zone1_C", "Temp_Zone2_C", "Temp_Zone3_C", "Temp_Zone4_C"]
    
    # Calculate Temp_Avg and Temp_Spread for ALL states (even when not in PRODUCTION)
    temp_keys = ["Temp_Zone1_C", "Temp_Zone2_C", "Temp_Zone3_C", "Temp_Zone4_C"]
    for r in rows:
        temps = [as_float(r.get(k)) for k in temp_keys if as_float(r.get(k)) is not None]
        if temps and len(temps) >= 2:
            r["Temp_Avg"] = round(statistics.mean(temps), 1)
            r["Temp_Spread"] = round(max(temps) - min(temps), 1)
        else:
            r["Temp_Avg"] = None
            r["Temp_Spread"] = None
    
    # Get current Temp_Avg and Temp_Spread from latest row
    current_temp_avg = None
    current_temp_spread = None
    if rows:
        latest_row = rows[-1]
        current_temp_avg = latest_row.get("Temp_Avg")
        current_temp_spread = latest_row.get("Temp_Spread")
    
    # If not in PRODUCTION, return raw data but skip baseline/risk calculations
    if not is_in_production:
        # Text Engine: Neutral status text for non-PRODUCTION states
        neutral_explanations = {}
        state_display_names = {
            "OFF": "Machine is off",
            "HEATING": "Machine is heating up",
            "IDLE": "Machine is idle (warm and ready)",
            "COOLING": "Machine is cooling down",
        }
        state_message = state_display_names.get(machine_state_str, f"Machine is in {machine_state_str} state")
        
        # Generate neutral explanations for each sensor
        for key in sensor_keys:
            neutral_explanations[key] = f"{key}: {state_message}. No process evaluation in this state."
        
        # Add explanations for derived metrics
        neutral_explanations["Temp_Avg"] = f"Temp_Avg: {state_message}. No process evaluation in this state."
        neutral_explanations["Temp_Spread"] = f"Temp_Spread: {state_message}. No process evaluation in this state."
        
        # Overall neutral text
        overall_text = f"{state_message}. Process evaluation is disabled. Evaluation only runs during PRODUCTION."
        
        return {
            "window_minutes": window_minutes,
            "rows": rows,
            "baseline": {},  # Empty - no baseline calculation when not in PRODUCTION
            "derived": {
                "Temp_Avg": {"current": current_temp_avg},  # Show calculated value
                "Temp_Spread": {"current": current_temp_spread},  # Show calculated value
                "explanations": neutral_explanations,  # Neutral status text
            },
            "risk": {"overall": "unknown", "sensors": {}},  # No risk scores when not in PRODUCTION
            "risk_score": None,  # N/A when not in PRODUCTION
            "overall_text": overall_text,  # Overall neutral text
            "machine_state": machine_state_str,
            "evaluation_enabled": False,
            "message": f"Process evaluation disabled - machine is in {machine_state_str} state. Evaluation only runs in PRODUCTION.",
        }

    # Step 2: Baseline calculation per sensor, operating-point aware
    baseline = {}
    # Determine operating point by ScrewSpeed_rpm buckets (simple 2-rpm bins)
    screw_speeds = [as_float(r.get("ScrewSpeed_rpm")) for r in rows if as_float(r.get("ScrewSpeed_rpm")) is not None]
    if screw_speeds:
        current_speed = screw_speeds[-1]
        # Create bucket: round to nearest 2 rpm
        speed_bucket = round(current_speed / 2) * 2
        # Filter rows within this operating point (±2 rpm)
        op_rows = [r for r in rows if as_float(r.get("ScrewSpeed_rpm")) is not None and abs(as_float(r.get("ScrewSpeed_rpm")) - speed_bucket) <= 2]
    else:
        op_rows = rows

    for key in sensor_keys:
        values = [as_float(r.get(key)) for r in op_rows if as_float(r.get(key)) is not None]
        if values:
            mean_val = statistics.mean(values)
            std_val = statistics.stdev(values) if len(values) > 1 else 0.0
            baseline[key] = {
                "mean": round(mean_val, 3),
                "std": round(std_val, 3),
                "min_normal": round(mean_val - std_val, 3),
                "max_normal": round(mean_val + std_val, 3),
                "count": len(values),
                "op_bucket": speed_bucket if key == "ScrewSpeed_rpm" else None,
            }
        else:
            baseline[key] = {"mean": None, "std": None, "min_normal": None, "max_normal": None, "count": 0, "op_bucket": None}

    # Step 3: Derived metrics
    derived = {}
    # Temperature averages per row
    temp_keys = ["Temp_Zone1_C", "Temp_Zone2_C", "Temp_Zone3_C", "Temp_Zone4_C"]
    for r in rows:
        temps = [as_float(r.get(k)) for k in temp_keys if as_float(r.get(k)) is not None]
        if temps:
            r["Temp_Avg"] = round(statistics.mean(temps), 3)
            r["Temp_Spread"] = round(max(temps) - min(temps), 3)
        else:
            r["Temp_Avg"] = None
            r["Temp_Spread"] = None
    # Overall derived aggregates
    all_temp_avg = [r["Temp_Avg"] for r in rows if r.get("Temp_Avg") is not None]
    all_temp_spread = [r["Temp_Spread"] for r in rows if r.get("Temp_Spread") is not None]
    derived["Temp_Avg"] = {
        "current": rows[-1].get("Temp_Avg") if rows else None,
        "mean": round(statistics.mean(all_temp_avg), 3) if all_temp_avg else None,
        "std": round(statistics.stdev(all_temp_avg), 3) if len(all_temp_avg) > 1 else None,
    }
    derived["Temp_Spread"] = {
        "current": rows[-1].get("Temp_Spread") if rows else None,
        "mean": round(statistics.mean(all_temp_spread), 3) if all_temp_spread else None,
        "std": round(statistics.stdev(all_temp_spread), 3) if len(all_temp_spread) > 1 else None,
    }
    # Stability indicators: % of points within normal range
    stability = {}
    for key in sensor_keys:
        vals = [as_float(r.get(key)) for r in rows if as_float(r.get(key)) is not None]
        base = baseline.get(key, {})
        min_n = base.get("min_normal")
        max_n = base.get("max_normal")
        if min_n is not None and max_n is not None and vals:
            stable_count = sum(1 for v in vals if min_n <= v <= max_n)
            stability[key] = round(100 * stable_count / len(vals), 1)
        else:
            stability[key] = None
    derived["stability_percent"] = stability

    # Per-sensor time spread (stability) within window
    per_sensor_spread = {}
    for key in sensor_keys:
        vals = [as_float(r.get(key)) for r in rows if as_float(r.get(key)) is not None]
        if len(vals) >= 2:
            spread = max(vals) - min(vals)
            per_sensor_spread[key] = round(spread, 3)
        else:
            per_sensor_spread[key] = None
    derived["per_sensor_spread"] = per_sensor_spread

    # Step 3.5: Load Profile Data BEFORE Stability Evaluation (needed for baseline_std)
    # Get active profile for scoring bands and baselines
    from app.services.baseline_learning_service import baseline_learning_service
    from app.models.profile import ProfileScoringBand, ProfileBaselineStats
    # Note: select and and_ are already imported at the top of the file
    
    # Get machine and material for profile lookup
    active_profile = None
    scoring_bands = {}
    profile_baselines = {}
    
    try:
        # machine was already fetched earlier in the function
        if machine:
            material_id = (machine.metadata_json or {}).get("current_material", "Material 1")
            active_profile = await baseline_learning_service.get_active_profile(
                session, machine.id, material_id
            )
            
            if active_profile and active_profile.baseline_ready:
                # Load scoring bands for this profile
                bands_result = await session.execute(
                    select(ProfileScoringBand)
                    .where(ProfileScoringBand.profile_id == active_profile.id)
                )
                bands = bands_result.scalars().all()
                for band in bands:
                    scoring_bands[band.metric_name] = {
                        "mode": band.mode,  # "ABS" or "REL"
                        "green_limit": band.green_limit,
                        "orange_limit": band.orange_limit,
                    }
                
                # Load baseline stats from finalized baseline
                baseline_stats_result = await session.execute(
                    select(ProfileBaselineStats)
                    .where(ProfileBaselineStats.profile_id == active_profile.id)
                )
                baseline_stats = baseline_stats_result.scalars().all()
                for bs in baseline_stats:
                    profile_baselines[bs.metric_name] = {
                        "mean": bs.baseline_mean,
                        "std": bs.baseline_std,
                    }
    except Exception as e:
        logger.error(f"Error loading profile in /extruder/derived: {e}")
        # Continue without profile - will use fallback baselines
        active_profile = None

    # Step 3.6: Stability Evaluation (std dev vs baseline std dev)
    # Stability = current_std / baseline_std
    # GREEN: ratio ≤ 1.2, ORANGE: ratio ≤ 1.8, RED: ratio > 1.8
    stability_evaluation = {}
    stability_severity = {}
    
    # Metrics to evaluate for stability (RPM, Pressure, optional Temperature)
    stability_metrics = {
        "ScrewSpeed_rpm": "RPM stability",
        "Pressure_bar": "Pressure stability",
        "Temp_Avg": "Temperature stability",  # Optional
    }
    
    for metric_key, metric_label in stability_metrics.items():
        # Get current window std dev
        if metric_key == "Temp_Avg":
            # Use Temp_Avg values from rows
            current_vals = [r.get("Temp_Avg") for r in rows if r.get("Temp_Avg") is not None]
        else:
            current_vals = [as_float(r.get(metric_key)) for r in rows if as_float(r.get(metric_key)) is not None]
        
        if len(current_vals) < 2:
            stability_evaluation[metric_key] = {
                "current_std": None,
                "baseline_std": None,
                "ratio": None,
                "severity": -1,
                "label": metric_label,
            }
            stability_severity[metric_key] = -1
            continue
        
        current_std = statistics.stdev(current_vals) if len(current_vals) > 1 else 0.0
        
        # Get baseline std dev (prefer profile baseline, fallback to rolling baseline)
        baseline_std = None
        if metric_key in profile_baselines:
            baseline_std = profile_baselines[metric_key].get("std")
        
        if baseline_std is None:
            # Fallback to rolling baseline
            base = baseline.get(metric_key, {})
            baseline_std = base.get("std")
        
        if baseline_std is None or baseline_std == 0:
            stability_evaluation[metric_key] = {
                "current_std": round(current_std, 3),
                "baseline_std": None,
                "ratio": None,
                "severity": -1,
                "label": metric_label,
            }
            stability_severity[metric_key] = -1
            continue
        
        # Calculate ratio: current_std / baseline_std
        ratio = current_std / baseline_std
        
        # Determine severity: 0 = GREEN, 1 = ORANGE, 2 = RED
        if ratio <= 1.2:
            severity = 0  # GREEN
        elif ratio <= 1.8:
            severity = 1  # ORANGE
        else:
            severity = 2  # RED
        
        stability_evaluation[metric_key] = {
            "current_std": round(current_std, 3),
            "baseline_std": round(baseline_std, 3),
            "ratio": round(ratio, 3),
            "severity": severity,
            "label": metric_label,
        }
        stability_severity[metric_key] = severity
    
    derived["stability_evaluation"] = stability_evaluation

    # Step 4: Scoring Engine (Only in PRODUCTION) - using ProfileScoringBand
    
    def calculate_severity(value: Optional[float], metric_name: str, baseline_mean: Optional[float]) -> int:
        """
        Calculate severity score using ProfileScoringBand.
        
        Returns:
            0 = GREEN
            1 = ORANGE
            2 = RED
            -1 = UNKNOWN (if no scoring band or baseline)
        """
        if value is None or baseline_mean is None:
            return -1  # UNKNOWN
        
        # Get scoring band for this metric
        band = scoring_bands.get(metric_name)
        if not band:
            # No scoring band configured - fallback to Z-score (backward compatibility)
            # Use rolling baseline from current window
            base = baseline.get(metric_name, {})
            mean = base.get("mean")
            std = base.get("std", 0)
            if mean is None:
                return -1
            if std == 0:
                return 0  # GREEN
            z = abs(value - mean) / std
            if z <= 1:
                return 0  # GREEN
            elif z <= 2:
                return 1  # ORANGE
            else:
                return 2  # RED
        
        # Use profile baseline mean if available, otherwise fallback to rolling baseline
        mean = profile_baselines.get(metric_name, {}).get("mean") or baseline.get(metric_name, {}).get("mean")
        if mean is None:
            return -1
        
        mode = band["mode"]
        green_limit = band["green_limit"]
        orange_limit = band["orange_limit"]
        
        if mode == "ABS":
            # ABS mode: compare absolute difference
            abs_diff = abs(value - mean)
            if green_limit is not None and abs_diff <= green_limit:
                return 0  # GREEN
            elif orange_limit is not None and abs_diff <= orange_limit:
                return 1  # ORANGE
            else:
                return 2  # RED
        elif mode == "REL":
            # REL mode: compare % deviation from baseline
            if mean == 0:
                return -1  # Cannot calculate percentage deviation
            pct_deviation = abs((value - mean) / mean) * 100.0  # Percentage
            
            # Convert limits from percentage to absolute if needed
            # For REL mode, limits are typically in percentage (e.g., 5.0 = 5%)
            if green_limit is not None and pct_deviation <= green_limit:
                return 0  # GREEN
            elif orange_limit is not None and pct_deviation <= orange_limit:
                return 1  # ORANGE
            else:
                return 2  # RED
        else:
            # Unknown mode - fallback
            return -1
    
    # Calculate severity for each sensor
    risk_sensors = {}
    severity_sensors = {}  # Numeric severity (0, 1, 2)
    current_row = rows[-1] if rows else {}
    for key in sensor_keys:
        val = as_float(current_row.get(key))
        base = baseline.get(key, {})
        mean = base.get("mean")
        
        # Use profile baseline if available
        if key in profile_baselines:
            mean = profile_baselines[key]["mean"]
        
        severity = calculate_severity(val, key, mean)
        severity_sensors[key] = severity
        
        # Convert to string for backward compatibility
        if severity == 0:
            risk_sensors[key] = "green"
        elif severity == 1:
            risk_sensors[key] = "orange"
        elif severity == 2:
            risk_sensors[key] = "red"
        else:
            risk_sensors[key] = "unknown"
    
    # Calculate severity for derived metrics (Temp_Avg, Temp_Spread) for weighted risk score
    # Temp_Avg severity
    temp_avg_val = current_row.get("Temp_Avg")
    if temp_avg_val is not None:
        temp_avg_base = derived.get("Temp_Avg", {})
        temp_avg_mean = temp_avg_base.get("mean")
        if temp_avg_mean is None and "Temp_Avg" in profile_baselines:
            temp_avg_mean = profile_baselines["Temp_Avg"]["mean"]
        temp_avg_severity = calculate_severity(temp_avg_val, "Temp_Avg", temp_avg_mean)
        severity_sensors["Temp_Avg"] = temp_avg_severity
    
    # Temp_Spread severity
    temp_spread_val = current_row.get("Temp_Spread")
    if temp_spread_val is not None:
        temp_spread_base = derived.get("Temp_Spread", {})
        temp_spread_mean = temp_spread_base.get("mean")
        if temp_spread_mean is None:
            # Calculate from temp zones if not available
            temp_keys = ["Temp_Zone1_C", "Temp_Zone2_C", "Temp_Zone3_C", "Temp_Zone4_C"]
            all_spreads = []
            for r in rows:
                temps = [as_float(r.get(k)) for k in temp_keys if as_float(r.get(k)) is not None]
                if len(temps) >= 2:
                    all_spreads.append(max(temps) - min(temps))
            if all_spreads:
                temp_spread_mean = statistics.mean(all_spreads)
        temp_spread_severity = calculate_severity(temp_spread_val, "Temp_Spread", temp_spread_mean)
        severity_sensors["Temp_Spread"] = temp_spread_severity
    
    # Overall Risk Calculation: Weighted Risk Score
    # risk_score = 25 * pressure_severity + 25 * temp_spread_severity + 25 * stability_severity + 25 * temp_avg_severity
    # Range: 0-100
    # 0-33 → GREEN, 34-66 → ORANGE, 67-100 → RED
    
    # Get individual severity scores for weighted risk calculation
    pressure_severity = severity_sensors.get("Pressure_bar", -1)
    temp_avg_severity = severity_sensors.get("Temp_Avg", -1)
    temp_spread_severity = severity_sensors.get("Temp_Spread", -1)
    
    # Get stability_severity (use Pressure stability as primary, or average if multiple)
    stability_severity_val = -1
    if "Pressure_bar" in stability_severity:
        stability_severity_val = stability_severity["Pressure_bar"]
    elif stability_severity:
        # Average of all stability severities
        valid_stability = [v for v in stability_severity.values() if v >= 0]
        if valid_stability:
            stability_severity_val = round(sum(valid_stability) / len(valid_stability))
    
    # Calculate weighted risk score (0-100)
    # Only calculate if all components are available (severity >= 0)
    risk_score = None
    if all(s >= 0 for s in [pressure_severity, temp_spread_severity, stability_severity_val, temp_avg_severity]):
        risk_score = (
            25 * pressure_severity +
            25 * temp_spread_severity +
            25 * stability_severity_val +
            25 * temp_avg_severity
        )
        # Ensure range is 0-100
        risk_score = max(0, min(100, risk_score))
    
    # Determine overall risk color from risk_score
    if risk_score is not None:
        if risk_score <= 33:
            overall_risk = "green"
            overall_severity = 0
        elif risk_score <= 66:
            overall_risk = "orange"
            overall_severity = 1
        else:
            overall_risk = "red"
            overall_severity = 2
    else:
        # Fallback to worst sensor risk if weighted calculation not possible
        overall_severity = max(severity_sensors.values()) if severity_sensors else -1
        if overall_severity == 0:
            overall_risk = "green"
        elif overall_severity == 1:
            overall_risk = "orange"
        elif overall_severity == 2:
            overall_risk = "red"
        else:
            overall_risk = "unknown"

    # Explanations per sensor (using ProfileMessageTemplate if available)
    from app.models.profile import ProfileMessageTemplate
    # Note: Optional is already imported at the top of the file
    
    explanations = {}
    message_templates = {}
    if active_profile:
        templates_result = await session.execute(
            select(ProfileMessageTemplate)
            .where(ProfileMessageTemplate.profile_id == active_profile.id)
        )
        templates = templates_result.scalars().all()
        for template in templates:
            key = f"{template.metric_name}_{template.severity}"
            message_templates[key] = template.text
    
    for key in sensor_keys:
        val = as_float(current_row.get(key))
        base = baseline.get(key, {})
        mean = base.get("mean")
        std = base.get("std")
        severity = severity_sensors.get(key, -1)
        
        # Try to use profile message template
        severity_str = ["GREEN", "ORANGE", "RED"][severity] if 0 <= severity <= 2 else "UNKNOWN"
        template_key = f"{key}_{severity_str}"
        
        if template_key in message_templates:
            explanations[key] = message_templates[template_key]
        else:
            # Fallback to default messages
            if severity == 2:  # RED
                explanations[key] = f"{key} critically deviates from normal ({mean:.1f}±{std:.1f})"
            elif severity == 1:  # ORANGE
                explanations[key] = f"{key} drifting from normal ({mean:.1f}±{std:.1f})"
            elif severity == 0:  # GREEN
                explanations[key] = f"{key} stable"
            else:
                explanations[key] = f"{key} unknown"
    derived["explanations"] = explanations
    derived["severity"] = severity_sensors  # Include numeric severity scores
    
    # Text Engine: Overall text derived from highest severity metric
    # Find metric with highest severity
    highest_severity = -1
    highest_severity_metric = None
    highest_severity_text = None
    
    for metric, severity in severity_sensors.items():
        if severity > highest_severity:
            highest_severity = severity
            highest_severity_metric = metric
            highest_severity_text = explanations.get(metric, f"{metric} status unknown")
    
    # If no severity found, use overall risk
    if highest_severity < 0:
        if overall_severity == 0:
            overall_text = "All systems operating normally"
        elif overall_severity == 1:
            overall_text = "Some metrics require attention"
        elif overall_severity == 2:
            overall_text = "Critical issues detected - immediate action required"
        else:
            overall_text = "System status unknown"
    else:
        # Use text from highest severity metric
        overall_text = highest_severity_text
    
    # Add state context to overall text
    overall_text = f"[PRODUCTION] {overall_text}"

    # This return is only reached when is_in_production is True (early return above handles non-PRODUCTION)
    return {
        "window_minutes": window_minutes,
        "rows": rows,
        "baseline": baseline,
        "derived": derived,
        "risk": {"overall": overall_risk, "sensors": risk_sensors},
        "risk_score": risk_score,  # Weighted risk score (0-100) or None if not in PRODUCTION
        "severity": {"overall": overall_severity, "sensors": severity_sensors},  # Numeric severity (0, 1, 2)
        "stability_severity": stability_severity,  # Stability severity scores (0, 1, 2)
        "risk_components": {  # Individual components for debugging
            "pressure_severity": pressure_severity,
            "temp_spread_severity": temp_spread_severity,
            "stability_severity": stability_severity_val,
            "temp_avg_severity": temp_avg_severity,
        },
        "overall_text": overall_text,  # Overall text derived from highest severity metric
        "machine_state": machine_state_str,
        "evaluation_enabled": True,
        "profile_id": str(active_profile.id) if active_profile else None,
        "baseline_ready": active_profile.baseline_ready if active_profile else False,
    }


@router.get("/current")
async def get_current_dashboard_data(
    material_id: Optional[str] = Query(None, description="Material ID to use for profile lookup. If not provided, uses machine metadata."),
    current_user: User = Depends(require_viewer),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """
    Single Source of Truth API for Dashboard
    
    Returns all computed values so frontend doesn't need to recompute logic.
    Includes: machine state, metrics with baselines, severity, risk, explanations.
    
    If material_id is provided, it will be used to load the profile. Otherwise, uses machine metadata.
    """
    from app.services.machine_state_manager import MachineStateService
    from app.services.baseline_learning_service import baseline_learning_service
    from app.models.profile import ProfileBaselineStats, ProfileScoringBand
    
    # Get the extruder machine (assuming single machine for now)
    machines = await session.scalars(select(Machine).where(Machine.name == "Extruder-SQL").limit(1))
    machine = machines.first()
    
    if not machine:
        raise HTTPException(status_code=404, detail="Extruder machine not found")
    
    # Query MSSQL for latest data first (needed for state calculation)
    import pymssql
    from datetime import datetime, timedelta
    
    # Load MSSQL config
    host = os.getenv("MSSQL_HOST")
    port_raw = os.getenv("MSSQL_PORT", "1433")
    user = os.getenv("MSSQL_USER")
    password = os.getenv("MSSQL_PASSWORD")
    database = (os.getenv("MSSQL_DATABASE") or "HISTORISCH").strip()
    table_raw = (os.getenv("MSSQL_TABLE") or "Tab_Actual").strip()
    schema_raw = (os.getenv("MSSQL_SCHEMA") or "dbo").strip()
    
    schema = schema_raw
    table = table_raw
    if "." in table_raw:
        parts = [p for p in table_raw.split(".") if p]
        if len(parts) == 2:
            schema, table = parts[0], parts[1]
    
    try:
        port = int(port_raw)
    except ValueError:
        logger.error("Invalid MSSQL_PORT configuration")
        port = 1433
    
    # Query MSSQL for latest data to compute state
    conn = None
    current_row = {}
    latest_timestamp = None
    try:
        if host and user and password:
            conn = pymssql.connect(
                server=host,
                port=port,
                user=user,
                password=password,
                database=database,
                as_dict=True,
                login_timeout=5,
            )
            cursor = conn.cursor()
            sql = f"""
            SELECT TOP 1
                TrendDate,
                Val_4 AS ScrewSpeed_rpm,
                Val_6 AS Pressure_bar,
                Val_7 AS Temp_Zone1_C,
                Val_8 AS Temp_Zone2_C,
                Val_9 AS Temp_Zone3_C,
                Val_10 AS Temp_Zone4_C
            FROM [{schema}].[{table}]
            ORDER BY TrendDate DESC
            """
            cursor.execute(sql)
            rows_raw = cursor.fetchall()
            if rows_raw:
                current_row = rows_raw[0]
                latest_timestamp = current_row.get("TrendDate")
    except Exception as e:
        logger.warning(f"MSSQL connection error in /dashboard/current: {e}")
        # Continue without MSSQL data - will use get_current_state fallback
    finally:
        if conn:
            conn.close()
    
    # Get current machine state - compute from latest MSSQL data if available
    state_service = MachineStateService(session)
    current_state = None
    
    # If we have latest MSSQL data, process it through the state detector
    if current_row and latest_timestamp:
        try:
            from app.services.machine_state_service import SensorReading
            
            # Create SensorReading from latest MSSQL data
            sensor_reading = SensorReading(
                timestamp=latest_timestamp if isinstance(latest_timestamp, datetime) else datetime.utcnow(),
                screw_rpm=current_row.get("ScrewSpeed_rpm"),
                pressure_bar=current_row.get("Pressure_bar"),
                temp_zone_1=current_row.get("Temp_Zone1_C"),
                temp_zone_2=current_row.get("Temp_Zone2_C"),
                temp_zone_3=current_row.get("Temp_Zone3_C"),
                temp_zone_4=current_row.get("Temp_Zone4_C"),
            )
            
            # Process the reading to update state
            current_state = await state_service.process_sensor_reading(str(machine.id), sensor_reading)
        except Exception as e:
            logger.warning(f"Error processing sensor reading for state calculation: {e}")
            # Fallback to get_current_state
            current_state = await state_service.get_current_state(str(machine.id))
    else:
        # No MSSQL data available - use get_current_state (may return OFF if no readings)
        current_state = await state_service.get_current_state(str(machine.id))
    
    if not current_state:
        return {
            "machine_state": "UNKNOWN",
            "state_confidence": 0.0,
            "state_since_ts": None,
            "metrics": {},
            "overall_risk": "unknown",
            "overall_severity": -1,
            "explanation_text": "Machine state not available",
            "baseline_status": "not_available",
            "profile_status": "not_available",
        }
    
    machine_state_str = current_state.state.value
    state_confidence = current_state.confidence
    state_since_ts = current_state.state_since.isoformat() if current_state.state_since else None
    is_in_production = (machine_state_str == "PRODUCTION")
    
    # Get active profile - use material_id from query param or fallback to machine metadata
    if not material_id:
        material_id = (machine.metadata_json or {}).get("current_material", "Material 1")
    active_profile = await baseline_learning_service.get_active_profile(
        session, machine.id, material_id
    )
    
    # Baseline and profile status
    baseline_status = "not_ready"
    profile_status = "not_available"
    if active_profile:
        profile_status = "active"
        if active_profile.baseline_ready:
            baseline_status = "ready"
        elif active_profile.baseline_learning:
            baseline_status = "learning"
        else:
            baseline_status = "not_ready"
    
    # current_row and latest_timestamp are already available from the MSSQL query above
    
    # Helper function
    def as_float(val):
        try:
            return float(val) if val is not None else None
        except Exception:
            return None
    
    # Calculate Temp_Avg and Temp_Spread from current row (even when not in PRODUCTION)
    metrics_response = {}
    if current_row:
        temps = [
            as_float(current_row.get("Temp_Zone1_C")),
            as_float(current_row.get("Temp_Zone2_C")),
            as_float(current_row.get("Temp_Zone3_C")),
            as_float(current_row.get("Temp_Zone4_C")),
        ]
        valid_temps = [t for t in temps if t is not None]
        
        if len(valid_temps) >= 2:
            temp_avg = round(statistics.mean(valid_temps), 1)
            temp_spread = round(max(valid_temps) - min(valid_temps), 1)
            
            # Add basic sensor metrics
            metrics_response["ScrewSpeed_rpm"] = {
                "current_value": as_float(current_row.get("ScrewSpeed_rpm")),
                "baseline_mean": None,
                "green_band": None,
                "deviation": None,
                "severity": -1,
            }
            metrics_response["Pressure_bar"] = {
                "current_value": as_float(current_row.get("Pressure_bar")),
                "baseline_mean": None,
                "green_band": None,
                "deviation": None,
                "severity": -1,
            }
            metrics_response["Temp_Zone1_C"] = {
                "current_value": as_float(current_row.get("Temp_Zone1_C")),
                "baseline_mean": None,
                "green_band": None,
                "deviation": None,
                "severity": -1,
            }
            metrics_response["Temp_Zone2_C"] = {
                "current_value": as_float(current_row.get("Temp_Zone2_C")),
                "baseline_mean": None,
                "green_band": None,
                "deviation": None,
                "severity": -1,
            }
            metrics_response["Temp_Zone3_C"] = {
                "current_value": as_float(current_row.get("Temp_Zone3_C")),
                "baseline_mean": None,
                "green_band": None,
                "deviation": None,
                "severity": -1,
            }
            metrics_response["Temp_Zone4_C"] = {
                "current_value": as_float(current_row.get("Temp_Zone4_C")),
                "baseline_mean": None,
                "green_band": None,
                "deviation": None,
                "severity": -1,
            }
            metrics_response["Temp_Avg"] = {
                "current_value": temp_avg,
                "baseline_mean": None,
                "green_band": None,
                "deviation": None,
                "severity": -1,
            }
            metrics_response["Temp_Spread"] = {
                "current_value": temp_spread,
                "baseline_mean": None,
                "green_band": None,
                "deviation": None,
                "severity": -1,
            }
    
    # If not in PRODUCTION, return data with neutral text
    if not is_in_production:
        state_display_names = {
            "OFF": "Machine is off",
            "HEATING": "Machine is heating up",
            "IDLE": "Machine is idle (warm and ready)",
            "COOLING": "Machine is cooling down",
        }
        state_message = state_display_names.get(machine_state_str, f"Machine is in {machine_state_str} state")
        explanation_text = f"{state_message}. Process evaluation is disabled. Evaluation only runs during PRODUCTION."
        
        return {
            "machine_state": machine_state_str,
            "state_confidence": state_confidence,
            "state_since_ts": state_since_ts,
            "metrics": metrics_response,  # Include metrics even when not in PRODUCTION
            "overall_risk": "unknown",
            "overall_severity": -1,
            "explanation_text": explanation_text,
            "baseline_status": baseline_status,
            "profile_status": profile_status,
        }
    
    # PRODUCTION state: Get full evaluation data from /extruder/derived
    # We'll call the logic from get_extruder_derived_kpis but format it for /current
    import pymssql
    from datetime import datetime, timedelta
    
    # Load MSSQL config
    host = os.getenv("MSSQL_HOST")
    port_raw = os.getenv("MSSQL_PORT", "1433")
    user = os.getenv("MSSQL_USER")
    password = os.getenv("MSSQL_PASSWORD")
    database = (os.getenv("MSSQL_DATABASE") or "HISTORISCH").strip()
    table_raw = (os.getenv("MSSQL_TABLE") or "Tab_Actual").strip()
    schema_raw = (os.getenv("MSSQL_SCHEMA") or "dbo").strip()
    
    schema = schema_raw
    table = table_raw
    if "." in table_raw:
        parts = [p for p in table_raw.split(".") if p]
        if len(parts) == 2:
            schema, table = parts[0], parts[1]
    
    try:
        port = int(port_raw)
    except ValueError:
        logger.error("Invalid MSSQL_PORT configuration")
        raise HTTPException(status_code=500, detail="Invalid MSSQL_PORT")
    
    if not all([host, user, password]):
        logger.error("MSSQL configuration incomplete")
        raise HTTPException(status_code=500, detail="MSSQL configuration incomplete")
    
    # Query MSSQL for recent data (last 30 minutes)
    window_minutes = 30
    conn = None
    rows = []
    try:
        conn = pymssql.connect(
            server=host,
            port=port,
            user=user,
            password=password,
            database=database,
            as_dict=True,
            login_timeout=5,  # Reduced timeout to fail faster
        )
        cursor = conn.cursor()
        
        since = datetime.utcnow() - timedelta(minutes=window_minutes)
        # Use same query format as get_extruder_derived_kpis
        sql = f"""
        SELECT TOP 200
            TrendDate,
            Val_4 AS ScrewSpeed_rpm,
            Val_6 AS Pressure_bar,
            Val_7 AS Temp_Zone1_C,
            Val_8 AS Temp_Zone2_C,
            Val_9 AS Temp_Zone3_C,
            Val_10 AS Temp_Zone4_C
        FROM [{schema}].[{table}]
        WHERE TrendDate >= DATEADD(minute, -{window_minutes}, GETDATE())
        ORDER BY TrendDate DESC
        """
        cursor.execute(sql)
        rows_raw = cursor.fetchall()
        # Ensure TrendDate is datetime and convert to dict format
        for r in rows_raw:
            td = r.get("TrendDate")
            if isinstance(td, datetime):
                rows.append(r)
        # Reverse to chronological order (oldest first)
        rows = list(reversed(rows))
        
    except pymssql.exceptions.OperationalError as e:
        logger.error(f"MSSQL connection error in /current: {e}")
        # Return empty data instead of raising exception when MSSQL is unavailable
        rows = []
    except Exception as e:
        logger.error(f"MSSQL error in /current: {e}")
        # Return empty data instead of raising exception
        rows = []
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass
    
    if not rows:
        return {
            "machine_state": machine_state_str,
            "state_confidence": state_confidence,
            "state_since_ts": state_since_ts,
            "metrics": {},
            "overall_risk": "unknown",
            "overall_severity": -1,
            "explanation_text": "No sensor data available",
            "baseline_status": baseline_status,
            "profile_status": profile_status,
        }
    
    # Helper function
    def as_float(val):
        try:
            return float(val) if val is not None else None
        except Exception:
            return None
    
    # Calculate baseline and metrics (reuse logic from get_extruder_derived_kpis)
    sensor_keys = ["ScrewSpeed_rpm", "Pressure_bar", "Temp_Zone1_C", "Temp_Zone2_C", "Temp_Zone3_C", "Temp_Zone4_C"]
    baseline = {}
    current_row = rows[-1] if rows else {}
    
    # Operating-point aware baseline
    screw_speeds = [as_float(r.get("ScrewSpeed_rpm")) for r in rows if as_float(r.get("ScrewSpeed_rpm")) is not None]
    if screw_speeds:
        current_speed = screw_speeds[-1]
        speed_bucket = round(current_speed / 2) * 2
        op_rows = [r for r in rows if as_float(r.get("ScrewSpeed_rpm")) is not None and abs(as_float(r.get("ScrewSpeed_rpm")) - speed_bucket) <= 2]
    else:
        op_rows = rows
    
    for key in sensor_keys:
        values = [as_float(r.get(key)) for r in op_rows if as_float(r.get(key)) is not None]
        if values:
            mean_val = statistics.mean(values)
            std_val = statistics.stdev(values) if len(values) > 1 else 0.0
            baseline[key] = {
                "mean": mean_val,
                "std": std_val,
                "min_normal": mean_val - std_val,
                "max_normal": mean_val + std_val,
            }
    
    # Load profile baselines and scoring bands
    profile_baselines = {}
    scoring_bands = {}
    if active_profile and active_profile.baseline_ready:
        baseline_stats_result = await session.execute(
            select(ProfileBaselineStats)
            .where(ProfileBaselineStats.profile_id == active_profile.id)
        )
        for bs in baseline_stats_result.scalars().all():
            profile_baselines[bs.metric_name] = {
                "mean": bs.baseline_mean,
                "std": bs.baseline_std,
            }
        
        bands_result = await session.execute(
            select(ProfileScoringBand)
            .where(ProfileScoringBand.profile_id == active_profile.id)
        )
        for band in bands_result.scalars().all():
            scoring_bands[band.metric_name] = {
                "mode": band.mode,
                "green_limit": band.green_limit,
                "orange_limit": band.orange_limit,
            }
    
    # Calculate severity function (reuse from get_extruder_derived_kpis)
    def calculate_severity(value: Optional[float], metric_name: str, baseline_mean: Optional[float]) -> int:
        if value is None or baseline_mean is None:
            return -1
        
        band = scoring_bands.get(metric_name)
        if not band:
            # Fallback to Z-score
            base = baseline.get(metric_name, {})
            mean = base.get("mean")
            std = base.get("std", 0)
            if mean is None or std == 0:
                return -1
            z = abs(value - mean) / std
            if z <= 1:
                return 0
            elif z <= 2:
                return 1
            else:
                return 2
        
        mean = profile_baselines.get(metric_name, {}).get("mean") or baseline.get(metric_name, {}).get("mean")
        if mean is None:
            return -1
        
        mode = band["mode"]
        green_limit = band["green_limit"]
        orange_limit = band["orange_limit"]
        
        if mode == "ABS":
            abs_diff = abs(value - mean)
            if green_limit is not None and abs_diff <= green_limit:
                return 0
            elif orange_limit is not None and abs_diff <= orange_limit:
                return 1
            else:
                return 2
        elif mode == "REL":
            if mean == 0:
                return -1
            pct_deviation = abs((value - mean) / mean) * 100.0
            if green_limit is not None and pct_deviation <= green_limit:
                return 0
            elif orange_limit is not None and pct_deviation <= orange_limit:
                return 1
            else:
                return 2
        return -1
    
    # Calculate derived metrics (Temp_Avg, Temp_Spread) for each row
    for r in rows:
        temps = [
            as_float(r.get("Temp_Zone1_C")),
            as_float(r.get("Temp_Zone2_C")),
            as_float(r.get("Temp_Zone3_C")),
            as_float(r.get("Temp_Zone4_C")),
        ]
        valid_temps = [t for t in temps if t is not None]
        if len(valid_temps) >= 2:
            r["Temp_Avg"] = round(statistics.mean(valid_temps), 3)
            r["Temp_Spread"] = round(max(valid_temps) - min(valid_temps), 3)
        else:
            r["Temp_Avg"] = None
            r["Temp_Spread"] = None
    
    # Calculate baselines for derived metrics
    all_temp_avg = [r.get("Temp_Avg") for r in rows if r.get("Temp_Avg") is not None]
    all_temp_spread = [r.get("Temp_Spread") for r in rows if r.get("Temp_Spread") is not None]
    
    if all_temp_avg:
        baseline["Temp_Avg"] = {
            "mean": statistics.mean(all_temp_avg),
            "std": statistics.stdev(all_temp_avg) if len(all_temp_avg) > 1 else 0.0,
            "min_normal": statistics.mean(all_temp_avg) - (statistics.stdev(all_temp_avg) if len(all_temp_avg) > 1 else 0.0),
            "max_normal": statistics.mean(all_temp_avg) + (statistics.stdev(all_temp_avg) if len(all_temp_avg) > 1 else 0.0),
        }
    
    if all_temp_spread:
        baseline["Temp_Spread"] = {
            "mean": statistics.mean(all_temp_spread),
            "std": statistics.stdev(all_temp_spread) if len(all_temp_spread) > 1 else 0.0,
            "min_normal": statistics.mean(all_temp_spread) - (statistics.stdev(all_temp_spread) if len(all_temp_spread) > 1 else 0.0),
            "max_normal": statistics.mean(all_temp_spread) + (statistics.stdev(all_temp_spread) if len(all_temp_spread) > 1 else 0.0),
        }
    
    # Build metrics response
    metrics_response = {}
    # Add all sensor keys plus derived metrics
    all_metric_keys = sensor_keys + ["Temp_Avg", "Temp_Spread"]
    
    for key in all_metric_keys:
        current_value = as_float(current_row.get(key))
        base = baseline.get(key, {})
        baseline_mean = base.get("mean")
        
        # Use profile baseline if available
        if key in profile_baselines:
            baseline_mean = profile_baselines[key]["mean"]
        
        # Calculate deviation
        deviation = None
        if current_value is not None and baseline_mean is not None:
            deviation = current_value - baseline_mean
        
        # Calculate severity
        severity = calculate_severity(current_value, key, baseline_mean)
        
        # Green band (from baseline or scoring band)
        green_band = None
        if key in profile_baselines:
            std = profile_baselines[key].get("std", 0)
            if std > 0:
                green_band = {
                    "min": baseline_mean - std,
                    "max": baseline_mean + std,
                }
        elif base.get("std", 0) > 0:
            green_band = {
                "min": base.get("min_normal"),
                "max": base.get("max_normal"),
            }
        
        metrics_response[key] = {
            "current_value": current_value,
            "baseline_mean": baseline_mean,
            "green_band": green_band,
            "deviation": deviation,
            "severity": severity,
        }
    
    # Calculate overall risk and severity (reuse logic)
    # Include all metrics (sensors + derived) in severity calculation
    all_metric_keys_for_severity = sensor_keys + ["Temp_Avg", "Temp_Spread"]
    severity_sensors = {key: metrics_response[key]["severity"] for key in all_metric_keys_for_severity if key in metrics_response and metrics_response[key]["severity"] >= 0}
    overall_severity = max(severity_sensors.values()) if severity_sensors else -1
    
    if overall_severity == 0:
        overall_risk = "green"
    elif overall_severity == 1:
        overall_risk = "orange"
    elif overall_severity == 2:
        overall_risk = "red"
    else:
        overall_risk = "unknown"
    
    # Get explanation text (from highest severity metric)
    highest_severity = -1
    explanation_text = "System status unknown"
    for metric, severity in severity_sensors.items():
        if severity > highest_severity:
            highest_severity = severity
            metric_data = metrics_response[metric]
            if severity == 2:
                explanation_text = f"{metric} critically deviates from baseline"
            elif severity == 1:
                explanation_text = f"{metric} drifting from baseline"
            elif severity == 0:
                explanation_text = f"{metric} stable"
    
    return {
        "machine_state": machine_state_str,
        "state_confidence": state_confidence,
        "state_since_ts": state_since_ts,
        "metrics": metrics_response,
        "overall_risk": overall_risk,
        "overall_severity": overall_severity,
        "explanation_text": explanation_text,
        "baseline_status": baseline_status,
        "profile_status": profile_status,
    }


@router.get("/machines/stats")
async def get_machines_stats(
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(require_viewer),
):
    """Get machine statistics"""
    cache_key = "dashboard:machines:stats"
    cached = get_cached(cache_key)
    if cached:
        return cached
    
    # Count by status
    status_counts = {}
    for status in ["online", "offline", "maintenance", "degraded"]:
        count = await session.scalar(
            select(func.count(Machine.id)).where(Machine.status == status)
        )
        status_counts[status] = count or 0
    
    # Count by criticality
    criticality_counts = {}
    for crit in ["low", "medium", "high", "critical"]:
        count = await session.scalar(
            select(func.count(Machine.id)).where(Machine.criticality == crit)
        )
        criticality_counts[crit] = count or 0
    
    result = {
        "by_status": status_counts,
        "by_criticality": criticality_counts,
    }
    
    set_cached(cache_key, result)
    return result


@router.get("/sensors/stats")
async def get_sensors_stats(
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(require_viewer),
):
    """Get sensor statistics"""
    cache_key = "dashboard:sensors:stats"
    cached = get_cached(cache_key)
    if cached:
        return cached
    
    total = await session.scalar(select(func.count(Sensor.id)))
    
    # Count by type (if type is stored)
    # This is a simplified version - adjust based on your sensor type field
    
    result = {
        "total": total or 0,
    }
    
    set_cached(cache_key, result)
    return result


@router.get("/predictions/stats")
async def get_predictions_stats(
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(require_viewer),
    hours: int = Query(24, ge=1, le=168),
):
    """Get prediction statistics for the last N hours"""
    cache_key = f"dashboard:predictions:stats:{hours}"
    cached = get_cached(cache_key)
    if cached:
        return cached
    
    since = datetime.utcnow() - timedelta(hours=hours)
    
    total = await session.scalar(
        select(func.count(Prediction.id)).where(Prediction.created_at >= since)
    )
    
    # Count by status
    status_counts = {}
    for status in ["normal", "warning", "critical"]:
        count = await session.scalar(
            select(func.count(Prediction.id)).where(
                and_(
                    Prediction.timestamp >= since,
                    Prediction.status == status
                )
            )
        )
        status_counts[status] = count or 0
    
    result = {
        "total": total or 0,
        "by_status": status_counts,
        "period_hours": hours,
    }
    
    set_cached(cache_key, result)
    return result


