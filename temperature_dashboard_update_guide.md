# Temperature Channels Dashboard — Implementation Guide

## Overview

This guide outlines the steps to extend the dashboard to detect and display **all temperature channels** dynamically, grouped by logical machine zones, replacing the current hardcoded 4-zone display.

---

## Step 1 — Audit the Current State

- Identify where temperature channels are currently defined in the codebase (look for hardcoded references to Zone 1–4 or a fixed list of temperature signal names).
- Note how `Temp_Avg` is currently calculated and where it is rendered in the dashboard.
- List every data signal coming from the live dataset to understand the full scope of available channels.

---

## Step 2 — Implement Dynamic Temperature Channel Detection

- Write a detection function that scans all incoming live signal values at runtime.
- Classification rule: any signal whose current value falls between **80°C and 300°C** is treated as a temperature channel.
- Do **not** rely on signal names or hardcoded lists — base detection purely on value range.
- Store the result as a dynamic list called `temperature_channels`, containing all signals that pass the rule.
- This list must be recalculated each time new data arrives.

---

## Step 3 — Cluster Channels Into Logical Groups

Apply a simple value-similarity grouping to separate the detected channels into machine zones:

**Group A — Main Extruder**
- Take the detected temperature channels and identify the 5 signals whose values cluster most closely together (smallest spread / tightest standard deviation).
- Label these as Main Extruder: Zone 1, Zone 2, Zone 3, Zone 4, Zone 5.

**Group B — Adapter / Tool**
- All remaining temperature channels after Group A is assigned go into this group.
- Label sequentially as Tool 1, Tool 2, Tool 3, Tool 4, Tool 5, Tool 6 (up to however many remain).

**Group C — Co-Extruder (Optional)**
- If a third distinct value cluster is detectable (clearly separated from both Group A and Group B), assign those channels as Co-Extruder zones.
- If no third cluster is found, this group is hidden from the dashboard entirely.

> Clustering does not need to be ML-based at this stage. A simple approach using value mean and spread comparison per channel is sufficient.

---

## Step 4 — Recalculate Group Statistics

For each group, compute the following derived values **dynamically** from the grouped channels (not from any hardcoded subset):

- **Group Average** (`Main Avg`, `Tool Avg`, `Co-Extruder Avg`): mean of all channel values within the group.
- **Group Spread** (`Main Spread`, `Tool Spread`, `Co-Extruder Spread`): difference between the max and min value within the group (range).

Remove or replace any existing `Temp_Avg` calculation that only uses 4 zones — it must now reflect the full detected channel set or the relevant group average.

---

## Step 5 — Redesign the Dashboard Temperature Section

Replace the existing single "Temperature Zone 1–4" block with a new **Temperature Overview** section structured as three sub-panels:

**Sub-panel 1: Main Extruder**
- Display: Zone 1, Zone 2, Zone 3, Zone 4, Zone 5
- Display: Main Avg, Main Spread

**Sub-panel 2: Adapter / Tool**
- Display: Tool 1, Tool 2, Tool 3, Tool 4, Tool 5, Tool 6
- Display: Tool Avg, Tool Spread

**Sub-panel 3: Co-Extruder** *(render only if the group is detected)*
- Display: all detected co-extruder channels
- Display: Co-Extruder Avg, Co-Extruder Spread

Layout rules:
- Each sub-panel should be visually distinct but part of a unified "Temperature Overview" block.
- Channel count per sub-panel is dynamic — the layout must handle variable numbers of channels without breaking.
- Avg and Spread values should be visually emphasized (larger text or highlighted card) within each sub-panel.

---

## Step 6 — Handle Edge Cases

- If fewer than 5 channels are detected for the Main Extruder group, display only the available channels — do not show empty zone slots.
- If no Tool channels are detected, hide the Adapter / Tool sub-panel.
- If the dataset contains no signals in the 80–300°C range, show a "No Temperature Signals Detected" placeholder in the Temperature Overview section.
- Ensure the layout degrades gracefully on smaller screens or when fewer groups are present.

---

## Step 7 — Validate Against Live Data

- Run the updated detection and grouping logic against a real or representative dataset snapshot.
- Confirm that the number of detected channels matches what is known about the machine (5 main zones + adapter + 6 tool zones + optional co-extruder).
- Verify that group averages and spreads are computed correctly.
- Visually review the dashboard to confirm all sub-panels render and that no channels are missing or duplicated.

---

## Step 8 — Remove Legacy Code

- Delete or disable all hardcoded references to exactly 4 temperature zones.
- Remove the old `Temp_Avg` calculation based on 4 zones.
- Clean up any static channel name lists that were used for temperature display.

---

## Summary of Key Rules

| Rule | Detail |
|---|---|
| Detection basis | Live value between 80°C and 300°C |
| No hardcoding | Names and counts must be dynamic |
| Group A size | 5 tightest-clustered channels |
| Group B | All remaining detected channels |
| Group C | Only if a third value cluster exists |
| Averages | Recalculated per group, not globally from 4 zones |
| Layout | Three sub-panels under one Temperature Overview header |
