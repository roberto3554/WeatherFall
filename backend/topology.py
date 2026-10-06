from typing import Any
import networkx as nx


def get_city_topology() -> nx.DiGraph:
    """
    Builds and returns the static urban infrastructure dependency graph.
    Edges point in the direction of dependency/cascade propagation:
    Parent (Upstream Provider) -> Child (Downstream Dependent).
    """
    graph = nx.DiGraph()

    # Define core infrastructure nodes with metadata for the LLM agent
    nodes: dict[str, dict[str, Any]] = {
        "power_station": {
            "name": "Central Power Station",
            "type": "energy",
            "resilience_threshold": 6,
            "backup_system": "Substation flood barriers rated up to severity 5",
            "description": "Primary high-voltage generation and distribution hub for the metro grid.",
        },
        "comms_tower": {
            "name": "Metro Comms Tower",
            "type": "telecommunications",
            "resilience_threshold": 7,
            "backup_system": "4-hour battery array and emergency diesel generator",
            "description": "Core cellular, emergency dispatch, and fiber-optic relay tower.",
        },
        "hospital": {
            "name": "General City Hospital",
            "type": "healthcare",
            "resilience_threshold": 8,
            "backup_system": "Dual diesel generators and satellite telemetry link",
            "description": "Level-1 trauma center relying on grid power and dispatch communications.",
        },
    }

    for node_id, attrs in nodes.items():
        graph.add_node(node_id, **attrs)

    # Directed edges: Power Station -> Comms Tower -> Hospital
    edges: list[tuple[str, str, dict[str, str]]] = [
        (
            "power_station",
            "comms_tower",
            {"dependency": "Requires continuous high-voltage grid power for active transmitters."},
        ),
        (
            "comms_tower",
            "hospital",
            {"dependency": "Requires emergency dispatch telemetry, ambulance routing, and EHR network."},
        ),
    ]

    for source, target, attrs in edges:
        graph.add_edge(source, target, **attrs)

    return graph


def serialize_topology(graph: nx.DiGraph) -> dict[str, list[dict[str, Any]]]:
    """Serializes the NetworkX DiGraph into a JSON-friendly dictionary for frontend visualization."""
    return {
        "nodes": [{"id": node_id, **attrs} for node_id, attrs in graph.nodes(data=True)],
        "edges": [
            {"source": u, "target": v, **attrs} for u, v, attrs in graph.edges(data=True)
        ],
    }
