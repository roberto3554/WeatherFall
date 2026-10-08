import asyncio
import heapq
import json
import math
import os
import uuid
from typing import Any

import networkx as nx
from celery import Celery
from celery.result import AsyncResult
from dotenv import load_dotenv
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

try:
    from .agent import (
        compute_realistic_recovery_metrics,
        compute_required_crews,
        determine_epicenter,
        evaluate_batch_failures,
        format_recovery_duration,
    )
    from .database import AsyncSessionLocal, engine
    from .models import Edge, Node, SimulationTrace
    from .schemas import Event
    from .seed_data import MIAMI_EDGES, MIAMI_NODES
    from .seed_miami import compute_demographic_profile
except ImportError:
    from agent import (
        compute_realistic_recovery_metrics,
        compute_required_crews,
        determine_epicenter,
        evaluate_batch_failures,
        format_recovery_duration,
    )
    from database import AsyncSessionLocal, engine
    from models import Edge, Node, SimulationTrace
    from schemas import Event
    from seed_data import MIAMI_EDGES, MIAMI_NODES
    from seed_miami import compute_demographic_profile

load_dotenv()

REDIS_URL: str = os.getenv("REDIS_URL", "redis://redis:6379/0")
CELERY_BROKER_URL: str = os.getenv("CELERY_BROKER_URL", REDIS_URL)
CELERY_RESULT_BACKEND: str = os.getenv("CELERY_RESULT_BACKEND", REDIS_URL)

celery_app = Celery(
    "weatherfall_worker",
    broker=CELERY_BROKER_URL,
    backend=CELERY_RESULT_BACKEND,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    result_expires=3600,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    broker_connection_retry_on_startup=True,
)

# In-memory fallback task registry when running without a live Redis/Celery worker process
LOCAL_TASK_STORE: dict[str, dict[str, Any]] = {}

MANDATORY_INCOMING_LIFELINES: dict[str, tuple[str, ...]] = {
    "health": ("energy", "water", "comms"),
    "energy": ("energy",),
    "water": ("energy",),
    "comms": ("energy",),
    "transport": ("energy",),
}


def _normalize_sector_type(raw_type: Any) -> str:
    """Normalizes facility sector strings (e.g. 'power' -> 'energy')."""
    val = str(raw_type or "energy").strip().lower()
    if val == "power":
        return "energy"
    return val


def _infer_node_hierarchy(node_name: str, node_type: str) -> tuple[str, int, float]:
    """
    Infers `(tier, capacity, battery_backup_hours)` for a node based on its facility
    sector and name when not explicitly specified.
    """
    ntype = _normalize_sector_type(node_type)
    nlower = node_name.lower()

    if ntype == "energy":
        is_primary = any(
            k in nlower
            for k in (
                "miami substation",
                "flagami",
                "levee",
                "davis",
                "culmer",
                "railway",
                "nuclear",
                "clean energy",
            )
        )
        return ("Primary", 6, 4.0) if is_primary else ("Secondary", 2, 2.5)
    if ntype == "water":
        is_primary = any(
            k in nlower
            for k in ("plant", "treatment", "central district", "alexander orr", "virginia key")
        )
        return ("Primary", 5, 3.5) if is_primary else ("Secondary", 2, 2.0)
    if ntype == "health":
        is_primary = any(
            k in nlower
            for k in (
                "jackson memorial",
                "mercy",
                "mount sinai",
                "baptist",
                "university",
                "trauma",
                "medical center",
            )
        )
        return ("Primary", 2, 4.5) if is_primary else ("Secondary", 1, 3.0)
    if ntype == "transport":
        is_primary = any(
            k in nlower
            for k in (
                "port",
                "airport",
                "central",
                "government center",
                "intermodal",
                "hub",
                "terminal",
                "dadeland",
            )
        )
        return ("Primary", 5, 3.0) if is_primary else ("Secondary", 2, 1.5)
    is_primary = any(k in nlower for k in ("nap", "equinix", "coresite", "downtown", "central"))
    return ("Primary", 5, 4.0) if is_primary else ("Secondary", 2, 2.2)


def _build_static_fallback_graph() -> nx.DiGraph:
    """Builds the static Miami infrastructure graph if PostgreSQL is empty."""
    graph = nx.DiGraph()
    for item in MIAMI_NODES:
        ntype = _normalize_sector_type(item["type"])
        tier, cap, backup_h = _infer_node_hierarchy(item["name"], ntype)
        lon_val = float(item.get("x", -80.205))
        lat_val = float(item.get("y", 25.778))
        svi_val, pop_val = compute_demographic_profile(
            name=item["name"],
            node_type=ntype,
            tier=tier,
            lon=lon_val,
            lat=lat_val,
        )
        graph.add_node(
            item["name"],
            type=ntype,
            x=lon_val,
            y=lat_val,
            tier=tier,
            capacity=cap,
            battery_backup_hours=backup_h,
            social_vulnerability_index=svi_val,
            svi_score=svi_val,
            population_served=pop_val,
        )
    graph.add_edges_from(MIAMI_EDGES)
    return graph


async def _load_graph_from_db(db: AsyncSession) -> nx.DiGraph:
    """Loads the Miami infrastructure graph from PostgreSQL for the simulation worker."""
    try:
        nodes_result = await db.execute(select(Node))
        db_nodes = list(nodes_result.scalars().all())
        if not db_nodes:
            return _build_static_fallback_graph()

        edges_result = await db.execute(select(Edge))
        db_edges = list(edges_result.scalars().all())

        graph = nx.DiGraph()
        id_to_name: dict[int, str] = {}
        id_to_type: dict[int, str] = {}

        for node in db_nodes:
            norm_type = _normalize_sector_type(node.type)
            id_to_name[node.id] = node.name
            id_to_type[node.id] = norm_type
            lon_val = float(node.x if node.x is not None else -80.205)
            lat_val = float(node.y if node.y is not None else 25.778)
            tier_val = str(node.tier or "Secondary")
            svi_inf, pop_inf = compute_demographic_profile(
                name=node.name,
                node_type=norm_type,
                tier=tier_val,
                lon=lon_val,
                lat=lat_val,
            )
            svi_val = float(
                node.social_vulnerability_index
                if node.social_vulnerability_index is not None
                else svi_inf
            )
            pop_val = int(node.population_served if node.population_served is not None else pop_inf)
            graph.add_node(
                node.name,
                id=node.id,
                type=norm_type,
                x=lon_val,
                y=lat_val,
                tier=tier_val,
                capacity=int(node.capacity or 3),
                battery_backup_hours=float(node.battery_backup_hours or 2.5),
                social_vulnerability_index=svi_val,
                svi_score=svi_val,
                population_served=pop_val,
            )

        for edge in db_edges:
            source_name = id_to_name.get(edge.source_node_id)
            target_name = id_to_name.get(edge.target_node_id)
            if source_name and target_name:
                src_type = id_to_type.get(edge.source_node_id, "energy")
                tgt_type = id_to_type.get(edge.target_node_id, "energy")
                graph.add_edge(
                    source_name,
                    target_name,
                    edge_id=edge.id,
                    source_node_id=edge.source_node_id,
                    target_node_id=edge.target_node_id,
                    dependency_type=src_type,
                    is_cyclic_fallback=(src_type == "transport" and tgt_type == "energy"),
                    routing_distance=edge.routing_distance,
                    path_nodes=edge.path_nodes,
                )

        return graph
    except Exception:
        return _build_static_fallback_graph()


def _estimate_osm_street_distance_m(
    graph: nx.DiGraph,
    undirected_graph: nx.Graph,
    source_node: str,
    target_node: str,
) -> float:
    """Calculates physical OSM street network distance (in meters) between two nodes."""
    direct_edge = (
        graph.get_edge_data(source_node, target_node)
        or graph.get_edge_data(target_node, source_node)
    )
    if direct_edge and direct_edge.get("routing_distance"):
        return round(float(direct_edge["routing_distance"]), 1)

    s_data = graph.nodes[source_node]
    t_data = graph.nodes[target_node]
    lon1, lat1 = float(s_data.get("x", 0.0)), float(s_data.get("y", 0.0))
    lon2, lat2 = float(t_data.get("x", 0.0)), float(t_data.get("y", 0.0))

    r_earth = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    euclidean_m = 2.0 * r_earth * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    street_grid_m = max(150.0, euclidean_m * 1.26)

    try:
        if nx.has_path(undirected_graph, source_node, target_node):
            graph_path_m = float(
                nx.shortest_path_length(
                    undirected_graph,
                    source=source_node,
                    target=target_node,
                    weight="routing_distance",
                )
            )
            if graph_path_m > 0 and graph_path_m <= street_grid_m * 2.2:
                return round(graph_path_m, 1)
    except Exception:
        pass

    return round(street_grid_m, 1)


def _get_viable_candidates(
    graph: nx.DiGraph,
    undirected_graph: nx.Graph,
    child_name: str,
    parent_name: str,
    failed_nodes: set[str],
    missing_dependency_type: str | None = None,
    node_type: str = "energy",
    magnitude: str = "Category 5",
    route_path_nodes: int = 0,
    limit: int = 3,
) -> list[dict[str, Any]]:
    """Pre-calculates viable ONLINE supplier candidates for a failing node."""
    if missing_dependency_type:
        required_type = _normalize_sector_type(missing_dependency_type)
    elif parent_name in graph:
        required_type = _normalize_sector_type(graph.nodes[parent_name].get("type", "energy"))
    else:
        required_type = "energy"

    scored_candidates: list[tuple[float, str, dict[str, Any]]] = []
    for node_id, data in graph.nodes(data=True):
        cand_name = str(node_id)
        if cand_name in failed_nodes or cand_name == child_name:
            continue

        cand_type = _normalize_sector_type(data.get("type", "energy"))
        if cand_type != required_type:
            continue

        cand_tier = str(data.get("tier", "Primary"))
        dist_m = _estimate_osm_street_distance_m(graph, undirected_graph, cand_name, child_name)
        est_cost, rec_min, rec_display = compute_realistic_recovery_metrics(
            distance_m=dist_m,
            node_type=node_type,
            missing_dependency_type=required_type,
            magnitude=magnitude,
            route_path_nodes=route_path_nodes,
            candidate_tier=cand_tier,
        )
        crews_req = compute_required_crews(
            distance_m=dist_m,
            node_type=node_type,
            missing_dependency_type=required_type,
            magnitude=magnitude,
        )
        restoration_hours = round(rec_min / 60.0, 2)
        scored_candidates.append(
            (
                dist_m,
                cand_name,
                {
                    "id": cand_name,
                    "name": cand_name,
                    "type": cand_type,
                    "tier": cand_tier,
                    "distance_m": dist_m,
                    "cost": est_cost,
                    "estimated_cost": est_cost,
                    "crews_used": crews_req,
                    "required_crew_time_min": rec_min,
                    "recovery_time_ms": rec_min,
                    "field_restoration_hours": restoration_hours,
                    "recovery_time_display": rec_display,
                },
            )
        )

    scored_candidates.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in scored_candidates[:limit]]


def _has_severed_critical_lifeline(
    graph: nx.DiGraph,
    node_name: str,
    failed_parent: str,
    failed_nodes: set[str],
) -> tuple[bool, str]:
    """Determines whether `node_name` lost a required lifeline when `failed_parent` went OFFLINE."""
    node_type = _normalize_sector_type(graph.nodes[node_name].get("type", "energy"))
    parent_type = (
        _normalize_sector_type(graph.nodes[failed_parent].get("type", "energy"))
        if failed_parent in graph
        else "energy"
    )
    required_lifelines = set(MANDATORY_INCOMING_LIFELINES.get(node_type, ("energy",)))

    if parent_type in required_lifelines:
        return True, parent_type

    for req_type in required_lifelines:
        typed_preds = [
            pred
            for pred in graph.predecessors(node_name)
            if _normalize_sector_type(graph.nodes[pred].get("type", "energy")) == req_type
        ]
        if typed_preds and all(pred in failed_nodes for pred in typed_preds):
            return True, req_type

    return False, parent_type


def _compute_knapsack_capacity_value(graph: nx.DiGraph, node_name: str, node_type: str) -> int:
    """Computes effective infrastructure capacity weight for Knapsack optimization."""
    data = graph.nodes.get(node_name, {})
    base_cap = int(data.get("capacity", 3))
    tier = str(data.get("tier", "Secondary"))
    downstream_count = min(4, int(graph.out_degree(node_name)))
    if node_type == "health":
        sector_bonus = 18 if tier == "Primary" else 14
    elif tier == "Primary":
        sector_bonus = 6
    else:
        sector_bonus = 2
    return max(1, base_cap + sector_bonus + downstream_count)


async def execute_simulation_cascade(
    sim_payload: dict[str, Any],
    db_session: AsyncSession | None = None,
) -> list[dict[str, Any]]:
    """
    Core Discrete Event Simulation (DES) + Climate Justice + 2D Knapsack engine.
    Can be invoked inside a Celery background worker or with an existing `AsyncSession`.
    """
    owns_session = db_session is None
    session = AsyncSessionLocal() if owns_session else db_session
    assert session is not None

    try:
        graph: nx.DiGraph = await _load_graph_from_db(session)
        disaster_type: str = str(sim_payload.get("disaster_type") or "Hurricane")
        magnitude: str = str(sim_payload.get("magnitude") or "Category 5")
        disaster_direction: str = str(
            sim_payload.get("disaster_direction") or sim_payload.get("trajectory") or "Coastal"
        ).strip()
        trajectory: str = str(
            sim_payload.get("trajectory") or sim_payload.get("disaster_direction") or "Coastal"
        ).strip()

        initial_crews: int = max(0, int(sim_payload.get("active_repair_crews", 3)))
        remaining_budget: float = max(0.0, float(sim_payload.get("emergency_budget", 5000000.0)))
        remaining_crews: int = initial_crews

        supplier_nodes_list: list[dict[str, Any]] = [
            {
                "id": str(node),
                "name": str(node),
                "type": _normalize_sector_type(data.get("type", "unknown")),
                "x": round(float(data.get("x", 0.0)), 5),
                "y": round(float(data.get("y", 0.0)), 5),
            }
            for node, data in graph.nodes(data=True)
            if _normalize_sector_type(data.get("type", "unknown")) == "energy" and graph.out_degree(node) > 0
        ]
        if not supplier_nodes_list:
            supplier_nodes_list = [
                {
                    "id": str(node),
                    "name": str(node),
                    "type": _normalize_sector_type(data.get("type", "unknown")),
                    "x": round(float(data.get("x", 0.0)), 5),
                    "y": round(float(data.get("y", 0.0)), 5),
                }
                for node, data in graph.nodes(data=True)
                if graph.out_degree(node) > 0
            ]
        nodes_list: list[dict[str, Any]] = supplier_nodes_list or [
            {
                "id": str(node),
                "name": str(node),
                "type": _normalize_sector_type(data.get("type", "unknown")),
                "x": round(float(data.get("x", 0.0)), 5),
                "y": round(float(data.get("y", 0.0)), 5),
            }
            for node, data in graph.nodes(data=True)
        ]

        epicenter_eval = await determine_epicenter(
            disaster_type=disaster_type,
            magnitude=magnitude,
            trajectory=trajectory,
            available_nodes=nodes_list,
        )

        chosen_id: str = epicenter_eval["epicenter_id"]
        llm_reasoning: str = epicenter_eval["reasoning"]

        if chosen_id not in graph:
            chosen_id = next(iter(graph.nodes))

        undirected_graph = graph.to_undirected()

        T: float = 0.0
        node_states: dict[str, str] = {str(n): "ONLINE" for n in graph.nodes}
        node_states[chosen_id] = "OFFLINE"
        offline_nodes: set[str] = {chosen_id}
        evaluated_lifelines: set[tuple[str, str]] = set()

        event_heap: list[tuple[float, int, int, Event, dict[str, Any]]] = []
        event_seq: int = 0

        def _push_des_event(ev_time: float, ev_type: str, target_node_id: str, meta: dict[str, Any]) -> None:
            nonlocal event_seq
            event_seq += 1
            prio = 0 if ev_type == "RECOVERY_COMPLETED" else 1
            ev_obj = Event(
                event_time=round(max(0.0, float(ev_time)), 2),
                event_type=ev_type,
                node_id=target_node_id,
            )
            heapq.heappush(event_heap, (ev_obj.event_time, prio, event_seq, ev_obj, meta))

        def _get_next_crew_slot(current_T: float) -> tuple[float | None, dict[str, Any] | None, int]:
            """
            Task 2: Finds the closest `event_time` in `event_heap` for a `RECOVERY_COMPLETED`
            event that still has unreserved crew capacity (`crews_used - reserved_crews > 0`).
            Returns `(next_crew_available_at, event_meta, available_crews_from_event)`.
            """
            for ev_time, _prio, _seq, ev_obj, ev_meta in sorted(event_heap, key=lambda x: (x[0], x[1], x[2])):
                if ev_obj.event_type != "RECOVERY_COMPLETED":
                    continue
                if node_states.get(ev_obj.node_id) != "CRITICAL_BATTERY":
                    continue
                crews_total = int(ev_meta.get("crews_used", 1))
                crews_reserved = int(ev_meta.get("reserved_crews", 0))
                avail = crews_total - crews_reserved
                if avail > 0 and float(ev_time) >= current_T:
                    return round(float(ev_time), 2), ev_meta, avail
            return None, None, 0

        epicenter_type = _normalize_sector_type(graph.nodes[chosen_id].get("type", "unknown"))
        epicenter_svi = round(
            float(
                graph.nodes[chosen_id].get(
                    "svi_score",
                    graph.nodes[chosen_id].get("social_vulnerability_index", 0.5),
                )
            ),
            2,
        )
        epicenter_pop = int(graph.nodes[chosen_id].get("population_served", 25000))
        execution_trace: list[dict[str, Any]] = [
            {
                "step": "impact",
                "event_time": 0.0,
                "event_type": "EPICENTER_IMPACT",
                "node_state": "OFFLINE",
                "battery_backup_hours": 0.0,
                "battery_deadline": 0.0,
                "bfs_depth": 0,
                "node": chosen_id,
                "parent_node": None,
                "child_node": chosen_id,
                "node_name": chosen_id,
                "node_type": epicenter_type,
                "svi_score": epicenter_svi,
                "population_served": epicenter_pop,
                "magnitude": magnitude,
                "status": False,
                "reasoning": llm_reasoning,
                "recovery_command": None,
                "estimated_cost": None,
                "crews_used": None,
                "recovery_time_ms": None,
                "remaining_budget": round(remaining_budget, 2),
                "remaining_crews": remaining_crews,
                "agent_debate_log": [],
                "new_edge": None,
            }
        ]

        battery_depletion_meta: dict[str, dict[str, Any]] = {}
        evaluated_nodes: set[str] = {chosen_id}

        async def _trigger_critical_battery_wave(
            newly_offline_parents: list[tuple[str, int]],
            current_T: float,
        ) -> None:
            nonlocal remaining_budget, remaining_crews

            raw_entering_critical: list[dict[str, Any]] = []
            seen_in_wave: set[str] = set()

            for parent_name, wave_depth in newly_offline_parents:
                for child_name in graph.successors(parent_name):
                    if (
                        child_name == chosen_id
                        or child_name in evaluated_nodes
                        or node_states.get(child_name) != "ONLINE"
                        or child_name in seen_in_wave
                    ):
                        continue

                    is_severed, missing_dependency_type = _has_severed_critical_lifeline(
                        graph=graph,
                        node_name=child_name,
                        failed_parent=parent_name,
                        failed_nodes=offline_nodes,
                    )
                    if not is_severed:
                        continue

                    lifeline_key = (child_name, missing_dependency_type)
                    if lifeline_key in evaluated_lifelines:
                        continue
                    evaluated_lifelines.add(lifeline_key)
                    evaluated_nodes.add(child_name)
                    seen_in_wave.add(child_name)

                    node_states[child_name] = "CRITICAL_BATTERY"

                    raw_backup_h = float(graph.nodes[child_name].get("battery_backup_hours", 2.5))
                    if raw_backup_h > 8.0:
                        _, _, raw_backup_h = _infer_node_hierarchy(
                            child_name,
                            str(graph.nodes[child_name].get("type", "energy")),
                        )
                    battery_hours = round(max(0.5, raw_backup_h), 2)
                    battery_deadline = round(current_T + battery_hours, 2)

                    child_type = _normalize_sector_type(graph.nodes[child_name].get("type", "unknown"))
                    child_tier = str(graph.nodes[child_name].get("tier", "Secondary"))
                    child_capacity = _compute_knapsack_capacity_value(graph, child_name, child_type)
                    child_svi = round(
                        float(
                            graph.nodes[child_name].get(
                                "svi_score",
                                graph.nodes[child_name].get("social_vulnerability_index", 0.5),
                            )
                        ),
                        2,
                    )
                    child_pop = int(graph.nodes[child_name].get("population_served", 25000))
                    edge_data = (
                        graph.get_edge_data(parent_name, child_name)
                        or graph.get_edge_data(child_name, parent_name)
                        or {}
                    )
                    raw_distance = edge_data.get("routing_distance")
                    route_distance = (
                        round(float(raw_distance), 2)
                        if raw_distance is not None
                        else _estimate_osm_street_distance_m(graph, undirected_graph, parent_name, child_name)
                    )
                    raw_path_nodes = edge_data.get("path_nodes")
                    route_path_nodes = len(raw_path_nodes) if isinstance(raw_path_nodes, list) else 0

                    depletion_meta = {
                        "node_id": child_name,
                        "node_type": child_type,
                        "svi_score": child_svi,
                        "population_served": child_pop,
                        "parent_node": parent_name,
                        "missing_dependency_type": missing_dependency_type,
                        "bfs_depth": wave_depth,
                        "battery_backup_hours": battery_hours,
                        "battery_deadline": battery_deadline,
                        "abandon_reasoning": "",
                        "agent_debate_log": [],
                    }
                    battery_depletion_meta[child_name] = depletion_meta
                    _push_des_event(
                        ev_time=battery_deadline,
                        ev_type="BATTERY_DEPLETED",
                        target_node_id=child_name,
                        meta=depletion_meta,
                    )

                    raw_entering_critical.append(
                        {
                            "node_id": child_name,
                            "node_name": child_name,
                            "node_type": child_type,
                            "tier": child_tier,
                            "capacity": child_capacity,
                            "svi_score": child_svi,
                            "social_vulnerability_index": child_svi,
                            "population_served": child_pop,
                            "parent_node": parent_name,
                            "missing_dependency_type": missing_dependency_type,
                            "route_distance": route_distance,
                            "route_path_nodes": route_path_nodes,
                            "magnitude": magnitude,
                            "disaster_type": disaster_type,
                            "disaster_direction": disaster_direction,
                            "bfs_depth": wave_depth,
                            "current_time_T": round(current_T, 2),
                            "battery_backup_hours": battery_hours,
                            "battery_deadline": battery_deadline,
                        }
                    )

            if not raw_entering_critical:
                return

            unavailable_suppliers = {n for n, st in node_states.items() if st != "ONLINE"}
            failing_nodes_batch: list[dict[str, Any]] = []
            for item in raw_entering_critical:
                candidate_nodes = _get_viable_candidates(
                    graph=graph,
                    undirected_graph=undirected_graph,
                    child_name=item["node_id"],
                    parent_name=item["parent_node"],
                    failed_nodes=unavailable_suppliers,
                    missing_dependency_type=item["missing_dependency_type"],
                    node_type=item["node_type"],
                    magnitude=magnitude,
                    route_path_nodes=item["route_path_nodes"],
                    limit=3,
                )
                batch_entry = dict(item)
                batch_entry["candidate_nodes"] = candidate_nodes
                failing_nodes_batch.append(batch_entry)

            had_immediate_crews_at_wave_start = remaining_crews > 0
            initial_next_crew_at, _, _ = _get_next_crew_slot(current_T)
            rep_deadline = failing_nodes_batch[0]["battery_deadline"]
            batch_decisions = await evaluate_batch_failures(
                failing_nodes_batch=failing_nodes_batch,
                remaining_budget=remaining_budget,
                remaining_crews=remaining_crews,
                current_time_T=current_T,
                battery_deadline=rep_deadline,
                next_crew_available_at=initial_next_crew_at if remaining_crews == 0 else None,
            )

            decisions_by_node: dict[str, dict[str, Any]] = {
                str(d.get("node_id")): d for d in batch_decisions if isinstance(d, dict) and d.get("node_id")
            }

            # Order batch so nodes selected for immediate save claim available immediate crews first,
            # followed by remaining nodes which can be evaluated via Look-Ahead Crew Scheduling once remaining_crews == 0
            ordered_batch = sorted(
                failing_nodes_batch,
                key=lambda x: (
                    0 if bool(decisions_by_node.get(x["node_id"], {}).get("status", False)) else 1,
                    0 if float(x.get("svi_score", 0.5)) > 0.75 else 1,
                    -int(x.get("population_served", 0)),
                ),
            )

            for item in ordered_batch:
                child_name = item["node_id"]
                child_type = item["node_type"]
                child_svi = float(item["svi_score"])
                child_pop = int(item["population_served"])
                parent_name = item["parent_node"]
                missing_dependency_type = item["missing_dependency_type"]
                route_path_nodes = item["route_path_nodes"]
                candidate_nodes = item["candidate_nodes"]
                wave_depth = item["bfs_depth"]
                battery_hours = item["battery_backup_hours"]
                battery_deadline = item["battery_deadline"]

                decision = decisions_by_node.get(child_name, {})
                want_save = bool(decision.get("status", False))

                # Task 2: If immediate crews are 0 and a crew will be freed at `slot_time`,
                # evaluate this node under Look-Ahead Crew Scheduling against the current unreserved slot
                slot_time, slot_meta, slot_avail = _get_next_crew_slot(current_T)
                if remaining_crews == 0 and candidate_nodes:
                    if slot_time is not None and (
                        had_immediate_crews_at_wave_start
                        or not want_save
                        or slot_time != initial_next_crew_at
                    ):
                        lookahead_decisions = await evaluate_batch_failures(
                            failing_nodes_batch=[item],
                            remaining_budget=remaining_budget,
                            remaining_crews=0,
                            current_time_T=current_T,
                            battery_deadline=battery_deadline,
                            next_crew_available_at=slot_time,
                        )
                        if lookahead_decisions and isinstance(lookahead_decisions[0], dict):
                            decision = lookahead_decisions[0]
                            decisions_by_node[child_name] = decision
                            want_save = bool(decision.get("status", False))
                    elif slot_time is None and want_save:
                        prev_debate = decision.get("agent_debate_log") if isinstance(decision.get("agent_debate_log"), list) else []
                        exhausted_summary = (
                            f"Upheld Finance crew cap on {child_name}: all repair crews and release slots "
                            f"reserved for higher-SVI facilities."
                        )
                        updated_debate = [e for e in prev_debate if isinstance(e, dict) and e.get("agent") != "Supervisor_Agent"]
                        updated_debate.append(
                            {
                                "agent": "Supervisor_Agent",
                                "role": "Crisis Committee Chair (Binding Decision)",
                                "node_id": child_name,
                                "status": False,
                                "cost": 0,
                                "new_edge": None,
                                "proposal": exhausted_summary,
                                "negotiation_summary": exhausted_summary,
                            }
                        )
                        want_save = False
                        decision = {
                            "node_id": child_name,
                            "status": False,
                            "reasoning": (
                                f'[Committee Verdict: "{exhausted_summary}"] '
                                f"Abandoned (Resource Exhausted at T+{current_T:.2f}h): 0 immediate repair crews "
                                f"available and all upcoming crew release slots are already reserved for "
                                f"higher-priority facilities."
                            ),
                            "negotiation_summary": exhausted_summary,
                            "agent_debate_log": updated_debate,
                            "recovery_command": None,
                            "new_edge": None,
                        }
                        decisions_by_node[child_name] = decision

                reasoning = str(
                    decision.get("reasoning")
                    or f"Node {child_name} ({child_type}, SVI {child_svi:.2f}, pop {child_pop:,}) entered CRITICAL_BATTERY at T+{current_T:.2f}h."
                )
                recovery_command: str | None = decision.get("recovery_command")
                raw_new_edge = decision.get("new_edge")
                agent_debate_log: list[dict[str, Any]] = (
                    list(decision.get("agent_debate_log"))
                    if isinstance(decision.get("agent_debate_log"), list)
                    else []
                )

                scheduled_recovery = False
                scheduled_eta_T: float | None = None

                if want_save and isinstance(raw_new_edge, dict) and candidate_nodes:
                    raw_source = raw_new_edge.get("source")
                    target_node = str(raw_new_edge.get("target") or child_name)
                    resolved_source: str | None = None

                    if isinstance(raw_source, str):
                        if raw_source in graph:
                            resolved_source = raw_source
                        else:
                            norm_raw = "".join(ch for ch in raw_source.lower() if ch.isalnum())
                            for candidate in graph.nodes:
                                norm_cand = "".join(ch for ch in str(candidate).lower() if ch.isalnum())
                                if norm_raw and (
                                    norm_cand == norm_raw
                                    or norm_raw in norm_cand
                                    or norm_cand in norm_raw
                                ):
                                    resolved_source = str(candidate)
                                    break

                    if (
                        resolved_source is None
                        or resolved_source not in graph
                        or resolved_source in unavailable_suppliers
                        or resolved_source == target_node
                        or _normalize_sector_type(graph.nodes[resolved_source].get("type")) != missing_dependency_type
                    ):
                        resolved_source = str(candidate_nodes[0]["id"])

                    if (
                        resolved_source is not None
                        and resolved_source in graph
                        and resolved_source not in unavailable_suppliers
                        and resolved_source != target_node
                        and _normalize_sector_type(graph.nodes[resolved_source].get("type")) == missing_dependency_type
                    ):
                        chosen_dist_m = _estimate_osm_street_distance_m(
                            graph, undirected_graph, resolved_source, target_node
                        )
                        chosen_tier = str(graph.nodes[resolved_source].get("tier", "Primary"))
                        default_cost, default_minutes, _ = compute_realistic_recovery_metrics(
                            distance_m=chosen_dist_m,
                            node_type=child_type,
                            missing_dependency_type=missing_dependency_type,
                            magnitude=magnitude,
                            route_path_nodes=route_path_nodes,
                            candidate_tier=chosen_tier,
                        )
                        default_crews = compute_required_crews(
                            distance_m=chosen_dist_m,
                            node_type=child_type,
                            missing_dependency_type=missing_dependency_type,
                            magnitude=magnitude,
                        )

                        try:
                            raw_cost = int(
                                float(
                                    raw_new_edge.get(
                                        "cost",
                                        raw_new_edge.get("estimated_cost", default_cost),
                                    )
                                )
                            )
                            est_cost = max(
                                int(round(default_cost * 0.75, -2)),
                                min(int(round(default_cost * 1.25, -2)), raw_cost),
                            )
                        except (TypeError, ValueError):
                            est_cost = default_cost

                        try:
                            raw_crews = int(float(raw_new_edge.get("crews_used", default_crews)))
                            crews_used = max(1, min(3, raw_crews))
                        except (TypeError, ValueError):
                            crews_used = default_crews

                        try:
                            raw_time = int(float(raw_new_edge.get("recovery_time_ms", default_minutes)))
                            rec_time = max(
                                max(10, int(round(default_minutes * 0.75))),
                                min(int(round(default_minutes * 1.25)), raw_time),
                            )
                        except (TypeError, ValueError):
                            rec_time = default_minutes

                        field_restoration_hours = round(rec_time / 60.0, 2)
                        remaining_window_h = round(max(0.0, battery_deadline - current_T), 2)

                        # Case A: Immediate crew dispatch (remaining_crews >= crews_used)
                        if (
                            remaining_crews >= crews_used
                            and field_restoration_hours < remaining_window_h
                            and est_cost <= remaining_budget
                        ):
                            remaining_budget = max(0.0, round(remaining_budget - float(est_cost), 2))
                            remaining_crews = max(0, remaining_crews - crews_used)
                            rec_display = format_recovery_duration(rec_time)
                            recovery_completion_T = round(current_T + field_restoration_hours, 2)
                            scheduled_recovery = True
                            scheduled_eta_T = recovery_completion_T

                            validated_new_edge = {
                                "source": resolved_source,
                                "target": target_node,
                                "cost": est_cost,
                                "crews_used": crews_used,
                                "estimated_cost": est_cost,
                                "recovery_time_ms": rec_time,
                                "field_restoration_hours": field_restoration_hours,
                                "recovery_time_display": rec_display,
                            }
                            if not recovery_command:
                                recovery_command = (
                                    f"DISPATCH {crews_used} CREW(S) AT T+{current_T:.2f}h: REROUTE "
                                    f"{resolved_source} -> {target_node} "
                                    f"[ETA T+{recovery_completion_T:.2f}h < DEADLINE T+{battery_deadline:.2f}h | SVI={child_svi:.2f} | COST=${est_cost:,}]"
                                )

                            _push_des_event(
                                ev_time=recovery_completion_T,
                                ev_type="RECOVERY_COMPLETED",
                                target_node_id=child_name,
                                meta={
                                    "node_id": child_name,
                                    "node_type": child_type,
                                    "svi_score": child_svi,
                                    "population_served": child_pop,
                                    "parent_node": parent_name,
                                    "missing_dependency_type": missing_dependency_type,
                                    "chosen_dist_m": chosen_dist_m,
                                    "bfs_depth": wave_depth,
                                    "battery_backup_hours": battery_hours,
                                    "battery_deadline": battery_deadline,
                                    "new_edge": validated_new_edge,
                                    "cost": est_cost,
                                    "crews_used": crews_used,
                                    "recovery_time_ms": rec_time,
                                    "reasoning": reasoning,
                                    "recovery_command": recovery_command,
                                    "agent_debate_log": agent_debate_log,
                                    "reserved_crews": 0,
                                    "handoff_crews": 0,
                                },
                            )

                        # Case B: Look-Ahead Crew Scheduling when remaining_crews == 0
                        elif remaining_crews == 0 and est_cost <= remaining_budget:
                            slot_time, slot_meta, slot_avail = _get_next_crew_slot(current_T)
                            if (
                                slot_time is not None
                                and slot_meta is not None
                                and round(slot_time + field_restoration_hours, 2) < battery_deadline
                            ):
                                queued_crews = min(crews_used, max(1, slot_avail))
                                remaining_budget = max(0.0, round(remaining_budget - float(est_cost), 2))
                                slot_meta["reserved_crews"] = int(slot_meta.get("reserved_crews", 0)) + queued_crews
                                slot_meta["handoff_crews"] = int(slot_meta.get("handoff_crews", 0)) + queued_crews
                                rec_display = format_recovery_duration(rec_time)
                                recovery_completion_T = round(slot_time + field_restoration_hours, 2)
                                scheduled_recovery = True
                                scheduled_eta_T = recovery_completion_T

                                if "queued pending crew arrival" not in reasoning.lower():
                                    reasoning = (
                                        f"Repair is queued pending crew arrival at T+{slot_time:.2f}h "
                                        f"(completes at T+{recovery_completion_T:.2f}h < deadline T+{battery_deadline:.2f}h). "
                                        f"{reasoning}"
                                    )

                                validated_new_edge = {
                                    "source": resolved_source,
                                    "target": target_node,
                                    "cost": est_cost,
                                    "crews_used": queued_crews,
                                    "estimated_cost": est_cost,
                                    "recovery_time_ms": rec_time,
                                    "field_restoration_hours": field_restoration_hours,
                                    "recovery_time_display": rec_display,
                                    "queued_for_crew_at": slot_time,
                                }
                                recovery_command = (
                                    f"QUEUE {queued_crews} CREW(S) FOR T+{slot_time:.2f}h: REROUTE "
                                    f"{resolved_source} -> {target_node} "
                                    f"[ETA T+{recovery_completion_T:.2f}h < DEADLINE T+{battery_deadline:.2f}h | SVI={child_svi:.2f} | COST=${est_cost:,}]"
                                )

                                _push_des_event(
                                    ev_time=recovery_completion_T,
                                    ev_type="RECOVERY_COMPLETED",
                                    target_node_id=child_name,
                                    meta={
                                        "node_id": child_name,
                                        "node_type": child_type,
                                        "svi_score": child_svi,
                                        "population_served": child_pop,
                                        "parent_node": parent_name,
                                        "missing_dependency_type": missing_dependency_type,
                                        "chosen_dist_m": chosen_dist_m,
                                        "bfs_depth": wave_depth,
                                        "battery_backup_hours": battery_hours,
                                        "battery_deadline": battery_deadline,
                                        "new_edge": validated_new_edge,
                                        "cost": est_cost,
                                        "crews_used": queued_crews,
                                        "recovery_time_ms": rec_time,
                                        "reasoning": reasoning,
                                        "recovery_command": recovery_command,
                                        "agent_debate_log": agent_debate_log,
                                        "reserved_crews": 0,
                                        "handoff_crews": 0,
                                    },
                                )

                if child_name in battery_depletion_meta:
                    battery_depletion_meta[child_name]["agent_debate_log"] = agent_debate_log
                    if not scheduled_recovery:
                        battery_depletion_meta[child_name]["abandon_reasoning"] = reasoning

                crit_desc = (
                    f"CRITICAL_BATTERY at T+{current_T:.2f}h: Lost {missing_dependency_type} lifeline from {parent_name} "
                    f"(SVI {child_svi:.2f}, serving {child_pop:,} residents). "
                    f"Backup battery ({battery_hours:.1f}h) active until T+{battery_deadline:.2f}h. "
                    + (
                        f"AI scheduled recovery via {raw_new_edge.get('source') if isinstance(raw_new_edge, dict) else 'candidate'} "
                        f"(ETA T+{scheduled_eta_T:.2f}h) — {reasoning}"
                        if scheduled_recovery and scheduled_eta_T is not None
                        else f"No recovery scheduled before deadline — {reasoning}"
                    )
                )
                execution_trace.append(
                    {
                        "step": "critical_battery",
                        "event_time": round(current_T, 2),
                        "event_type": "CRITICAL_BATTERY",
                        "node_state": "CRITICAL_BATTERY",
                        "battery_backup_hours": battery_hours,
                        "battery_deadline": battery_deadline,
                        "bfs_depth": wave_depth,
                        "node": child_name,
                        "parent_node": parent_name,
                        "child_node": child_name,
                        "node_name": child_name,
                        "node_type": child_type,
                        "svi_score": child_svi,
                        "population_served": child_pop,
                        "magnitude": magnitude,
                        "status": True,
                        "reasoning": crit_desc,
                        "recovery_command": recovery_command if scheduled_recovery else None,
                        "estimated_cost": None,
                        "crews_used": None,
                        "recovery_time_ms": None,
                        "remaining_budget": round(remaining_budget, 2),
                        "remaining_crews": remaining_crews,
                        "agent_debate_log": agent_debate_log,
                        "new_edge": None,
                    }
                )

        await _trigger_critical_battery_wave([(chosen_id, 1)], T)

        while event_heap:
            ev_time, _prio, _seq, ev, meta = heapq.heappop(event_heap)
            T = round(float(ev.event_time), 2)

            if ev.event_type == "RECOVERY_COMPLETED":
                target_id = ev.node_id
                if node_states.get(target_id) != "CRITICAL_BATTERY":
                    continue

                node_states[target_id] = "ONLINE"
                new_edge_obj = meta["new_edge"]
                graph.add_edge(
                    new_edge_obj["source"],
                    new_edge_obj["target"],
                    dependency_type=meta["missing_dependency_type"],
                    routing_distance=meta["chosen_dist_m"],
                )

                # Task 1 & Task 3: Dynamic Resource Release — return crews_used back to active_repair_crews pool
                crews_released = max(1, int(meta.get("crews_used", 1)))
                remaining_crews = min(initial_crews, remaining_crews + crews_released)
                crew_release_notice = (
                    f"Crew released. Remaining Budget: ${remaining_budget:,.0f} | Crews Left: {remaining_crews}"
                )

                execution_trace.append(
                    {
                        "step": "cascade",
                        "event_time": T,
                        "event_type": "RECOVERY_COMPLETED",
                        "node_state": "ONLINE",
                        "battery_backup_hours": meta["battery_backup_hours"],
                        "battery_deadline": meta["battery_deadline"],
                        "bfs_depth": meta["bfs_depth"],
                        "node": target_id,
                        "parent_node": meta["parent_node"],
                        "child_node": target_id,
                        "node_name": target_id,
                        "node_type": meta["node_type"],
                        "svi_score": meta["svi_score"],
                        "population_served": meta["population_served"],
                        "magnitude": magnitude,
                        "status": True,
                        "reasoning": (
                            f"RECOVERY_COMPLETED at T+{T:.2f}h (beat battery deadline T+{meta['battery_deadline']:.2f}h): "
                            f"{meta['reasoning']} {crew_release_notice}"
                        ),
                        "crew_release_notice": crew_release_notice,
                        "recovery_command": meta["recovery_command"],
                        "estimated_cost": meta["cost"],
                        "crews_used": meta["crews_used"],
                        "recovery_time_ms": meta["recovery_time_ms"],
                        "remaining_budget": round(remaining_budget, 2),
                        "remaining_crews": remaining_crews,
                        "agent_debate_log": meta.get("agent_debate_log", []),
                        "new_edge": new_edge_obj,
                    }
                )

                # If a look-ahead queued repair was waiting for this freed crew at T, hand off the crew now
                handoff_crews = int(meta.get("handoff_crews", 0))
                if handoff_crews > 0:
                    remaining_crews = max(0, remaining_crews - handoff_crews)

            elif ev.event_type == "BATTERY_DEPLETED":
                simultaneous_depletions: list[tuple[Event, dict[str, Any]]] = [(ev, meta)]
                while (
                    event_heap
                    and round(float(event_heap[0][0]), 2) == T
                    and event_heap[0][3].event_type == "BATTERY_DEPLETED"
                ):
                    _, _, _, next_ev, next_meta = heapq.heappop(event_heap)
                    simultaneous_depletions.append((next_ev, next_meta))

                newly_offline_at_T: list[tuple[str, int]] = []
                for dep_ev, dep_meta in simultaneous_depletions:
                    target_id = dep_ev.node_id
                    if node_states.get(target_id) != "CRITICAL_BATTERY":
                        continue

                    node_states[target_id] = "OFFLINE"
                    offline_nodes.add(target_id)
                    newly_offline_at_T.append((target_id, int(dep_meta["bfs_depth"]) + 1))

                    abandon_reason = str(dep_meta.get("abandon_reasoning") or "").strip()
                    execution_trace.append(
                        {
                            "step": "cascade",
                            "event_time": T,
                            "event_type": "BATTERY_DEPLETED",
                            "node_state": "OFFLINE",
                            "battery_backup_hours": dep_meta["battery_backup_hours"],
                            "battery_deadline": dep_meta["battery_deadline"],
                            "bfs_depth": dep_meta["bfs_depth"],
                            "node": target_id,
                            "parent_node": dep_meta["parent_node"],
                            "child_node": target_id,
                            "node_name": target_id,
                            "node_type": dep_meta["node_type"],
                            "svi_score": dep_meta["svi_score"],
                            "population_served": dep_meta["population_served"],
                            "magnitude": magnitude,
                            "status": False,
                            "reasoning": (
                                f"BATTERY_DEPLETED at T+{T:.2f}h: {dep_meta['battery_backup_hours']:.1f}h backup battery "
                                f"exhausted — node transitioned to OFFLINE and cascades failure downstream. "
                                f"{abandon_reason}"
                            ).strip(),
                            "recovery_command": None,
                            "estimated_cost": None,
                            "crews_used": None,
                            "recovery_time_ms": None,
                            "remaining_budget": round(remaining_budget, 2),
                            "remaining_crews": remaining_crews,
                            "agent_debate_log": dep_meta.get("agent_debate_log", []),
                            "new_edge": None,
                        }
                    )

                if newly_offline_at_T:
                    await _trigger_critical_battery_wave(newly_offline_at_T, T)

        try:
            trace_record = SimulationTrace(
                disaster_type=disaster_type,
                magnitude=magnitude,
                epicenter_node=chosen_id,
                trace_data=json.loads(json.dumps(execution_trace)),
            )
            session.add(trace_record)
            await session.commit()
        except Exception as exc:
            await session.rollback()
            print(f"[WARNING] Failed to persist SimulationTrace to PostgreSQL: {exc}")

        return execution_trace
    finally:
        if owns_session:
            await session.close()


async def _run_and_dispose(sim_payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Runs `execute_simulation_cascade` inside a worker event loop and disposes pooled connections."""
    try:
        return await execute_simulation_cascade(sim_payload)
    finally:
        await engine.dispose()


@celery_app.task(bind=True, name="worker.simulate_cascade_task")
def simulate_cascade_task(self: Any, sim_payload: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Celery background task that executes the WeatherFall Discrete Event Simulation (DES)
    and LLM Knapsack / Climate Justice optimization off the main FastAPI event loop.
    """
    return asyncio.run(_run_and_dispose(sim_payload))


async def _run_local_fallback_task(task_id: str, sim_payload: dict[str, Any]) -> None:
    """Fallback background coroutine if Redis/Celery worker is unreachable in local dev."""
    LOCAL_TASK_STORE[task_id] = {
        "task_id": task_id,
        "status": "processing",
        "state": "STARTED",
        "result": None,
        "error": None,
    }
    try:
        trace = await execute_simulation_cascade(sim_payload)
        LOCAL_TASK_STORE[task_id] = {
            "task_id": task_id,
            "status": "completed",
            "state": "SUCCESS",
            "result": trace,
            "error": None,
        }
    except Exception as exc:
        LOCAL_TASK_STORE[task_id] = {
            "task_id": task_id,
            "status": "failed",
            "state": "FAILURE",
            "result": None,
            "error": str(exc),
        }


def _has_active_celery_broker() -> bool:
    """Checks whether the Redis broker is reachable for Celery task dispatch."""
    try:
        import redis

        client = redis.Redis.from_url(CELERY_BROKER_URL, socket_connect_timeout=0.6, socket_timeout=0.6)
        return bool(client.ping())
    except Exception:
        return False


async def dispatch_simulation_task(sim_payload: dict[str, Any]) -> dict[str, str]:
    """
    Dispatches the simulation to Celery via Redis (`simulate_cascade_task.delay`),
    or falls back to an async background task if Redis is unreachable.
    """
    if _has_active_celery_broker():
        try:
            async_result = simulate_cascade_task.delay(sim_payload)
            task_id = str(async_result.id)
            LOCAL_TASK_STORE[task_id] = {
                "task_id": task_id,
                "status": "processing",
                "state": "PENDING",
                "result": None,
                "error": None,
                "payload": sim_payload,
                "pending_polls": 0,
            }
            return {"task_id": task_id, "status": "processing"}
        except Exception as exc:
            print(f"[WARNING] Celery dispatch failed, using async fallback worker: {exc}")

    fallback_id = str(uuid.uuid4())
    LOCAL_TASK_STORE[fallback_id] = {
        "task_id": fallback_id,
        "status": "processing",
        "state": "PENDING",
        "result": None,
        "error": None,
    }
    asyncio.create_task(_run_local_fallback_task(fallback_id, sim_payload))
    return {"task_id": fallback_id, "status": "processing"}


async def get_simulation_task_status(task_id: str) -> dict[str, Any]:
    """
    Retrieves the current status and final execution trace for `task_id` from
    Celery's Redis result backend (or the local fallback task store).
    """
    local_entry = LOCAL_TASK_STORE.get(task_id)

    if _has_active_celery_broker():
        try:
            res = AsyncResult(task_id, app=celery_app)
            state = str(res.state or "PENDING").upper()

            if state == "SUCCESS":
                trace_data = res.result
                LOCAL_TASK_STORE.pop(task_id, None)
                return {
                    "task_id": task_id,
                    "status": "completed",
                    "state": "SUCCESS",
                    "result": trace_data,
                    "execution_trace": trace_data,
                    "error": None,
                }

            if state == "FAILURE":
                err_msg = str(res.result or "Simulation task failed in Celery worker.")
                LOCAL_TASK_STORE.pop(task_id, None)
                return {
                    "task_id": task_id,
                    "status": "failed",
                    "state": "FAILURE",
                    "result": None,
                    "execution_trace": None,
                    "error": err_msg,
                }

            if local_entry and local_entry.get("status") in ("completed", "failed"):
                return {
                    "task_id": task_id,
                    "status": local_entry["status"],
                    "state": local_entry["state"],
                    "result": local_entry.get("result"),
                    "execution_trace": local_entry.get("result"),
                    "error": local_entry.get("error"),
                }

            # If task remains stuck in PENDING across multiple polls (e.g. Redis is up but
            # no celery_worker container is consuming the queue), run local fallback
            if state == "PENDING" and local_entry and local_entry.get("payload"):
                local_entry["pending_polls"] = int(local_entry.get("pending_polls", 0)) + 1
                if local_entry["pending_polls"] >= 2:
                    payload = local_entry.pop("payload")
                    asyncio.create_task(_run_local_fallback_task(task_id, payload))

            return {
                "task_id": task_id,
                "status": "processing",
                "state": state,
                "result": None,
                "execution_trace": None,
                "error": None,
            }
        except Exception as exc:
            print(f"[WARNING] Failed to query Celery AsyncResult for {task_id}: {exc}")

    if local_entry is not None:
        return {
            "task_id": task_id,
            "status": local_entry["status"],
            "state": local_entry["state"],
            "result": local_entry.get("result"),
            "execution_trace": local_entry.get("result"),
            "error": local_entry.get("error"),
        }

    return {
        "task_id": task_id,
        "status": "processing",
        "state": "PENDING",
        "result": None,
        "execution_trace": None,
        "error": None,
    }
