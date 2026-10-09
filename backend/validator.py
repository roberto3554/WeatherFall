from typing import Any

import networkx as nx


def _normalize_sector(raw_type: Any) -> str:
    """Normalizes facility sector names (e.g. 'power' -> 'energy')."""
    val = str(raw_type or "energy").strip().lower()
    if val == "power":
        return "energy"
    return val


def _default_capacity_for_node(data: dict[str, Any]) -> int:
    """Returns a sensible default out-degree capacity when a node's capacity attribute is undefined."""
    raw_cap = data.get("capacity")
    if raw_cap is not None:
        try:
            parsed = int(raw_cap)
            if parsed > 0:
                return parsed
        except (TypeError, ValueError):
            pass

    tier = str(data.get("tier") or "Secondary").strip().lower()
    return 6 if tier == "primary" else 3


def validate_city_graph(G: nx.DiGraph) -> list[dict[str, Any]]:
    """
    Task 1: Topological Integrity Validator using NetworkX.

    Analyzes the directed infrastructure graph `G` and returns a list of diagnostic
    objects (`level`: 'critical' | 'warning', `node_id`: str, `message`: str, `category`: str):
      1. Cycle Analysis (`critical`):
         Uses `networkx.simple_cycles(G)` to detect circular dependencies
         (e.g., Water -> Energy -> Water) that would cause simulation deadlocks.
      2. Orphan Detection (`critical`):
         Checks incoming edges for every node:
           - `health` nodes MUST have incoming edges from `energy`, `water`, AND `comms` nodes.
           - `water` and `comms` (and `transport`) nodes MUST have an incoming edge from an `energy` node.
           - Completely isolated `energy` nodes (`in_degree == 0` and `out_degree == 0`) are also flagged.
      3. Bottleneck Analysis (`warning`):
         Checks the out-degree (`G.out_degree(node)`) of supplier nodes. If the number of
         outgoing edges exceeds the node's `capacity` attribute (or sensible default if undefined),
         flags it as a `warning` bottleneck.
    """
    diagnostics: list[dict[str, Any]] = []
    if G is None or G.number_of_nodes() == 0:
        return diagnostics

    # ── 1. Cycle Analysis (Critical Deadlocks) ───────────────────────────────
    for cycle in nx.simple_cycles(G):
        if not cycle:
            continue
        cycle_nodes = [str(n) for n in cycle]
        anchor_node = cycle_nodes[0]
        closed_loop = cycle_nodes + [anchor_node]
        path_str = " → ".join(closed_loop)
        sector_chain = " → ".join(
            _normalize_sector(G.nodes[n].get("type", "unknown")).capitalize()
            for n in closed_loop
            if n in G.nodes
        )
        anchor_type = _normalize_sector(G.nodes.get(anchor_node, {}).get("type", "unknown"))
        diagnostics.append(
            {
                "level": "critical",
                "category": "cycle",
                "node_id": anchor_node,
                "node_type": anchor_type,
                "message": (
                    f"Circular dependency cycle deadlock ({sector_chain}): {path_str}. "
                    f"Break at least one directed edge in this loop before running a simulation."
                ),
            }
        )

    # ── 2. Orphan Detection (Critical Missing Lifelines) ─────────────────────
    for node, data in G.nodes(data=True):
        node_str = str(node)
        node_type = _normalize_sector(data.get("type", "energy"))
        predecessors = [pred for pred in G.predecessors(node) if pred != node]
        incoming_types = {
            _normalize_sector(G.nodes[pred].get("type", "energy"))
            for pred in predecessors
            if pred in G.nodes
        }

        if node_type == "health":
            missing_lifelines: list[str] = []
            if "energy" not in incoming_types:
                missing_lifelines.append("energy")
            if "water" not in incoming_types:
                missing_lifelines.append("water")
            if "comms" not in incoming_types:
                missing_lifelines.append("comms")
            if missing_lifelines:
                if len(missing_lifelines) == 3:
                    missing_label = "energy, water, and comms"
                else:
                    missing_label = " and ".join(missing_lifelines)
                diagnostics.append(
                    {
                        "level": "critical",
                        "category": "orphan",
                        "node_id": node_str,
                        "node_type": node_type,
                        "message": (
                            f"Critical orphan (Health): '{node_str}' lacks mandatory incoming "
                            f"{missing_label} lifeline connection(s) (requires energy, water, and comms)."
                        ),
                    }
                )
        elif node_type in {"water", "comms", "transport"}:
            if "energy" not in incoming_types:
                diagnostics.append(
                    {
                        "level": "critical",
                        "category": "orphan",
                        "node_id": node_str,
                        "node_type": node_type,
                        "message": (
                            f"Critical orphan ({node_type.capitalize()}): '{node_str}' lacks a mandatory "
                            f"incoming energy supply edge."
                        ),
                    }
                )
        elif node_type == "energy":
            if G.in_degree(node) == 0 and G.out_degree(node) == 0 and G.number_of_nodes() > 1:
                diagnostics.append(
                    {
                        "level": "critical",
                        "category": "orphan",
                        "node_id": node_str,
                        "node_type": node_type,
                        "message": (
                            f"Critical orphan (Energy): '{node_str}' is completely isolated "
                            f"(0 incoming and 0 outgoing connections)."
                        ),
                    }
                )

    # ── 3. Bottleneck Analysis (Warning Supplier Overload) ───────────────────
    supplier_sectors = {"energy", "water", "comms", "transport"}
    for node, data in G.nodes(data=True):
        node_str = str(node)
        node_type = _normalize_sector(data.get("type", "energy"))
        out_deg = int(G.out_degree(node))
        if out_deg <= 0 and node_type not in supplier_sectors:
            continue

        capacity = _default_capacity_for_node(data)
        if out_deg > capacity:
            diagnostics.append(
                {
                    "level": "warning",
                    "category": "bottleneck",
                    "node_id": node_str,
                    "node_type": node_type,
                    "message": (
                        f"Supplier capacity bottleneck ({node_type.capitalize()}): '{node_str}' has "
                        f"{out_deg} outgoing dependency edges, exceeding its rated capacity of {capacity}."
                    ),
                }
            )

    # Sort critical issues first (cycles then orphans), followed by warnings (bottlenecks)
    priority_map = {"critical": 0, "warning": 1}
    category_map = {"cycle": 0, "orphan": 1, "bottleneck": 2}
    diagnostics.sort(
        key=lambda item: (
            priority_map.get(str(item.get("level", "warning")), 9),
            category_map.get(str(item.get("category", "bottleneck")), 9),
            str(item.get("node_id", "")),
        )
    )
    return diagnostics
