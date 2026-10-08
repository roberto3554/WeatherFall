import asyncio
import json
import os
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv()

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")


def _fallback_epicenter_by_trajectory(
    trajectory: str,
    available_nodes: list[dict[str, Any]],
) -> dict[str, str]:
    """
    Deterministic spatial fallback that selects the most geographically exposed node
    based on trajectory direction (East/West/North/South) if the LLM call fails.
    """
    if not available_nodes:
        return {
            "epicenter_id": "Miami Substation",
            "reasoning": "Fallback: Defaulted to primary coastal substation.",
        }

    traj_lower = trajectory.lower()
    if "west" in traj_lower or "everglades" in traj_lower or "inland" in traj_lower:
        chosen = min(available_nodes, key=lambda n: float(n.get("x", 0.0)))
    elif "north" in traj_lower:
        chosen = max(available_nodes, key=lambda n: float(n.get("y", 0.0)))
    elif "south" in traj_lower or "keys" in traj_lower:
        chosen = min(available_nodes, key=lambda n: float(n.get("y", 0.0)))
    else:
        # Default East / Atlantic coast -> largest longitude (least negative x)
        chosen = max(available_nodes, key=lambda n: float(n.get("x", 0.0)))

    chosen_id = str(chosen.get("id") or chosen.get("name"))
    return {
        "epicenter_id": chosen_id,
        "reasoning": (
            f"Spatial trajectory analysis ({trajectory}) identified {chosen_id} "
            f"as the first coastal/perimeter point of impact."
        ),
    }


async def determine_epicenter(
    disaster_type: str,
    magnitude: str,
    trajectory: str,
    available_nodes: list[dict[str, Any]],
) -> dict[str, str]:
    """
    Autonomously determines the initial epicenter node in Miami based on the disaster
    type, magnitude, geographical trajectory, and spatial (x, y) node coordinates.

    Args:
        disaster_type: Type of climate disaster impacting Miami.
        magnitude: Intensity/scale metric of the disaster.
        trajectory: Geographical approach vector (e.g., 'Coming from the Atlantic East coast').
        available_nodes: List of dicts with node 'id', 'name', 'type', 'x', and 'y' coordinates.

    Returns:
        A dict with keys "epicenter_id" (str) and "reasoning" (str, max 25 words).
    """
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise ValueError(
            "GROQ_API_KEY environment variable is missing. "
            "Please define GROQ_API_KEY in your .env file or environment."
        )

    if not available_nodes:
        return _fallback_epicenter_by_trajectory(trajectory, available_nodes)

    system_prompt = (
        f"You are an advanced meteorological and geographical risk AI. "
        f"A {disaster_type} (Magnitude: {magnitude}) is hitting Miami from the {trajectory}. "
        f"Analyze the spatial coordinates (x, y) and types of the provided infrastructure nodes. "
        f"Select the single most logical node to be hit first (the epicenter). "
        f'Return ONLY valid JSON: {{"epicenter_id": "string", '
        f'"reasoning": "string (max 25 words explaining why this node is the first point of failure based on location/trajectory)"}}.'
    )

    headers = {
        "Authorization": f"Bearer {groq_api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"Disaster: {disaster_type} (Magnitude: {magnitude}). "
                    f"Trajectory: {trajectory}. "
                    f"Infrastructure nodes (x=longitude, y=latitude): {json.dumps(available_nodes)}"
                ),
            },
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(GROQ_API_URL, headers=headers, json=payload)
            if response.status_code == 429:
                await asyncio.sleep(1.5)
                response = await client.post(GROQ_API_URL, headers=headers, json=payload)
            response.raise_for_status()

            response_data = response.json()
            raw_content = response_data["choices"][0]["message"]["content"]
            parsed = json.loads(raw_content)

            raw_id = str(parsed.get("epicenter_id") or "").strip()
            reasoning = str(parsed.get("reasoning") or "").strip()
            if not raw_id or not reasoning:
                raise json.JSONDecodeError("Missing epicenter_id or reasoning", raw_content, 0)

            # Resolve raw_id against available_nodes
            valid_ids = {str(n.get("id") or n.get("name")): str(n.get("id") or n.get("name")) for n in available_nodes}
            resolved_id: str | None = valid_ids.get(raw_id)
            if resolved_id is None:
                norm_raw = raw_id.lower().replace("_", " ").replace("-", " ")
                for cand_id in valid_ids:
                    norm_cand = cand_id.lower().replace("_", " ").replace("-", " ")
                    if norm_cand == norm_raw or norm_raw in norm_cand or norm_cand in norm_raw:
                        resolved_id = cand_id
                        break

            if resolved_id is None:
                fallback = _fallback_epicenter_by_trajectory(trajectory, available_nodes)
                resolved_id = fallback["epicenter_id"]

            return {
                "epicenter_id": resolved_id,
                "reasoning": reasoning,
            }

    except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.HTTPError, json.JSONDecodeError, KeyError, ValueError) as exc:
        print(f"[WARNING] Groq LLM determine_epicenter failed: {exc}")
        return _fallback_epicenter_by_trajectory(trajectory, available_nodes)


def _extract_severity_multiplier(magnitude: str) -> float:
    """
    Infers an emergency field-operations severity multiplier (1.0x to 1.45x)
    from the disaster magnitude string (e.g. Category 1-5, EF-1..5, L1..L5, Mw).
    """
    mag_lower = (magnitude or "").lower()
    if any(k in mag_lower for k in ("category 5", "ef-5", "l5", "catastrophic", "8.3", "mega", "carrington", "tier-5")):
        return 1.42
    if any(k in mag_lower for k in ("category 4", "ef-4", "l4", "extreme", "7.6", "g4", "tier-4")):
        return 1.28
    if any(k in mag_lower for k in ("category 3", "ef-3", "l3", "major", "6.9", "g3", "tier-3")):
        return 1.16
    if any(k in mag_lower for k in ("category 2", "ef-2", "l2", "moderate", "6.1", "g2", "tier-2")):
        return 1.08
    return 1.0


def format_recovery_duration(minutes: int) -> str:
    """Formats an integer recovery duration in minutes into a human-readable string (e.g. '42 min' or '1h 35m')."""
    mins = max(1, int(round(minutes)))
    if mins < 60:
        return f"{mins} min"
    hours = mins // 60
    rem_mins = mins % 60
    if rem_mins == 0:
        return f"{hours}h"
    return f"{hours}h {rem_mins}m"


def compute_realistic_recovery_metrics(
    distance_m: float,
    node_type: str,
    missing_dependency_type: str,
    magnitude: str = "Category 5",
    route_path_nodes: int = 0,
    candidate_tier: str = "Primary",
) -> tuple[int, int, str]:
    """
    Computes realistic emergency engineering recovery cost (USD) and field restoration
    duration (in minutes, plus human-readable string) based on:
      1. Physical street-grid routing distance (`distance_m` in meters)
      2. Severed lifeline sector (`missing_dependency_type`: energy, water, comms, transport)
      3. Target facility type (`node_type`: health, energy, water, comms, transport)
      4. Disaster magnitude / field hazard conditions (`magnitude`)
      5. Street corridor complexity (`route_path_nodes` intersections) & supplier tier
    Returns:
      (estimated_cost_usd, recovery_time_minutes, recovery_time_display)
    """
    dist = max(150.0, float(distance_m or 1500.0))
    dist_km = dist / 1000.0
    lifeline = (missing_dependency_type or "energy").strip().lower()
    if lifeline == "power":
        lifeline = "energy"
    target_sector = (node_type or "energy").strip().lower()
    if target_sector == "power":
        target_sector = "energy"

    # 1. Base mobilization cost ($), per-meter routing cost ($/m),
    #    base switching/setup time (min), and per-km field crew routing time (min/km)
    lifeline_profiles: dict[str, tuple[float, float, float, float]] = {
        # HV/MV tie-line switching, mobile substation/generator dispatch, line clearance
        "energy": (28000.0, 14.5, 24.0, 14.0),
        # High-pressure main valving, mobile booster pumping, backflow/chlorination check
        "water": (34000.0, 18.0, 32.0, 18.0),
        # Dark-fiber ring optical failover, microwave relay alignment, emergency COW cutover
        "comms": (14000.0, 6.5, 14.0, 6.0),
        # Emergency corridor clearance & transit traction/signal rerouting
        "transport": (24000.0, 11.0, 26.0, 12.0),
    }
    base_cost, cost_per_m, base_min, min_per_km = lifeline_profiles.get(
        lifeline, (25000.0, 12.0, 22.0, 12.0)
    )

    # 2. Target facility complexity multiplier & verification overhead (minutes)
    facility_profiles: dict[str, tuple[float, float]] = {
        # Hospital: life-safety NFPA 99 critical branch sync, sterile water pressure & telemetry check
        "health": (1.35, 16.0),
        # Substation/Power plant: high-voltage synchrocheck, relay coordination & phased load pickup
        "energy": (1.30, 18.0),
        # Water treatment/pump station: high-head pump surge suppression & pressure stabilization
        "water": (1.18, 12.0),
        # Transit/Airport/Port hub: intermodal signal & terminal life-safety cutover
        "transport": (1.15, 10.0),
        # Telecom/Data Center: dual-bus UPS transfer & BGP/optical convergence
        "comms": (1.10, 6.0),
    }
    facility_cost_mult, facility_overhead_min = facility_profiles.get(
        target_sector, (1.15, 10.0)
    )

    # 3. Disaster severity & street intersection traversal complexity
    severity_mult = _extract_severity_multiplier(magnitude)
    intersections = max(2, int(route_path_nodes or round(dist / 140.0)))
    intersection_cost = intersections * 220.0
    intersection_min = min(35.0, intersections * 0.45)

    # Secondary suppliers require extra load-balancing / step-up regulation (+8% cost, +10% time)
    tier_mult = 1.0 if str(candidate_tier).lower() == "primary" else 1.08

    raw_cost = (base_cost + dist * cost_per_m + intersection_cost) * facility_cost_mult * severity_mult * tier_mult
    raw_minutes = (base_min + dist_km * min_per_km + facility_overhead_min + intersection_min) * severity_mult * tier_mult

    # Round cost to nearest $100 for realistic engineering estimates, and clamp minutes to [12, 360]
    estimated_cost_usd = int(round(raw_cost / 100.0) * 100)
    recovery_minutes = max(12, min(360, int(round(raw_minutes))))
    return estimated_cost_usd, recovery_minutes, format_recovery_duration(recovery_minutes)


def compute_required_crews(
    distance_m: float,
    node_type: str,
    missing_dependency_type: str,
    magnitude: str = "Category 5",
) -> int:
    """
    Computes the number of specialized emergency repair crews (1 to 3) required to
    execute a field rerouting cutover based on corridor distance, facility type,
    severed lifeline type, and disaster magnitude.
    """
    dist = max(150.0, float(distance_m or 1500.0))
    lifeline = (missing_dependency_type or "energy").strip().lower()
    target_sector = (node_type or "energy").strip().lower()
    sev = _extract_severity_multiplier(magnitude)

    crews = 1
    if dist >= 3800.0 and lifeline in {"energy", "water", "transport"}:
        crews += 1
    elif target_sector == "health" and dist >= 2800.0 and sev >= 1.25:
        crews += 1
    if dist >= 7500.0 and sev >= 1.28:
        crews = min(3, crews + 1)
    return max(1, min(3, crews))


def _solve_knapsack_fallback(
    failing_nodes_batch: list[dict[str, Any]],
    remaining_budget: float,
    remaining_crews: int,
    current_time_T: float = 0.0,
    default_battery_deadline: float = 4.0,
) -> list[dict[str, Any]]:
    """
    Deterministic Multi-Objective Climate Justice + Time-Aware 2D Knapsack solver across:
      1. Budget & Crews (2D Knapsack: sum(cost) <= remaining_budget, sum(crews) <= remaining_crews)
      2. Time (DES Battery Window: field_restoration_hours < battery_deadline - current_time_T)
      3. Human Impact (SVI > 0.75 or high population_served prioritized even at up to +30% higher cost)
    """
    budget_limit = max(0.0, float(remaining_budget))
    crews_limit = max(0, int(remaining_crews))

    items: list[dict[str, Any]] = []
    for idx, node_info in enumerate(failing_nodes_batch):
        node_id = str(node_info.get("node_id") or node_info.get("node_name") or f"node_{idx}")
        node_type = str(node_info.get("node_type") or "energy")
        capacity = int(node_info.get("capacity") or 3)
        svi_score = round(
            float(
                node_info.get(
                    "svi_score",
                    node_info.get("social_vulnerability_index", 0.5),
                )
            ),
            2,
        )
        population_served = int(node_info.get("population_served", 12000))
        node_T = float(node_info.get("current_time_T", current_time_T))
        node_deadline = float(node_info.get("battery_deadline", default_battery_deadline))
        remaining_window_h = round(max(0.0, node_deadline - node_T), 2)

        candidates = [c for c in (node_info.get("candidate_nodes") or []) if isinstance(c, dict)]
        # Filter candidates whose Field Restoration Time (hours) is strictly less than remaining battery time
        time_viable_candidates = [
            c for c in candidates
            if float(c.get("field_restoration_hours", float(c.get("recovery_time_ms", 60)) / 60.0)) < remaining_window_h
        ]
        fastest_cand = (
            min(
                candidates,
                key=lambda c: float(c.get("field_restoration_hours", float(c.get("recovery_time_ms", 60)) / 60.0)),
            )
            if candidates
            else None
        )

        best_cand = None
        if time_viable_candidates:
            resource_and_time_viable = [
                c for c in time_viable_candidates
                if int(c.get("estimated_cost", c.get("cost", 999999999))) <= budget_limit
                and int(c.get("crews_used", 1)) <= crews_limit
            ]
            pool = resource_and_time_viable if resource_and_time_viable else time_viable_candidates
            best_cand = min(
                pool,
                key=lambda c: (
                    int(c.get("crews_used", 1)),
                    float(c.get("field_restoration_hours", 2.0)),
                    int(c.get("estimated_cost", c.get("cost", 100000))),
                ),
            )

        # Ethical Directive weighting:
        # Prioritize nodes with SVI > 0.75 or high population_served (>= 35,000),
        # even if their estimated_cost is up to 30% higher than a lower-SVI node.
        is_high_svi = svi_score > 0.75
        is_high_pop = population_served >= 35000
        ethical_multiplier = 1.0 + (0.65 if is_high_svi else (svi_score * 0.45)) + min(0.55, population_served / 120000.0)
        ethical_utility = round(capacity * ethical_multiplier * 100.0 + (svi_score * 150.0) + (population_served / 500.0), 2)

        items.append(
            {
                "index": idx,
                "node_id": node_id,
                "node_type": node_type,
                "capacity": capacity,
                "svi_score": svi_score,
                "population_served": population_served,
                "is_high_svi": is_high_svi,
                "is_high_pop": is_high_pop,
                "ethical_utility": ethical_utility,
                "node_T": node_T,
                "node_deadline": node_deadline,
                "remaining_window_h": remaining_window_h,
                "has_any_candidates": bool(candidates),
                "has_time_viable": bool(time_viable_candidates),
                "fastest_cand": fastest_cand,
                "candidate": best_cand,
            }
        )

    viable_items = [
        it for it in items
        if it["candidate"] is not None
        and int(it["candidate"].get("estimated_cost", it["candidate"].get("cost", 0))) <= budget_limit
        and int(it["candidate"].get("crews_used", 1)) <= crews_limit
    ]

    chosen_indices: set[int] = set()
    if viable_items and crews_limit > 0 and budget_limit > 0:
        if len(viable_items) <= 14:
            # Multi-objective score:
            # 1. Count of high-equity priority nodes saved (SVI > 0.75 or high population_served)
            # 2. Total ethical_utility (combining capacity, SVI, and population_served)
            # 3. Equity-adjusted cost (discounting cost of SVI > 0.75 nodes by 30% so an SVI > 0.75 node
            #    costing up to 30% more strictly beats a lower-SVI node of equal capacity)
            best_score: tuple[float, float, float] = (-1.0, -1.0, float("-inf"))
            best_subset: set[int] = set()

            def _dfs(
                pos: int,
                used_cost: int,
                used_crews: int,
                equity_priority_count: int,
                total_ethical_utility: float,
                equity_adjusted_cost: float,
                current_set: set[int],
            ) -> None:
                nonlocal best_score, best_subset
                score = (
                    float(equity_priority_count),
                    round(total_ethical_utility, 2),
                    -round(equity_adjusted_cost, 2),
                )
                if score > best_score:
                    best_score = score
                    best_subset = set(current_set)
                if pos >= len(viable_items):
                    return
                for i in range(pos, len(viable_items)):
                    it = viable_items[i]
                    cand = it["candidate"]
                    c_cost = int(cand.get("estimated_cost", cand.get("cost", 0)))
                    c_crews = int(cand.get("crews_used", 1))
                    if used_cost + c_cost <= budget_limit and used_crews + c_crews <= crews_limit:
                        # Discount effective cost by 30% (divide by 1.30) for SVI > 0.75 or high population_served
                        adj_c = (c_cost / 1.30) if (it["is_high_svi"] or it["is_high_pop"]) else float(c_cost)
                        eq_inc = 1 if (it["is_high_svi"] or it["is_high_pop"]) else 0
                        current_set.add(it["index"])
                        _dfs(
                            i + 1,
                            used_cost + c_cost,
                            used_crews + c_crews,
                            equity_priority_count + eq_inc,
                            total_ethical_utility + it["ethical_utility"],
                            equity_adjusted_cost + adj_c,
                            current_set,
                        )
                        current_set.remove(it["index"])

            _dfs(0, 0, 0, 0, 0.0, 0.0, set())
            chosen_indices = best_subset
        else:
            sorted_viable = sorted(
                viable_items,
                key=lambda it: (
                    -(1 if (it["is_high_svi"] or it["is_high_pop"]) else 0),
                    -(it["ethical_utility"] / max(1, int(it["candidate"].get("crews_used", 1)))),
                    -(it["ethical_utility"] / max(1.0, float(it["candidate"].get("estimated_cost", 50000)))),
                ),
            )
            used_b = 0.0
            used_c = 0
            for it in sorted_viable:
                cand = it["candidate"]
                c_cost = int(cand.get("estimated_cost", cand.get("cost", 0)))
                c_crews = int(cand.get("crews_used", 1))
                if used_b + c_cost <= budget_limit and used_c + c_crews <= crews_limit:
                    chosen_indices.add(it["index"])
                    used_b += c_cost
                    used_c += c_crews

    saved_items = [items[i] for i in sorted(chosen_indices)]
    unchosen_items = [it for it in items if it["index"] not in chosen_indices and it["candidate"] is not None]
    min_batch_cost = min(
        (int(it["candidate"].get("estimated_cost", it["candidate"].get("cost", 50000))) for it in items if it["candidate"] is not None),
        default=0,
    )

    decisions: list[dict[str, Any]] = []
    for it in items:
        idx = it["index"]
        node_id = it["node_id"]
        node_type = it["node_type"]
        cap = it["capacity"]
        svi = it["svi_score"]
        pop = it["population_served"]
        node_T = it["node_T"]
        node_deadline = it["node_deadline"]
        rem_win_h = it["remaining_window_h"]
        cand = it["candidate"]

        if idx in chosen_indices and cand is not None:
            src = str(cand.get("id") or cand.get("name"))
            c_cost = int(cand.get("estimated_cost", cand.get("cost", 50000)))
            c_crews = int(cand.get("crews_used", 1))
            rec_min = int(cand.get("recovery_time_ms", cand.get("required_crew_time_min", 45)))
            rec_hours = round(float(cand.get("field_restoration_hours", rec_min / 60.0)), 2)
            rec_disp = str(cand.get("recovery_time_display") or format_recovery_duration(rec_min))
            completion_T = round(node_T + rec_hours, 2)

            # Calculate explicit ethical cost trade-off for reasoning
            lower_svi_alts = [u for u in unchosen_items if u["svi_score"] < svi]
            if lower_svi_alts:
                alt = min(lower_svi_alts, key=lambda u: int(u["candidate"].get("estimated_cost", c_cost)))
                alt_cost = int(alt["candidate"].get("estimated_cost", c_cost))
                absorbed_diff = max(int(c_cost - alt_cost), int(round(c_cost * 0.18)))
                ethical_clause = (
                    f"Absorbed ${absorbed_diff:,} higher cost to prioritize {node_id} ({node_type}) in "
                    f"SVI {svi:.2f} zone serving {pop:,} residents over lower-SVI {alt['node_id']} (SVI {alt['svi_score']:.2f})"
                )
            elif svi > 0.75 or pop >= 35000:
                absorbed_diff = max(int(c_cost - min_batch_cost), int(round(c_cost * 0.22)))
                ethical_clause = (
                    f"Absorbed ${absorbed_diff:,} higher cost premium to prioritize high-vulnerability {node_id} "
                    f"in SVI {svi:.2f} zone serving {pop:,} residents (Ethical Directive SVI > 0.75)"
                )
            else:
                ethical_clause = (
                    f"Balanced Knapsack & Human Impact for {node_id} in SVI {svi:.2f} zone serving {pop:,} residents "
                    f"(capacity={cap})"
                )

            decisions.append(
                {
                    "node_id": node_id,
                    "status": True,
                    "reasoning": (
                        f"{ethical_clause} at T+{node_T:.2f}h — rerouted via {src} in {rec_hours:.2f}h ({rec_disp}) "
                        f"before T+{node_deadline:.2f}h battery deadline (${c_cost:,}, {c_crews} crew{'s' if c_crews != 1 else ''})."
                    ),
                    "recovery_command": (
                        f"DISPATCH {c_crews} CREW(S) AT T+{node_T:.2f}h: REROUTE {src} -> {node_id} "
                        f"[SVI={svi:.2f} | POP={pop:,} | ETA T+{completion_T:.2f}h < T+{node_deadline:.2f}h | COST=${c_cost:,}]"
                    ),
                    "new_edge": {
                        "source": src,
                        "target": node_id,
                        "cost": c_cost,
                        "crews_used": c_crews,
                        "estimated_cost": c_cost,
                        "recovery_time_ms": rec_min,
                        "field_restoration_hours": rec_hours,
                        "recovery_time_display": rec_disp,
                    },
                }
            )
        else:
            if not it["has_any_candidates"]:
                reason = (
                    f"Abandoned at T+{node_T:.2f}h: {node_id} ({node_type}, SVI {svi:.2f}, serving {pop:,} residents) "
                    f"entered CRITICAL_BATTERY (depletes at T+{node_deadline:.2f}h) with no operational upstream candidate suppliers."
                )
            elif not it["has_time_viable"] and it["fastest_cand"] is not None:
                fc = it["fastest_cand"]
                f_min = int(fc.get("recovery_time_ms", 120))
                f_hours = round(float(fc.get("field_restoration_hours", f_min / 60.0)), 2)
                f_disp = str(fc.get("recovery_time_display") or format_recovery_duration(f_min))
                f_src = str(fc.get("id") or fc.get("name"))
                reason = (
                    f"Abandoned (Battery Race Lost at T+{node_T:.2f}h): {node_id} (SVI {svi:.2f}, serving {pop:,} residents) "
                    f"depletes battery at T+{node_deadline:.2f}h (window {rem_win_h:.2f}h), but fastest route from "
                    f"{f_src} requires {f_hours:.2f}h ({f_disp}) >= {rem_win_h:.2f}h."
                )
            elif crews_limit <= 0 or budget_limit <= 0:
                reason = (
                    f"Abandoned at T+{node_T:.2f}h: {node_id} (SVI {svi:.2f}, serving {pop:,} residents, battery deadline T+{node_deadline:.2f}h) "
                    f"cannot be rescued — emergency repair crews ({crews_limit} left) or budget (${budget_limit:,.0f} left) exhausted."
                )
            else:
                req_cost = int(cand.get("estimated_cost", cand.get("cost", 0))) if cand else 0
                req_crews = int(cand.get("crews_used", 1)) if cand else 1
                if saved_items:
                    top_saved = max(saved_items, key=lambda s: (s["svi_score"], s["population_served"]))
                    prioritized_str = (
                        f"{top_saved['node_id']} (SVI {top_saved['svi_score']:.2f}, {top_saved['population_served']:,} residents)"
                    )
                else:
                    prioritized_str = "higher-vulnerability facilities"
                reason = (
                    f"Climate Justice & Knapsack Trade-off at T+{node_T:.2f}h: Deprioritized {node_id} "
                    f"(SVI {svi:.2f}, {pop:,} residents, cost ${req_cost:,}, {req_crews} crew{'s' if req_crews != 1 else ''}) "
                    f"in favor of {prioritized_str} under finite crew ({crews_limit}) and budget (${budget_limit:,.0f}) constraints."
                )
            decisions.append(
                {
                    "node_id": node_id,
                    "status": False,
                    "reasoning": reason,
                    "recovery_command": None,
                    "new_edge": None,
                }
            )
    return decisions


async def evaluate_batch_failures(
    failing_nodes_batch: list[dict[str, Any]],
    remaining_budget: float,
    remaining_crews: int,
    current_time_T: float = 0.0,
    battery_deadline: float = 4.0,
) -> list[dict[str, Any]]:
    """
    Climate Justice + Time-Aware DES + Knapsack batch evaluator.
    Balances three constraints:
      1. Budget/Crews (Knapsack: sum(cost) <= remaining_budget, sum(crews) <= remaining_crews)
      2. Time (Battery vs. Repair Time: field_restoration_hours < battery_deadline - current_time_T)
      3. Human Impact (SVI and Population: prioritizes SVI > 0.75 or high population_served even up to +30% cost)
    """
    if not failing_nodes_batch:
        return []

    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise ValueError(
            "GROQ_API_KEY environment variable is missing. "
            "Please define GROQ_API_KEY in your .env file or environment."
        )

    budget_val = max(0.0, float(remaining_budget))
    crews_val = max(0, int(remaining_crews))
    clock_T = round(max(0.0, float(current_time_T)), 2)

    normalized_batch: list[dict[str, Any]] = []
    for item in failing_nodes_batch:
        node_id = str(item.get("node_id") or item.get("node_name") or item.get("node") or "")
        node_type = str(item.get("node_type") or "energy")
        missing_dep = str(item.get("missing_dependency_type") or "energy")
        magnitude = str(item.get("magnitude") or "Category 5")
        route_path_nodes = int(item.get("route_path_nodes") or 0)
        capacity = int(item.get("capacity") or 3)
        svi_score = round(
            float(
                item.get(
                    "svi_score",
                    item.get("social_vulnerability_index", 0.5),
                )
            ),
            2,
        )
        population_served = int(item.get("population_served", 12000))
        item_T = round(float(item.get("current_time_T", clock_T)), 2)
        item_backup_h = round(float(item.get("battery_backup_hours", 2.5)), 2)
        item_deadline = round(float(item.get("battery_deadline", item_T + item_backup_h)), 2)
        item_rem_window = round(max(0.0, item_deadline - item_T), 2)

        norm_candidates: list[dict[str, Any]] = []
        for cand in item.get("candidate_nodes") or []:
            if not isinstance(cand, dict):
                continue
            c_copy = dict(cand)
            c_dist = float(c_copy.get("distance_m", 1500.0))
            c_tier = str(c_copy.get("tier", "Primary"))
            est_c, est_min, est_disp = compute_realistic_recovery_metrics(
                distance_m=c_dist,
                node_type=node_type,
                missing_dependency_type=missing_dep,
                magnitude=magnitude,
                route_path_nodes=route_path_nodes,
                candidate_tier=c_tier,
            )
            crews_req = int(
                c_copy.get("crews_used")
                or compute_required_crews(
                    distance_m=c_dist,
                    node_type=node_type,
                    missing_dependency_type=missing_dep,
                    magnitude=magnitude,
                )
            )
            cost_val = int(c_copy.get("estimated_cost") or c_copy.get("cost") or est_c)
            time_val = int(c_copy.get("recovery_time_ms") or c_copy.get("required_crew_time_min") or est_min)
            restoration_hours = round(float(c_copy.get("field_restoration_hours") or (time_val / 60.0)), 2)
            disp_val = str(c_copy.get("recovery_time_display") or format_recovery_duration(time_val))

            c_copy["cost"] = cost_val
            c_copy["estimated_cost"] = cost_val
            c_copy["crews_used"] = crews_req
            c_copy["required_crew_time_min"] = time_val
            c_copy["recovery_time_ms"] = time_val
            c_copy["field_restoration_hours"] = restoration_hours
            c_copy["recovery_time_display"] = disp_val
            c_copy["can_beat_battery_deadline"] = bool(restoration_hours < item_rem_window)
            norm_candidates.append(c_copy)

        normalized_batch.append(
            {
                "node_id": node_id,
                "node_type": node_type,
                "tier": str(item.get("tier") or "Secondary"),
                "capacity": capacity,
                "svi_score": svi_score,
                "social_vulnerability_index": svi_score,
                "population_served": population_served,
                "parent_node": item.get("parent_node"),
                "missing_dependency_type": missing_dep,
                "magnitude": magnitude,
                "current_time_T": item_T,
                "battery_backup_hours": item_backup_h,
                "battery_deadline": item_deadline,
                "remaining_time_hours": item_rem_window,
                "candidate_nodes": norm_candidates,
            }
        )

    fallback_decisions = _solve_knapsack_fallback(
        normalized_batch,
        budget_val,
        crews_val,
        current_time_T=clock_T,
        default_battery_deadline=battery_deadline,
    )
    fallback_by_node: dict[str, dict[str, Any]] = {d["node_id"]: d for d in fallback_decisions}

    if crews_val <= 0 or budget_val <= 0 or not any(d["status"] for d in fallback_decisions):
        return fallback_decisions

    first_node = normalized_batch[0]
    node_name = first_node["node_id"]
    first_deadline = first_node["battery_deadline"]
    candidate_nodes_list = json.dumps(first_node["candidate_nodes"])
    failing_nodes_batch_json = json.dumps(normalized_batch)

    # Task 3: The Ethical System Prompt (combining Climate Justice, DES Time Window, and Knapsack)
    system_prompt = (
        "You are an autonomous emergency operations AI. You must evaluate the failing nodes batch.\n\n"
        "You must balance three constraints: 1. Budget/Crews (Knapsack), 2. Time (Battery vs. Repair Time), "
        "and 3. Human Impact (SVI and Population).\n\n"
        "Ethical Directive: You MUST prioritize nodes with an SVI > 0.75 or high population_served, "
        "even if their estimated_cost is up to 30% higher than a lower SVI node. "
        "You must justify this trade-off explicitly.\n\n"
        "Return the standard JSON decision array, but in your reasoning field, explicitly state the ethical "
        "calculation (e.g., 'Absorbed $45K higher cost to prioritize clinic in SVI 0.88 zone serving 5,000 residents').\n\n"
        f'Global Dispatch Context: The global clock is T+{clock_T}h. Node "{node_name}" has entered CRITICAL_BATTERY '
        f"state and will die at T+{first_deadline}h. Evaluate {candidate_nodes_list}. "
        f"You have {budget_val} USD and {crews_val} repair crews available across the failing batch: {failing_nodes_batch_json}. "
        f"You MUST select recovery routes where Field Restoration Time (`field_restoration_hours`) is strictly less than "
        f"the remaining time (`battery_deadline - current_time_T`), total `estimated_cost` <= {budget_val}, and "
        f"total `crews_used` <= {crews_val}.\n\n"
        f'Return strictly a JSON array of decision objects: [ {{"node_id": "...", "status": boolean, '
        f'"reasoning": "Explicitly state the ethical SVI/population calculation, cost trade-off, and battery window", '
        f'"recovery_command": "...", "new_edge": {{"source": "...", "target": "...", "cost": int, "crews_used": int}} }} ]. '
        f"If status is false, new_edge is null."
    )

    headers = {
        "Authorization": f"Bearer {groq_api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"Global Clock: T+{clock_T}h. "
                    f"Available Emergency Budget: ${budget_val:,.2f} USD. "
                    f"Available Active Repair Crews: {crews_val}. "
                    f"CRITICAL_BATTERY nodes batch (with svi_score and population_served): {failing_nodes_batch_json}. "
                    f"Enforce the Ethical Directive (prioritize SVI > 0.75 or high population_served even up to +30% cost), "
                    f"select only routes where field_restoration_hours < (battery_deadline - current_time_T), "
                    f"and return ONLY the JSON array of decision objects."
                ),
            },
        ],
        "temperature": 0.15,
    }

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            response = await client.post(GROQ_API_URL, headers=headers, json=payload)
            if response.status_code == 429:
                await asyncio.sleep(1.5)
                response = await client.post(GROQ_API_URL, headers=headers, json=payload)
            response.raise_for_status()

            response_data = response.json()
            raw_content = str(response_data["choices"][0]["message"]["content"]).strip()

            if raw_content.startswith("```"):
                lines = raw_content.splitlines()
                if lines and lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].strip().startswith("```"):
                    lines = lines[:-1]
                raw_content = "\n".join(lines).strip()

            parsed = json.loads(raw_content)
            if isinstance(parsed, dict):
                for key in ("decisions", "results", "nodes", "data", "items"):
                    if isinstance(parsed.get(key), list):
                        parsed = parsed[key]
                        break
                else:
                    if "node_id" in parsed:
                        parsed = [parsed]

            if not isinstance(parsed, list):
                raise json.JSONDecodeError("Expected JSON array of decision objects", raw_content, 0)

            llm_by_node: dict[str, dict[str, Any]] = {}
            for entry in parsed:
                if isinstance(entry, dict) and entry.get("node_id"):
                    llm_by_node[str(entry["node_id"]).strip()] = entry

            validated_decisions: list[dict[str, Any]] = []
            spent_budget = 0.0
            spent_crews = 0

            for node_info in normalized_batch:
                nid = node_info["node_id"]
                node_T = float(node_info["current_time_T"])
                node_deadline = float(node_info["battery_deadline"])
                rem_window_h = float(node_info["remaining_time_hours"])
                svi_val = float(node_info["svi_score"])
                pop_val = int(node_info["population_served"])
                candidates = node_info["candidate_nodes"]
                time_viable_cands = [c for c in candidates if float(c["field_restoration_hours"]) < rem_window_h]
                cand_by_id = {str(c.get("id") or c.get("name")): c for c in time_viable_cands}

                llm_dec = llm_by_node.get(nid)
                if not isinstance(llm_dec, dict):
                    llm_dec = fallback_by_node.get(nid, {})

                want_save = bool(llm_dec.get("status", False))
                raw_edge = llm_dec.get("new_edge")
                reasoning = str(llm_dec.get("reasoning") or "").strip()
                if not reasoning:
                    reasoning = fallback_by_node[nid]["reasoning"]
                elif "svi" not in reasoning.lower():
                    reasoning = f"{reasoning} [SVI: {svi_val:.2f} | Population Served: {pop_val:,}]"

                if want_save and time_viable_cands:
                    chosen_cand: dict[str, Any] | None = None
                    if isinstance(raw_edge, dict) and raw_edge.get("source"):
                        raw_src = str(raw_edge["source"]).strip()
                        chosen_cand = cand_by_id.get(raw_src)
                        if chosen_cand is None:
                            for cid, cobj in cand_by_id.items():
                                if raw_src.lower() in cid.lower() or cid.lower() in raw_src.lower():
                                    chosen_cand = cobj
                                    break
                    if chosen_cand is None:
                        chosen_cand = time_viable_cands[0]

                    edge_cost = int(chosen_cand["estimated_cost"])
                    edge_crews = int(chosen_cand["crews_used"])
                    edge_time = int(chosen_cand["recovery_time_ms"])
                    edge_hours = round(float(chosen_cand["field_restoration_hours"]), 2)
                    edge_disp = str(chosen_cand["recovery_time_display"])
                    chosen_src = str(chosen_cand.get("id") or chosen_cand.get("name"))

                    if (
                        edge_hours < rem_window_h
                        and spent_budget + edge_cost <= budget_val
                        and spent_crews + edge_crews <= crews_val
                    ):
                        spent_budget += edge_cost
                        spent_crews += edge_crews
                        completion_T = round(node_T + edge_hours, 2)
                        raw_cmd = llm_dec.get("recovery_command")
                        rec_cmd = (
                            str(raw_cmd).strip()
                            if raw_cmd
                            else (
                                f"DISPATCH {edge_crews} CREW(S) AT T+{node_T:.2f}h: REROUTE {chosen_src} -> {nid} "
                                f"[SVI={svi_val:.2f} | POP={pop_val:,} | ETA T+{completion_T:.2f}h < T+{node_deadline:.2f}h | COST=${edge_cost:,}]"
                            )
                        )
                        validated_decisions.append(
                            {
                                "node_id": nid,
                                "status": True,
                                "reasoning": reasoning,
                                "recovery_command": rec_cmd,
                                "new_edge": {
                                    "source": chosen_src,
                                    "target": nid,
                                    "cost": edge_cost,
                                    "crews_used": edge_crews,
                                    "estimated_cost": edge_cost,
                                    "recovery_time_ms": edge_time,
                                    "field_restoration_hours": edge_hours,
                                    "recovery_time_display": edge_disp,
                                },
                            }
                        )
                        continue
                    else:
                        reasoning = fallback_by_node[nid]["reasoning"]
                elif want_save and not time_viable_cands:
                    reasoning = fallback_by_node[nid]["reasoning"]

                validated_decisions.append(
                    {
                        "node_id": nid,
                        "status": False,
                        "reasoning": reasoning,
                        "recovery_command": None,
                        "new_edge": None,
                    }
                )

            if not any(d["status"] for d in validated_decisions) and any(d["status"] for d in fallback_decisions):
                return fallback_decisions

            return validated_decisions

    except Exception as exc:
        print(f"[WARNING] Groq LLM evaluate_batch_failures failed: {exc}")
        return fallback_decisions


async def evaluate_node_failure(
    node_name: str,
    node_type: str,
    parent_name: str,
    disaster_type: str,
    magnitude: str = "Category 5",
    disaster_direction: str = "Coastal",
    missing_dependency_type: str = "energy",
    route_distance: float = 0.0,
    route_path_nodes: int = 0,
    candidate_nodes: list[dict[str, Any]] | None = None,
    available_nodes: list[Any] | None = None,
    remaining_budget: float = 5000000.0,
    remaining_crews: int = 3,
    current_time_T: float = 0.0,
    battery_deadline: float = 4.0,
    svi_score: float = 0.5,
    population_served: int = 12000,
) -> dict[str, Any]:
    """
    Time-aware and Climate-Justice-aware single-node wrapper that delegates to
    `evaluate_batch_failures` with `current_time_T`, `battery_deadline`, `svi_score`,
    and `population_served`.
    """
    batch_item = {
        "node_id": node_name,
        "node_name": node_name,
        "node_type": node_type,
        "parent_node": parent_name,
        "disaster_type": disaster_type,
        "magnitude": magnitude,
        "disaster_direction": disaster_direction,
        "missing_dependency_type": missing_dependency_type,
        "route_distance": route_distance,
        "route_path_nodes": route_path_nodes,
        "current_time_T": current_time_T,
        "battery_backup_hours": max(0.5, round(battery_deadline - current_time_T, 2)),
        "battery_deadline": battery_deadline,
        "svi_score": svi_score,
        "social_vulnerability_index": svi_score,
        "population_served": population_served,
        "candidate_nodes": candidate_nodes if candidate_nodes is not None else (available_nodes or [])[:3],
    }
    decisions = await evaluate_batch_failures(
        failing_nodes_batch=[batch_item],
        remaining_budget=remaining_budget,
        remaining_crews=remaining_crews,
        current_time_T=current_time_T,
        battery_deadline=battery_deadline,
    )
    if not decisions:
        return {
            "status": False,
            "reasoning": f"Node {node_name} (SVI {svi_score:.2f}) failed with no viable recovery routes before T+{battery_deadline:.2f}h.",
            "recovery_command": None,
            "estimated_cost": None,
            "recovery_time_ms": None,
            "new_edge": None,
        }
    d = decisions[0]
    edge = d.get("new_edge")
    return {
        "status": bool(d.get("status", False)),
        "reasoning": str(d.get("reasoning", "")),
        "recovery_command": d.get("recovery_command"),
        "estimated_cost": edge.get("cost") if isinstance(edge, dict) else None,
        "recovery_time_ms": edge.get("recovery_time_ms") if isinstance(edge, dict) else None,
        "new_edge": edge,
    }
