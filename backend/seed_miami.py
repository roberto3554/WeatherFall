import asyncio
from typing import Any

import geopandas as gpd
import networkx as nx
import numpy as np
import osmnx as ox
import pandas as pd
from sqlalchemy import delete, text

try:
    from .database import AsyncSessionLocal, engine, init_db
    from .models import Edge, Node
except ImportError:
    from database import AsyncSessionLocal, engine, init_db
    from models import Edge, Node


PLACE_QUERY = "Miami, Florida, USA"

OSM_TAGS: dict[str, Any] = {
    "power": "substation",
    "amenity": ["hospital", "ferry_terminal"],
    "telecom": "exchange",
    "man_made": ["water_works", "wastewater_plant", "pumping_station", "water_tower"],
    "waterway": ["pump", "dam"],
    "public_transport": "station",
    "highway": "primary",
}

FALLBACK_COMMS_NODES: list[dict[str, Any]] = [
    {"name": "NAP of the Americas (Equinix)", "type": "comms", "x": -80.1918, "y": 25.7825},
    {"name": "AT&T Downtown Miami Exchange", "type": "comms", "x": -80.1985, "y": 25.7743},
    {"name": "Verizon Brickell Fiber Hub", "type": "comms", "x": -80.1930, "y": 25.7590},
    {"name": "Little River Telecom Exchange", "type": "comms", "x": -80.1951, "y": 25.8527},
]

FALLBACK_WATER_NODES: list[dict[str, Any]] = [
    {"name": "Alexander Orr Water Plant", "type": "water", "x": -80.2890, "y": 25.7295},
    {"name": "Virginia Key Wastewater Plant", "type": "water", "x": -80.1492, "y": 25.7440},
    {"name": "Miami Beach Pump Station #1", "type": "water", "x": -80.1405, "y": 25.7890},
    {"name": "Miami River Stormwater Pump", "type": "water", "x": -80.2140, "y": 25.7790},
]

MAX_PER_TYPE: dict[str, int] = {
    "energy": 12,
    "health": 7,
    "transport": 8,
    "water": 5,
    "comms": 4,
}
MIN_SEPARATION_DEG = 0.0085


def classify_feature_type(row: pd.Series) -> str:
    """Maps an OpenStreetMap feature row to 'energy', 'health', 'comms', 'water', or 'transport'."""
    power_val = str(row.get("power", "")) if pd.notna(row.get("power")) else ""
    amenity_val = str(row.get("amenity", "")) if pd.notna(row.get("amenity")) else ""
    man_made_val = str(row.get("man_made", "")) if pd.notna(row.get("man_made")) else ""
    waterway_val = str(row.get("waterway", "")) if pd.notna(row.get("waterway")) else ""
    pt_val = str(row.get("public_transport", "")) if pd.notna(row.get("public_transport")) else ""
    highway_val = str(row.get("highway", "")) if pd.notna(row.get("highway")) else ""

    if power_val == "substation":
        return "energy"
    if amenity_val == "hospital":
        return "health"
    if man_made_val in ("water_works", "wastewater_plant", "pumping_station", "water_tower") or waterway_val in ("pump", "dam"):
        return "water"
    if pt_val == "station" or amenity_val == "ferry_terminal" or highway_val == "primary":
        return "transport"
    if pd.notna(row.get("telecom")):
        return "comms"
    return "energy"


def is_too_close(
    lon: float,
    lat: float,
    existing_nodes: list[dict[str, Any]],
    min_dist: float = MIN_SEPARATION_DEG,
) -> bool:
    """Returns True if (lon, lat) is within min_dist degrees of any already-accepted node."""
    for node in existing_nodes:
        dist = float(np.hypot(lon - node["x"], lat - node["y"]))
        if dist < min_dist:
            return True
    return False


def fetch_street_network() -> nx.MultiDiGraph:
    """
    Task 1: Downloads the physical street network for Miami, Florida using OSMnx.
    """
    print(f"Downloading physical street network for '{PLACE_QUERY}' (network_type='drive')...")
    street_graph: nx.MultiDiGraph = ox.graph_from_place(PLACE_QUERY, network_type="drive")
    print(
        f"Loaded Miami street network: {street_graph.number_of_nodes()} intersections, "
        f"{street_graph.number_of_edges()} street segments."
    )
    return street_graph


def extract_osm_miami_nodes() -> list[dict[str, Any]]:
    """
    Downloads critical infrastructure geometries for Miami, Florida from OpenStreetMap,
    retaining named facilities with spatial separation.
    """
    print(f"Downloading OpenStreetMap features for '{PLACE_QUERY}' with tags={OSM_TAGS}...")
    gdf: gpd.GeoDataFrame = ox.features_from_place(PLACE_QUERY, tags=OSM_TAGS)

    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)

    nodes: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    type_counts: dict[str, int] = {
        "energy": 0,
        "health": 0,
        "comms": 0,
        "water": 0,
        "transport": 0,
    }

    for _, row in gdf.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue

        raw_name = row.get("name")
        if pd.isna(raw_name) or not str(raw_name).strip():
            continue

        clean_name = str(raw_name).strip()
        if clean_name in seen_names:
            continue

        node_type = classify_feature_type(row)
        if type_counts.get(node_type, 0) >= MAX_PER_TYPE.get(node_type, 8):
            continue

        centroid = geom.centroid
        lon = float(centroid.x)
        lat = float(centroid.y)

        min_sep = 0.003 if node_type == "health" else MIN_SEPARATION_DEG
        if is_too_close(lon, lat, nodes, min_dist=min_sep):
            continue

        seen_names.add(clean_name)
        type_counts[node_type] = type_counts.get(node_type, 0) + 1

        nodes.append(
            {
                "name": clean_name,
                "type": node_type,
                "x": lon,
                "y": lat,
            }
        )

    for item in FALLBACK_COMMS_NODES:
        if item["name"] not in seen_names and type_counts["comms"] < MAX_PER_TYPE["comms"]:
            nodes.append(dict(item))
            seen_names.add(item["name"])
            type_counts["comms"] += 1

    for item in FALLBACK_WATER_NODES:
        if item["name"] not in seen_names and type_counts["water"] < MAX_PER_TYPE["water"]:
            nodes.append(dict(item))
            seen_names.add(item["name"])
            type_counts["water"] += 1

    return nodes


def snap_facilities_to_street_grid(
    street_graph: nx.MultiDiGraph,
    nodes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Task 2: Uses osmnx.nearest_nodes to snap each critical infrastructure facility's
    (x=lon, y=lat) coordinate to the closest intersection node on the physical street graph.
    """
    if not nodes:
        return nodes

    lons = [float(n["x"]) for n in nodes]
    lats = [float(n["y"]) for n in nodes]

    try:
        nearest_street_ids = ox.nearest_nodes(street_graph, X=lons, Y=lats)
    except ImportError:
        from scipy.spatial import KDTree

        street_node_ids = [int(nid) for nid in street_graph.nodes]
        street_coords = np.array(
            [
                [float(street_graph.nodes[nid]["x"]), float(street_graph.nodes[nid]["y"])]
                for nid in street_node_ids
            ],
            dtype=float,
        )
        tree = KDTree(street_coords)
        _, idxs = tree.query(np.column_stack([lons, lats]), k=1)
        nearest_street_ids = [street_node_ids[int(i)] for i in np.atleast_1d(idxs)]

    for node, street_node_id in zip(nodes, nearest_street_ids):
        node["street_node_id"] = int(street_node_id)

    return nodes


def compute_street_route(
    street_graph: nx.MultiDiGraph,
    undirected_graph: nx.MultiGraph,
    source_street_id: int,
    target_street_id: int,
) -> tuple[float, list[int]]:
    """
    Task 3: Calculates the shortest physical street network path and length (in meters)
    between two snapped street intersection nodes using networkx.shortest_path_length()
    and networkx.shortest_path(). Falls back to the undirected street corridor graph if
    one-way traffic restrictions prevent a directed path.
    """
    if source_street_id == target_street_id:
        return 0.0, [int(source_street_id)]

    for g in (street_graph, undirected_graph):
        try:
            distance = float(
                nx.shortest_path_length(
                    g,
                    source=source_street_id,
                    target=target_street_id,
                    weight="length",
                )
            )
            path = [
                int(nid)
                for nid in nx.shortest_path(
                    g,
                    source=source_street_id,
                    target=target_street_id,
                    weight="length",
                )
            ]
            return round(distance, 2), path
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            continue

    return float("inf"), [int(source_street_id), int(target_street_id)]


def find_k_nearest_by_street_network(
    street_graph: nx.MultiDiGraph,
    undirected_graph: nx.MultiGraph,
    target_node: dict[str, Any],
    candidate_sources: list[dict[str, Any]],
    k: int = 1,
) -> list[tuple[dict[str, Any], float, list[int]]]:
    """
    Finds the top-k candidate source facilities with the shortest physical street-network
    routing distance to `target_node`.
    """
    scored: list[tuple[dict[str, Any], float, list[int]]] = []
    target_street_id = int(target_node["street_node_id"])

    for cand in candidate_sources:
        if cand["name"] == target_node["name"]:
            continue
        source_street_id = int(cand["street_node_id"])
        dist, path = compute_street_route(
            street_graph,
            undirected_graph,
            source_street_id=source_street_id,
            target_street_id=target_street_id,
        )
        if np.isfinite(dist):
            scored.append((cand, dist, path))

    if not scored and candidate_sources:
        # Fallback if a facility is on an isolated island (e.g., Fisher Island)
        for cand in candidate_sources:
            if cand["name"] == target_node["name"]:
                continue
            euclid_meters = float(
                np.hypot(cand["x"] - target_node["x"], cand["y"] - target_node["y"]) * 111_139.0
            )
            scored.append(
                (
                    cand,
                    round(euclid_meters, 2),
                    [int(cand["street_node_id"]), target_street_id],
                )
            )

    scored.sort(key=lambda item: item[1])
    return scored[:k]


def build_street_dependency_graph(
    street_graph: nx.MultiDiGraph,
    nodes: list[dict[str, Any]],
) -> nx.DiGraph:
    """
    Task 3: Builds a directed NetworkX dependency graph where every logical dependency edge
    is routed through the real Miami street network using networkx.shortest_path_length()
    and networkx.shortest_path(), storing `routing_distance` (m) and `path_nodes`.
    """
    graph = nx.DiGraph()
    undirected_street = street_graph.to_undirected()

    for node in nodes:
        graph.add_node(
            node["name"],
            type=node["type"],
            x=node["x"],
            y=node["y"],
            street_node_id=node["street_node_id"],
        )

    energy_nodes = [n for n in nodes if n["type"] == "energy"]
    health_nodes = [n for n in nodes if n["type"] == "health"]
    comms_nodes = [n for n in nodes if n["type"] == "comms"]
    water_nodes = [n for n in nodes if n["type"] == "water"]
    transport_nodes = [n for n in nodes if n["type"] == "transport"]

    # Rule 1: Connect every 'health', 'comms', 'water', and 'transport' node (target)
    # to the nearest 'energy' substation (source) by physical street network distance
    power_dependent_nodes = health_nodes + comms_nodes + water_nodes + transport_nodes
    if energy_nodes and power_dependent_nodes:
        for dep_node in power_dependent_nodes:
            matches = find_k_nearest_by_street_network(
                street_graph,
                undirected_street,
                target_node=dep_node,
                candidate_sources=energy_nodes,
                k=1,
            )
            for nearest_energy, routing_dist, path_nodes in matches:
                graph.add_edge(
                    nearest_energy["name"],
                    dep_node["name"],
                    routing_distance=routing_dist,
                    path_nodes=path_nodes,
                )

    # Rule 2: Connect every 'health' node (target) to the nearest 'transport' node (source)
    # via the shortest physical street route
    if transport_nodes and health_nodes:
        for health_node in health_nodes:
            matches = find_k_nearest_by_street_network(
                street_graph,
                undirected_street,
                target_node=health_node,
                candidate_sources=transport_nodes,
                k=1,
            )
            for nearest_transport, routing_dist, path_nodes in matches:
                graph.add_edge(
                    nearest_transport["name"],
                    health_node["name"],
                    routing_distance=routing_dist,
                    path_nodes=path_nodes,
                )

    # Rule 3: Create secondary street-routed edges between nearest 'comms' nodes
    if len(comms_nodes) >= 2:
        for comms_node in comms_nodes:
            matches = find_k_nearest_by_street_network(
                street_graph,
                undirected_street,
                target_node=comms_node,
                candidate_sources=comms_nodes,
                k=2,
            )
            for neighbor_comms, routing_dist, path_nodes in matches:
                graph.add_edge(
                    comms_node["name"],
                    neighbor_comms["name"],
                    routing_distance=routing_dist,
                    path_nodes=path_nodes,
                )

    # Rule 4: Connect each 'energy' substation to its 2 nearest neighboring 'energy' substations
    # over the street network
    if len(energy_nodes) >= 2:
        for energy_node in energy_nodes:
            matches = find_k_nearest_by_street_network(
                street_graph,
                undirected_street,
                target_node=energy_node,
                candidate_sources=energy_nodes,
                k=2,
            )
            for neighbor_energy, routing_dist, path_nodes in matches:
                graph.add_edge(
                    energy_node["name"],
                    neighbor_energy["name"],
                    routing_distance=routing_dist,
                    path_nodes=path_nodes,
                )

    return graph


def build_full_miami_street_topology() -> nx.DiGraph:
    """
    Synchronous pipeline executed in a worker thread:
      1. Downloads Miami drive street network (`ox.graph_from_place`).
      2. Extracts critical OSM facilities (`ox.features_from_place`).
      3. Snaps facilities to the closest street intersections (`ox.nearest_nodes`).
      4. Computes shortest-path dependency edges (`nx.shortest_path_length` & `nx.shortest_path`).
    """
    street_graph = fetch_street_network()
    osm_nodes = extract_osm_miami_nodes()
    snapped_nodes = snap_facilities_to_street_grid(street_graph, osm_nodes)
    return build_street_dependency_graph(street_graph, snapped_nodes)


async def seed_miami_database() -> None:
    """
    Clears existing Node and Edge tables and persists all OSM-extracted
    Miami nodes and physical street-routed dependency edges (with routing_distance
    and path_nodes) into PostgreSQL.
    """
    await init_db()

    async with engine.begin() as conn:
        await conn.execute(
            text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS x DOUBLE PRECISION DEFAULT 0.0;")
        )
        await conn.execute(
            text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS y DOUBLE PRECISION DEFAULT 0.0;")
        )
        await conn.execute(
            text("ALTER TABLE edges ADD COLUMN IF NOT EXISTS routing_distance DOUBLE PRECISION;")
        )
        await conn.execute(
            text("ALTER TABLE edges ADD COLUMN IF NOT EXISTS path_nodes JSONB;")
        )
        await conn.execute(
            text("ALTER TABLE simulation_traces ADD COLUMN IF NOT EXISTS magnitude VARCHAR(100);")
        )

    graph = await asyncio.to_thread(build_full_miami_street_topology)

    async with AsyncSessionLocal() as session:
        async with session.begin():
            await session.execute(delete(Edge))
            await session.execute(delete(Node))

            node_records: dict[str, Node] = {}
            for node_name, attrs in graph.nodes(data=True):
                node_obj = Node(
                    name=str(node_name),
                    type=str(attrs.get("type", "energy")),
                    x=float(attrs.get("x", 0.0)),
                    y=float(attrs.get("y", 0.0)),
                )
                session.add(node_obj)
                node_records[str(node_name)] = node_obj

            await session.flush()

            for source_name, target_name, edge_attrs in graph.edges(data=True):
                edge_obj = Edge(
                    source_node_id=node_records[str(source_name)].id,
                    target_node_id=node_records[str(target_name)].id,
                    routing_distance=(
                        float(edge_attrs["routing_distance"])
                        if edge_attrs.get("routing_distance") is not None
                        else None
                    ),
                    path_nodes=edge_attrs.get("path_nodes"),
                )
                session.add(edge_obj)

        counts: dict[str, int] = {}
        for _, d in graph.nodes(data=True):
            t = str(d.get("type", "unknown"))
            counts[t] = counts.get(t, 0) + 1

        print(
            f"Successfully seeded {graph.number_of_nodes()} OSM Miami nodes {counts} and "
            f"{graph.number_of_edges()} street-routed dependency edges into PostgreSQL."
        )

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed_miami_database())
