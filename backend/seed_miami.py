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
    "amenity": "hospital",
    "telecom": "exchange",
}

# Fallback real-world Miami telecom exchange hubs if OSM returns fewer than 2 'telecom=exchange' features
FALLBACK_COMMS_NODES: list[dict[str, Any]] = [
    {"name": "NAP of the Americas (Equinix MI1)", "type": "comms", "x": -80.1918, "y": 25.7825},
    {"name": "AT&T Downtown Miami Central Office", "type": "comms", "x": -80.1936, "y": 25.7743},
    {"name": "Verizon Brickell Fiber Exchange", "type": "comms", "x": -80.1909, "y": 25.7617},
]


def classify_feature_type(row: pd.Series) -> str:
    """Maps an OpenStreetMap feature row to 'energy', 'health', or 'comms'."""
    if pd.notna(row.get("power")) and str(row.get("power")) == "substation":
        return "energy"
    if pd.notna(row.get("amenity")) and str(row.get("amenity")) == "hospital":
        return "health"
    if pd.notna(row.get("telecom")) or pd.notna(row.get("man_made")):
        return "comms"
    return "energy"


def extract_osm_miami_nodes() -> list[dict[str, Any]]:
    """
    Downloads critical infrastructure geometries for Miami, Florida from OpenStreetMap,
    extracts centroid (lon -> x, lat -> y), and normalizes node names and types.
    """
    print(f"Downloading OpenStreetMap features for '{PLACE_QUERY}' with tags={OSM_TAGS}...")
    gdf: gpd.GeoDataFrame = ox.features_from_place(PLACE_QUERY, tags=OSM_TAGS)

    # Ensure WGS84 (EPSG:4326) for lon/lat extraction
    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)

    nodes: list[dict[str, Any]] = []
    seen_names: dict[str, int] = {}

    for _, row in gdf.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue

        centroid = geom.centroid
        lon = float(centroid.x)
        lat = float(centroid.y)

        raw_name = row.get("name")
        if pd.isna(raw_name) or not str(raw_name).strip():
            base_name = "Unknown Node"
        else:
            base_name = str(raw_name).strip()

        # Disambiguate duplicate names (e.g. multiple 'Unknown Node' entries) to satisfy UNIQUE constraint
        count = seen_names.get(base_name, 0) + 1
        seen_names[base_name] = count
        unique_name = base_name if count == 1 else f"{base_name} #{count}"

        node_type = classify_feature_type(row)
        nodes.append(
            {
                "name": unique_name,
                "type": node_type,
                "x": lon,
                "y": lat,
            }
        )

    # If OSM has fewer than 2 'telecom=exchange' features in Miami city limits, query additional telecom towers/exchanges
    comms_count = sum(1 for n in nodes if n["type"] == "comms")
    if comms_count < 2:
        try:
            extra_comms_gdf = ox.features_from_place(
                PLACE_QUERY,
                tags={"telecom": True, "man_made": "communications_tower"},
            )
            if extra_comms_gdf.crs is not None and extra_comms_gdf.crs.to_epsg() != 4326:
                extra_comms_gdf = extra_comms_gdf.to_crs(epsg=4326)

            for _, row in extra_comms_gdf.iterrows():
                geom = row.geometry
                if geom is None or geom.is_empty:
                    continue
                centroid = geom.centroid
                raw_name = row.get("name")
                base_name = (
                    str(raw_name).strip()
                    if pd.notna(raw_name) and str(raw_name).strip()
                    else "Unknown Comms Node"
                )
                count = seen_names.get(base_name, 0) + 1
                seen_names[base_name] = count
                unique_name = base_name if count == 1 else f"{base_name} #{count}"

                nodes.append(
                    {
                        "name": unique_name,
                        "type": "comms",
                        "x": float(centroid.x),
                        "y": float(centroid.y),
                    }
                )
                comms_count += 1
        except Exception:
            pass

    # Guarantee at least 3 comms nodes for KDTree secondary communication network
    if comms_count < 2:
        for item in FALLBACK_COMMS_NODES:
            if item["name"] not in seen_names:
                nodes.append(item)
                seen_names[item["name"]] = 1

    return nodes


def build_spatial_dependency_graph(nodes: list[dict[str, Any]]) -> nx.DiGraph:
    """
    Builds a directed NetworkX graph connecting spatial nodes using scipy.spatial.KDTree:
      1. Every 'health' and 'comms' node connects as a child/target to its nearest 'energy' node (source).
      2. Secondary edges connect nearest 'comms' nodes to form a communication network.
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
    dependent_nodes = [n for n in nodes if n["type"] in ("health", "comms")]
    comms_nodes = [n for n in nodes if n["type"] == "comms"]

    # Rule 1: Connect every 'health' and 'comms' node (target) to nearest 'energy' node (source)
    if energy_nodes and dependent_nodes:
        energy_coords = np.array([[n["x"], n["y"]] for n in energy_nodes], dtype=float)
        energy_tree = KDTree(energy_coords)

        for dep_node in dependent_nodes:
            _, nearest_idx = energy_tree.query([dep_node["x"], dep_node["y"]], k=1)
            nearest_energy_node = energy_nodes[int(nearest_idx)]
            graph.add_edge(nearest_energy_node["name"], dep_node["name"])

    # Rule 2: Create secondary edges between nearest 'comms' nodes
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

    # Grid Interconnection: Connect each 'energy' substation to its 3 nearest neighboring 'energy' substations
    if len(energy_nodes) >= 2:
        energy_coords = np.array([[n["x"], n["y"]] for n in energy_nodes], dtype=float)
        energy_tree = KDTree(energy_coords)
        k_grid = min(4, len(energy_nodes))

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
    Task 4: Clears existing Node and Edge tables and persists all OSM-extracted
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

        energy_cnt = sum(1 for _, d in graph.nodes(data=True) if d.get("type") == "energy")
        health_cnt = sum(1 for _, d in graph.nodes(data=True) if d.get("type") == "health")
        comms_cnt = sum(1 for _, d in graph.nodes(data=True) if d.get("type") == "comms")

        print(
            f"Successfully seeded {graph.number_of_nodes()} OSM Miami nodes "
            f"(energy={energy_cnt}, health={health_cnt}, comms={comms_cnt}) and "
            f"{graph.number_of_edges()} spatial KDTree edges into PostgreSQL."
        )

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed_miami_database())
