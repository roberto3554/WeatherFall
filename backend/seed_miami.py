import asyncio
from typing import Any

import geopandas as gpd
import networkx as nx
import numpy as np
import osmnx as ox
import pandas as pd
from scipy.spatial import KDTree
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

# Per-sector caps and minimum spatial separation (in degrees, ~0.008 deg ≈ 900m)
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


def is_too_close(lon: float, lat: float, existing_nodes: list[dict[str, Any]], min_dist: float = MIN_SEPARATION_DEG) -> bool:
    """Returns True if (lon, lat) is within min_dist degrees of any already-accepted node."""
    for node in existing_nodes:
        dist = float(np.hypot(lon - node["x"], lat - node["y"]))
        if dist < min_dist:
            return True
    return False


def extract_osm_miami_nodes() -> list[dict[str, Any]]:
    """
    Downloads critical infrastructure geometries for Miami, Florida from OpenStreetMap,
    keeps named facilities with spatial separation so labels never stack on top of each other.
    """
    print(f"Downloading OpenStreetMap features for '{PLACE_QUERY}' with tags={OSM_TAGS}...")
    gdf: gpd.GeoDataFrame = ox.features_from_place(PLACE_QUERY, tags=OSM_TAGS)

    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)

    nodes: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    type_counts: dict[str, int] = {"energy": 0, "health": 0, "comms": 0, "water": 0, "transport": 0}

    for _, row in gdf.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue

        raw_name = row.get("name")
        if pd.isna(raw_name) or not str(raw_name).strip():
            # Skip unnamed OSM polygons/segments so the map only displays real named facilities
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

        # Enforce minimum spatial separation so two nodes do not overlap on the canvas
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

    # Supplement comms exchange hubs
    for item in FALLBACK_COMMS_NODES:
        if item["name"] not in seen_names and type_counts["comms"] < MAX_PER_TYPE["comms"]:
            nodes.append(item)
            seen_names.add(item["name"])
            type_counts["comms"] += 1

    # Supplement water treatment/pumping stations
    for item in FALLBACK_WATER_NODES:
        if item["name"] not in seen_names and type_counts["water"] < MAX_PER_TYPE["water"]:
            nodes.append(item)
            seen_names.add(item["name"])
            type_counts["water"] += 1

    return nodes


def build_spatial_dependency_graph(nodes: list[dict[str, Any]]) -> nx.DiGraph:
    """
    Builds a directed NetworkX graph connecting spatial nodes using scipy.spatial.KDTree:
      1. Every 'health', 'comms', and 'water' node connects as a target to its nearest 'energy' node (source).
      2. Every 'health' node connects as a target to its nearest 'transport' node (source).
      3. Every 'transport' node connects as a target to its nearest 'energy' node (source).
      4. Secondary edges connect nearest 'comms' nodes and nearest 'energy' substations.
    """
    graph = nx.DiGraph()

    for node in nodes:
        graph.add_node(
            node["name"],
            type=node["type"],
            x=node["x"],
            y=node["y"],
        )

    energy_nodes = [n for n in nodes if n["type"] == "energy"]
    health_nodes = [n for n in nodes if n["type"] == "health"]
    comms_nodes = [n for n in nodes if n["type"] == "comms"]
    water_nodes = [n for n in nodes if n["type"] == "water"]
    transport_nodes = [n for n in nodes if n["type"] == "transport"]

    # Rule 1: Connect every 'health', 'comms', 'water', and 'transport' node (target) to nearest 'energy' node (source)
    power_dependent_nodes = health_nodes + comms_nodes + water_nodes + transport_nodes
    if energy_nodes and power_dependent_nodes:
        energy_coords = np.array([[n["x"], n["y"]] for n in energy_nodes], dtype=float)
        energy_tree = KDTree(energy_coords)

        for dep_node in power_dependent_nodes:
            _, nearest_idx = energy_tree.query([dep_node["x"], dep_node["y"]], k=1)
            nearest_energy_node = energy_nodes[int(nearest_idx)]
            graph.add_edge(nearest_energy_node["name"], dep_node["name"])

    # Rule 2: Connect every 'health' node (target) to the nearest 'transport' node (source)
    if transport_nodes and health_nodes:
        transport_coords = np.array([[n["x"], n["y"]] for n in transport_nodes], dtype=float)
        transport_tree = KDTree(transport_coords)

        for health_node in health_nodes:
            _, nearest_idx = transport_tree.query([health_node["x"], health_node["y"]], k=1)
            nearest_transport_node = transport_nodes[int(nearest_idx)]
            graph.add_edge(nearest_transport_node["name"], health_node["name"])

    # Rule 3: Create secondary edges between nearest 'comms' nodes
    if len(comms_nodes) >= 2:
        comms_coords = np.array([[n["x"], n["y"]] for n in comms_nodes], dtype=float)
        comms_tree = KDTree(comms_coords)
        k_neighbors = min(3, len(comms_nodes))

        for idx, comms_node in enumerate(comms_nodes):
            _, neighbor_indices = comms_tree.query(
                [comms_node["x"], comms_node["y"]],
                k=k_neighbors,
            )
            indices_list = (
                [int(neighbor_indices)]
                if np.isscalar(neighbor_indices)
                else [int(i) for i in neighbor_indices]
            )
            for neighbor_idx in indices_list:
                if neighbor_idx != idx:
                    target_comms = comms_nodes[neighbor_idx]
                    graph.add_edge(comms_node["name"], target_comms["name"])

    # Rule 4: Connect each 'energy' substation to its nearest neighboring 'energy' substations
    if len(energy_nodes) >= 2:
        energy_coords = np.array([[n["x"], n["y"]] for n in energy_nodes], dtype=float)
        energy_tree = KDTree(energy_coords)
        k_grid = min(3, len(energy_nodes))

        for idx, energy_node in enumerate(energy_nodes):
            _, neighbor_indices = energy_tree.query(
                [energy_node["x"], energy_node["y"]],
                k=k_grid,
            )
            indices_list = (
                [int(neighbor_indices)]
                if np.isscalar(neighbor_indices)
                else [int(i) for i in neighbor_indices]
            )
            for neighbor_idx in indices_list:
                if neighbor_idx != idx:
                    target_energy = energy_nodes[neighbor_idx]
                    graph.add_edge(energy_node["name"], target_energy["name"])

    return graph


async def seed_miami_database() -> None:
    """
    Clears existing Node and Edge tables and persists all OSM-extracted
    Miami nodes and KDTree dependency edges into PostgreSQL.
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
            text("ALTER TABLE simulation_traces ADD COLUMN IF NOT EXISTS magnitude VARCHAR(100);")
        )

    osm_nodes = await asyncio.to_thread(extract_osm_miami_nodes)
    graph = build_spatial_dependency_graph(osm_nodes)

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

            for source_name, target_name in graph.edges():
                edge_obj = Edge(
                    source_node_id=node_records[str(source_name)].id,
                    target_node_id=node_records[str(target_name)].id,
                )
                session.add(edge_obj)

        counts: dict[str, int] = {}
        for _, d in graph.nodes(data=True):
            t = str(d.get("type", "unknown"))
            counts[t] = counts.get(t, 0) + 1

        print(
            f"Successfully seeded {graph.number_of_nodes()} OSM Miami nodes {counts} and "
            f"{graph.number_of_edges()} spatial KDTree edges into PostgreSQL."
        )

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed_miami_database())
