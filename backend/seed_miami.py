import asyncio
import math
import re
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
    {
        "name": "NAP of the Americas (Equinix)",
        "type": "comms",
        "x": -80.1918,
        "y": 25.7825,
        "tier": "Primary",
        "capacity": 5,
        "battery_backup_hours": 72.0,
        "voltage_kv": 0.0,
        "area_sqm": 18500.0,
    },
    {
        "name": "AT&T Downtown Miami Exchange",
        "type": "comms",
        "x": -80.1985,
        "y": 25.7743,
        "tier": "Primary",
        "capacity": 4,
        "battery_backup_hours": 48.0,
        "voltage_kv": 0.0,
        "area_sqm": 9200.0,
    },
    {
        "name": "Verizon Brickell Fiber Hub",
        "type": "comms",
        "x": -80.1930,
        "y": 25.7590,
        "tier": "Secondary",
        "capacity": 2,
        "battery_backup_hours": 24.0,
        "voltage_kv": 0.0,
        "area_sqm": 2800.0,
    },
    {
        "name": "Little River Telecom Exchange",
        "type": "comms",
        "x": -80.1951,
        "y": 25.8527,
        "tier": "Secondary",
        "capacity": 2,
        "battery_backup_hours": 16.0,
        "voltage_kv": 0.0,
        "area_sqm": 2100.0,
    },
]

FALLBACK_WATER_NODES: list[dict[str, Any]] = [
    {
        "name": "Alexander Orr Water Plant",
        "type": "water",
        "x": -80.2890,
        "y": 25.7295,
        "tier": "Primary",
        "capacity": 5,
        "battery_backup_hours": 48.0,
        "voltage_kv": 0.0,
        "area_sqm": 24000.0,
    },
    {
        "name": "Virginia Key Wastewater Plant",
        "type": "water",
        "x": -80.1492,
        "y": 25.7440,
        "tier": "Primary",
        "capacity": 5,
        "battery_backup_hours": 48.0,
        "voltage_kv": 0.0,
        "area_sqm": 21500.0,
    },
    {
        "name": "Miami Beach Pump Station #1",
        "type": "water",
        "x": -80.1405,
        "y": 25.7890,
        "tier": "Secondary",
        "capacity": 2,
        "battery_backup_hours": 18.0,
        "voltage_kv": 0.0,
        "area_sqm": 1400.0,
    },
    {
        "name": "Miami River Stormwater Pump",
        "type": "water",
        "x": -80.2140,
        "y": 25.7790,
        "tier": "Secondary",
        "capacity": 2,
        "battery_backup_hours": 16.0,
        "voltage_kv": 0.0,
        "area_sqm": 1200.0,
    },
]

MAX_PER_TYPE: dict[str, int] = {
    "energy": 12,
    "health": 7,
    "transport": 8,
    "water": 5,
    "comms": 4,
}
MIN_SEPARATION_DEG = 0.0085

# Task 2: Strict Directed Physical Interdependency Matrix
# Defines (supplier_sector, consumer_sector, is_cyclic_fallback)
#   • Hospitals (health) MUST receive electricity (energy), water (water), and communications (comms)
#   • Electricity plants/substations (energy) ONLY need other electricity plants (energy -> energy)
#     in order to supply downstream facilities and residential neighborhoods
#   • Water, Comms, and Transport facilities receive electricity from energy plants/substations
INTERDEPENDENCY_MATRIX: list[tuple[str, str, bool]] = [
    ("energy", "health", False),
    ("water", "health", False),
    ("comms", "health", False),
    ("energy", "water", False),
    ("energy", "comms", False),
    ("energy", "transport", False),
]


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


def _parse_voltage_kv(raw_voltage: Any) -> float:
    """
    Task 1: Parses OSM `voltage` tag values (e.g., '230000;138000', '138 kV', '69000')
    into kilovolts (kV).
    """
    if raw_voltage is None or (isinstance(raw_voltage, float) and math.isnan(raw_voltage)):
        return 0.0
    text_val = str(raw_voltage).strip().lower()
    if not text_val:
        return 0.0

    numbers = [float(m) for m in re.findall(r"\d+(?:\.\d+)?", text_val)]
    if not numbers:
        return 0.0
    max_val = max(numbers)
    if "kv" in text_val or max_val < 1000.0:
        return round(max_val, 1)
    return round(max_val / 1000.0, 1)


def _estimate_footprint_area_sqm(geom: Any, lat: float) -> float:
    """
    Task 1: Estimates the physical footprint area (in m^2) of an OSM geometry in EPSG:4326
    to distinguish large regional facilities (Primary) from smaller local stations (Secondary).
    """
    if geom is None or getattr(geom, "is_empty", True):
        return 0.0
    area_deg2 = float(getattr(geom, "area", 0.0) or 0.0)
    if area_deg2 <= 0.0:
        return 0.0
    meters_per_deg_lat = 111_139.0
    meters_per_deg_lon = 111_139.0 * max(0.2, math.cos(math.radians(lat)))
    return round(area_deg2 * meters_per_deg_lat * meters_per_deg_lon, 1)


def assign_node_tier_and_capacity(
    node_type: str,
    name: str,
    row: pd.Series,
    area_sqm: float,
) -> dict[str, Any]:
    """
    Task 1: Assigns hierarchical `tier` ('Primary' vs 'Secondary'), supply `capacity`
    (out-degree / downstream flow limit), and `battery_backup_hours` (temporal fallback
    autonomy for cyclic dependencies) based on OSM tags and physical footprint size.
    """
    raw_voltage = row.get("voltage") if hasattr(row, "get") else None
    voltage_kv = _parse_voltage_kv(raw_voltage)
    substation_role = str(row.get("substation", "") or "").lower() if hasattr(row, "get") else ""
    man_made_val = str(row.get("man_made", "") or "").lower() if hasattr(row, "get") else ""
    amenity_val = str(row.get("amenity", "") or "").lower() if hasattr(row, "get") else ""
    emergency_val = str(row.get("emergency", "") or "").lower() if hasattr(row, "get") else ""
    name_lower = name.lower()

    if node_type == "energy":
        is_primary = (
            voltage_kv >= 138.0
            or substation_role in ("transmission", "generation", "traction")
            or area_sqm >= 6000.0
            or any(k in name_lower for k in ("miami substation", "flagami", "levee", "davis", "culmer", "railway"))
        )
        tier = "Primary" if is_primary else "Secondary"
        # Primary high-voltage substation can supply up to 6 dependents;
        # Secondary local transformer is strictly capped at capacity=2 (cannot supply 5 hospitals!)
        capacity = 6 if is_primary else 2
        battery_backup_hours = 72.0 if is_primary else 24.0
        return {
            "tier": tier,
            "capacity": capacity,
            "battery_backup_hours": battery_backup_hours,
            "voltage_kv": voltage_kv if voltage_kv > 0 else (230.0 if is_primary else 13.8),
            "area_sqm": area_sqm,
        }

    if node_type == "water":
        is_primary = (
            man_made_val in ("water_works", "wastewater_plant")
            or area_sqm >= 5000.0
            or any(k in name_lower for k in ("plant", "treatment", "central district", "alexander orr", "virginia key"))
        )
        tier = "Primary" if is_primary else "Secondary"
        capacity = 5 if is_primary else 2
        battery_backup_hours = 48.0 if is_primary else 16.0
        return {
            "tier": tier,
            "capacity": capacity,
            "battery_backup_hours": battery_backup_hours,
            "voltage_kv": 0.0,
            "area_sqm": area_sqm,
        }

    if node_type == "health":
        is_primary = (
            area_sqm >= 7500.0
            or emergency_val == "yes"
            or any(k in name_lower for k in ("jackson memorial", "mercy", "mount sinai", "baptist", "university", "trauma", "medical center"))
        )
        tier = "Primary" if is_primary else "Secondary"
        capacity = 2 if is_primary else 1
        battery_backup_hours = 48.0 if is_primary else 24.0
        return {
            "tier": tier,
            "capacity": capacity,
            "battery_backup_hours": battery_backup_hours,
            "voltage_kv": 0.0,
            "area_sqm": area_sqm,
        }

    if node_type == "transport":
        is_primary = (
            amenity_val == "ferry_terminal"
            or area_sqm >= 4000.0
            or any(k in name_lower for k in ("port", "airport", "central", "government center", "intermodal", "hub", "terminal"))
        )
        tier = "Primary" if is_primary else "Secondary"
        capacity = 5 if is_primary else 2
        battery_backup_hours = 36.0 if is_primary else 12.0
        return {
            "tier": tier,
            "capacity": capacity,
            "battery_backup_hours": battery_backup_hours,
            "voltage_kv": 0.0,
            "area_sqm": area_sqm,
        }

    # Default: comms
    is_primary = (
        area_sqm >= 3500.0
        or any(k in name_lower for k in ("nap", "equinix", "coresite", "downtown", "central"))
    )
    tier = "Primary" if is_primary else "Secondary"
    capacity = 5 if is_primary else 2
    battery_backup_hours = 48.0 if is_primary else 16.0
    return {
        "tier": tier,
        "capacity": capacity,
        "battery_backup_hours": battery_backup_hours,
        "voltage_kv": 0.0,
        "area_sqm": area_sqm,
    }


def compute_demographic_profile(
    name: str,
    node_type: str,
    tier: str,
    lon: float,
    lat: float,
) -> tuple[float, int]:
    """
    Task 1: Procedurally generates `social_vulnerability_index` (SVI, float from 0.0 to 1.0)
    and `population_served` (int) based on node type, infrastructure tier, and geographic
    clustering across Miami neighborhoods:
      • High SVI (> 0.75) & High Population Density:
          - Little Haiti / Little River / Liberty City (lat >= 25.815, lon <= -80.185)
          - Overtown / Allapattah / Civic Center Medical District (25.780 <= lat < 25.815, lon <= -80.194)
          - Little Havana / Latin Quarter / Flagami (25.758 <= lat < 25.780, lon < -80.205)
      • Low SVI (< 0.30) & High Financial/Commercial Tier:
          - Brickell Financial District & Downtown Bayfront (25.752 <= lat <= 25.776, -80.196 <= lon <= -80.184)
          - Fisher Island / Miami Beach / Key Biscayne / Vizcaya / Coconut Grove Bayfront (lon > -80.180 or coastal SE)
      • Moderate SVI (0.35 - 0.68):
          - Midtown / Buena Vista / Coral Gables / Shenandoah / Douglas Road
    """
    name_lower = (name or "").lower()
    sector = (node_type or "energy").lower()
    is_primary = str(tier).lower() == "primary"

    # Deterministic spatial jitter in [-0.04, +0.04] derived from coordinates and facility name
    name_hash = sum((idx + 1) * ord(ch) for idx, ch in enumerate(name_lower))
    coord_seed = int(abs(round(lon * 10000)) + abs(round(lat * 10000)) + name_hash)
    svi_jitter = ((coord_seed % 17) - 8) * 0.005

    # 1. Geographic & Neighborhood Clustering in Miami
    if any(k in name_lower for k in ("borinquen", "overtown", "culmer", "little river", "jackson memorial", "jackson behavioral", "uhealth", "latin quarter", "lawrence", "leon medical")):
        # Historically underserved / high-density safety-net neighborhoods
        base_svi = 0.84
        base_pop = 58_000
    elif any(k in name_lower for k in ("brickell", "fisher island", "vizcaya", "miami beach", "equinix", "nap of the americas", "virginia key")):
        # Financial district, barrier islands, or commercial data/island hubs (low SVI, high tier)
        base_svi = 0.21
        base_pop = 19_500
    elif lat >= 25.815 and lon <= -80.185:
        # Little Haiti / Little River / Liberty City corridor
        base_svi = 0.86
        base_pop = 54_000
    elif 25.780 <= lat < 25.815 and lon <= -80.194:
        # Overtown / Allapattah / Civic Center
        base_svi = 0.82
        base_pop = 62_000
    elif 25.758 <= lat < 25.780 and lon < -80.205:
        # Little Havana / Flagami / West Flagler
        base_svi = 0.79
        base_pop = 51_000
    elif (25.752 <= lat <= 25.778 and -80.196 <= lon <= -80.182) or lon > -80.175:
        # Brickell Financial District / Downtown / Coastal Islands
        base_svi = 0.22
        base_pop = 21_000
    elif lat < 25.752 and lon > -80.225:
        # Coconut Grove Bayfront / Vizcaya / Mercy coastal corridor
        base_svi = 0.26
        base_pop = 24_000
    else:
        # Midtown / Coral Gables / Shenandoah / Douglas / Buena Vista transitional zones
        base_svi = 0.52
        base_pop = 34_000

    # 2. Sector & Tier Adjustments
    sector_svi_delta = {
        "health": 0.04,     # Safety-net hospitals & community clinics serve acute vulnerable populations
        "water": 0.02,      # Municipal water/wastewater lifelines
        "transport": 0.02,  # Public transit stations serve transit-dependent residents
        "energy": 0.00,
        "comms": -0.02,
    }.get(sector, 0.0)

    sector_pop_mult = {
        "water": 1.35,
        "health": 1.25,
        "energy": 1.15,
        "comms": 1.05,
        "transport": 0.90,
    }.get(sector, 1.0)

    tier_pop_mult = 1.38 if is_primary else 0.82
    pop_jitter = ((coord_seed % 23) - 11) * 650

    svi_score = round(min(0.98, max(0.08, base_svi + sector_svi_delta + svi_jitter)), 2)
    population_served = max(4_500, int(round((base_pop * sector_pop_mult * tier_pop_mult + pop_jitter) / 100.0) * 100))
    return svi_score, population_served


def ensure_balanced_sector_hierarchy(nodes: list[dict[str, Any]]) -> None:
    """
    Ensures every infrastructure sector has both Primary (trunk/high-capacity) and
    Secondary (local distribution) nodes so hierarchical flow routing is always well-posed,
    and computes procedural demographic attributes (`social_vulnerability_index`, `population_served`).
    """
    by_type: dict[str, list[dict[str, Any]]] = {}
    for n in nodes:
        by_type.setdefault(n["type"], []).append(n)

    default_primary_caps = {"energy": 6, "water": 5, "transport": 5, "comms": 5, "health": 2}
    default_secondary_caps = {"energy": 2, "water": 2, "transport": 2, "comms": 2, "health": 1}

    for sector, sector_nodes in by_type.items():
        if len(sector_nodes) < 2:
            continue
        primaries = [n for n in sector_nodes if n.get("tier") == "Primary"]
        secondaries = [n for n in sector_nodes if n.get("tier") == "Secondary"]

        # Sort by voltage_kv then area_sqm descending
        ranked = sorted(
            sector_nodes,
            key=lambda item: (float(item.get("voltage_kv", 0.0)), float(item.get("area_sqm", 0.0))),
            reverse=True,
        )
        target_primary_count = max(2, len(sector_nodes) // 2)

        if not primaries:
            for n in ranked[:target_primary_count]:
                n["tier"] = "Primary"
                n["capacity"] = default_primary_caps.get(sector, 5)
        elif not secondaries:
            for n in ranked[target_primary_count:]:
                n["tier"] = "Secondary"
                n["capacity"] = default_secondary_caps.get(sector, 2)

    for n in nodes:
        svi_val, pop_val = compute_demographic_profile(
            name=str(n.get("name", "")),
            node_type=str(n.get("type", "energy")),
            tier=str(n.get("tier", "Secondary")),
            lon=float(n.get("x", -80.205)),
            lat=float(n.get("y", 25.778)),
        )
        n["social_vulnerability_index"] = svi_val
        n["population_served"] = pop_val


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
    Downloads the physical street network for Miami, Florida using OSMnx.
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
    retaining named facilities with spatial separation and computing Task 1 hierarchy
    (tier, capacity, voltage_kv, area_sqm, battery_backup_hours) and Climate Justice
    demographic attributes (social_vulnerability_index, population_served).
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

        area_sqm = _estimate_footprint_area_sqm(geom, lat)
        hierarchy_meta = assign_node_tier_and_capacity(node_type, clean_name, row, area_sqm)

        seen_names.add(clean_name)
        type_counts[node_type] = type_counts.get(node_type, 0) + 1

        nodes.append(
            {
                "name": clean_name,
                "type": node_type,
                "x": lon,
                "y": lat,
                **hierarchy_meta,
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

    ensure_balanced_sector_hierarchy(nodes)
    return nodes


def snap_facilities_to_street_grid(
    street_graph: nx.MultiDiGraph,
    nodes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Uses osmnx.nearest_nodes to snap each critical infrastructure facility's
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
    Calculates the shortest physical street network path and length (in meters)
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


def wire_sector_with_min_cost_flow(
    street_graph: nx.MultiDiGraph,
    undirected_street: nx.MultiGraph,
    graph: nx.DiGraph,
    suppliers: list[dict[str, Any]],
    consumers: list[dict[str, Any]],
    dependency_type: str,
    remaining_global_capacity: dict[str, int],
    is_cyclic_fallback: bool = False,
) -> None:
    """
    Task 3: Wires directed dependency edges from `suppliers` to `consumers` using
    `networkx.min_cost_flow` over physical OSM street routing distances while strictly
    enforcing supplier out-degree / flow capacity limits (`capacity`).

    Guarantees:
      • Every consumer receives its required incoming lifeline of `dependency_type`.
      • A single Secondary supplier (capacity=2) can NEVER supply 5 large hospitals
        (per-sector Secondary cap is at most 1 for health, and bounded by remaining_global_capacity).
      • Total physical street routing distance + hierarchical tier penalties are globally minimized.
    """
    valid_consumers = [c for c in consumers if c["name"] in graph]
    valid_suppliers = [s for s in suppliers if s["name"] in graph]
    if not valid_consumers or not valid_suppliers:
        return

    num_consumers = len(valid_consumers)

    # Compute per-supplier capacity allocation for this dependency layer
    # Secondary nodes are strictly limited (max 1 hospital or max 2 other facilities)
    supplier_caps: dict[str, int] = {}
    for s in valid_suppliers:
        s_name = s["name"]
        tier = str(s.get("tier", "Secondary"))
        base_cap = int(s.get("capacity", 6 if tier == "Primary" else 2))
        rem_cap = max(1, remaining_global_capacity.get(s_name, base_cap))
        if tier == "Secondary":
            sector_cap = 1 if dependency_type == "energy" and valid_consumers[0].get("type") == "health" else min(2, rem_cap)
        else:
            sector_cap = min(base_cap, max(2, rem_cap))
        supplier_caps[s_name] = max(1, sector_cap)

    # Ensure total available capacity across suppliers is at least num_consumers so min_cost_flow is feasible
    total_cap = sum(supplier_caps.values())
    if total_cap < num_consumers:
        primaries = [s["name"] for s in valid_suppliers if s.get("tier") == "Primary"] or [
            s["name"] for s in valid_suppliers
        ]
        idx = 0
        while total_cap < num_consumers:
            p_name = primaries[idx % len(primaries)]
            supplier_caps[p_name] += 1
            total_cap += 1
            idx += 1

    flow_net = nx.DiGraph()
    super_source = "__super_source__"
    flow_net.add_node(super_source, demand=-num_consumers)

    for s in valid_suppliers:
        s_key = f"sup::{s['name']}"
        tier_cost = 0 if s.get("tier") == "Primary" else 350
        flow_net.add_node(s_key, demand=0)
        flow_net.add_edge(
            super_source,
            s_key,
            capacity=supplier_caps[s["name"]],
            weight=tier_cost,
        )

    route_cache: dict[tuple[str, str], tuple[float, list[int]]] = {}

    for c in valid_consumers:
        c_key = f"con::{c['name']}"
        flow_net.add_node(c_key, demand=1)
        c_street_id = int(c["street_node_id"])

        for s in valid_suppliers:
            if s["name"] == c["name"]:
                continue
            s_key = f"sup::{s['name']}"
            s_street_id = int(s["street_node_id"])

            dist_m, path_nodes = compute_street_route(
                street_graph,
                undirected_street,
                source_street_id=s_street_id,
                target_street_id=c_street_id,
            )
            if not np.isfinite(dist_m):
                dist_m = float(
                    np.hypot(s["x"] - c["x"], s["y"] - c["y"]) * 111_139.0
                )
                path_nodes = [s_street_id, c_street_id]

            route_cache[(s["name"], c["name"])] = (round(dist_m, 2), path_nodes)

            # Prefer Primary suppliers for Primary consumers
            tier_penalty = (
                600
                if (c.get("tier") == "Primary" and s.get("tier") == "Secondary")
                else 0
            )
            arc_cost = max(1, int(round(dist_m)) + tier_penalty)
            flow_net.add_edge(s_key, c_key, capacity=1, weight=arc_cost)

    try:
        flow_solution = nx.min_cost_flow(flow_net)
    except nx.NetworkXUnfeasible:
        # Fallback: relax super_source -> supplier capacities by +1 if isolated graph components exist
        for s in valid_suppliers:
            s_key = f"sup::{s['name']}"
            flow_net[super_source][s_key]["capacity"] += 2
        flow_solution = nx.min_cost_flow(flow_net)

    supplier_lookup = {s["name"]: s for s in valid_suppliers}
    consumer_lookup = {c["name"]: c for c in valid_consumers}

    for s in valid_suppliers:
        s_name = s["name"]
        s_key = f"sup::{s_name}"
        out_flows = flow_solution.get(s_key, {})
        for c_key, flow_val in out_flows.items():
            if flow_val <= 0 or not c_key.startswith("con::"):
                continue
            c_name = c_key.split("con::", 1)[1]
            dist_m, path_nodes = route_cache[(s_name, c_name)]
            s_node = supplier_lookup[s_name]
            c_node = consumer_lookup[c_name]

            graph.add_edge(
                s_name,
                c_name,
                dependency_type=dependency_type,
                routing_distance=dist_m,
                path_nodes=path_nodes,
                flow_capacity=int(s_node.get("capacity", 3)),
                supplier_tier=str(s_node.get("tier", "Secondary")),
                consumer_tier=str(c_node.get("tier", "Secondary")),
                is_cyclic_fallback=is_cyclic_fallback,
                temporal_buffer_hours=float(c_node.get("battery_backup_hours", 24.0)),
            )
            remaining_global_capacity[s_name] = max(
                0, remaining_global_capacity.get(s_name, int(s_node.get("capacity", 3))) - 1
            )


def wire_intra_sector_hierarchy(
    street_graph: nx.MultiDiGraph,
    undirected_street: nx.MultiGraph,
    graph: nx.DiGraph,
    sector_nodes: list[dict[str, Any]],
    dependency_type: str,
    remaining_global_capacity: dict[str, int],
) -> None:
    """
    Wires Primary trunk nodes (e.g., high-voltage substations, main water treatment plants)
    to Secondary distribution nodes (e.g., local transformers, pump stations) using
    capacity-constrained minimum-cost flow, plus a resilient Primary-to-Primary ring.
    """
    primaries = [n for n in sector_nodes if n.get("tier") == "Primary"]
    secondaries = [n for n in sector_nodes if n.get("tier") == "Secondary"]

    if primaries and secondaries:
        wire_sector_with_min_cost_flow(
            street_graph=street_graph,
            undirected_street=undirected_street,
            graph=graph,
            suppliers=primaries,
            consumers=secondaries,
            dependency_type=dependency_type,
            remaining_global_capacity=remaining_global_capacity,
            is_cyclic_fallback=False,
        )

    # Connect Primary trunk nodes in a directed acyclic backbone chain along the shortest street path
    if len(primaries) >= 2:
        for idx in range(len(primaries) - 1):
            p_src = primaries[idx]
            p_tgt = primaries[idx + 1]
            if p_src["name"] == p_tgt["name"] or graph.has_edge(p_src["name"], p_tgt["name"]):
                continue
            dist_m, path_nodes = compute_street_route(
                street_graph,
                undirected_street,
                source_street_id=int(p_src["street_node_id"]),
                target_street_id=int(p_tgt["street_node_id"]),
            )
            if not np.isfinite(dist_m):
                dist_m = float(np.hypot(p_src["x"] - p_tgt["x"], p_src["y"] - p_tgt["y"]) * 111_139.0)
                path_nodes = [int(p_src["street_node_id"]), int(p_tgt["street_node_id"])]
            graph.add_edge(
                p_src["name"],
                p_tgt["name"],
                dependency_type=dependency_type,
                routing_distance=round(dist_m, 2),
                path_nodes=path_nodes,
                flow_capacity=int(p_src.get("capacity", 6)),
                supplier_tier="Primary",
                consumer_tier="Primary",
                is_cyclic_fallback=False,
                temporal_buffer_hours=float(p_tgt.get("battery_backup_hours", 48.0)),
            )


def build_street_dependency_graph(
    street_graph: nx.MultiDiGraph,
    nodes: list[dict[str, Any]],
) -> nx.DiGraph:
    """
    Tasks 1, 2 & 3: Builds a hierarchical, capacity-constrained directed NetworkX dependency
    graph routed through the real Miami street network using `nx.min_cost_flow`:
      • Task 1: Every node carries `tier` ('Primary' | 'Secondary'), `capacity`,
                `voltage_kv`, `area_sqm`, and `battery_backup_hours`.
      • Task 2: Enforces the Realistic Interdependency Matrix:
                - Hospitals (`health`) MUST receive `energy`, `water`, and `comms`.
                - Electricity plants/substations (`energy`) ONLY receive incoming connections from
                  other `energy` plants (`energy -> energy`) to supply downstream facilities/homes.
                - `water`, `comms`, and `transport` receive electricity from `energy`.
      • Task 3: Uses `networkx.min_cost_flow` over OSM street routing distances so no Secondary
                node is overloaded (e.g. a secondary transformer can never supply 5 hospitals).
    """
    graph = nx.DiGraph()
    undirected_street = street_graph.to_undirected()

    nodes_by_type: dict[str, list[dict[str, Any]]] = {
        "energy": [],
        "water": [],
        "health": [],
        "transport": [],
        "comms": [],
    }
    remaining_global_capacity: dict[str, int] = {}

    for node in nodes:
        n_type = str(node["type"])
        tier = str(node.get("tier", "Secondary"))
        cap = int(node.get("capacity", 6 if tier == "Primary" else 2))
        backup_h = float(node.get("battery_backup_hours", 48.0 if tier == "Primary" else 24.0))
        if "social_vulnerability_index" in node and "population_served" in node:
            svi_val = float(node["social_vulnerability_index"])
            pop_val = int(node["population_served"])
        else:
            svi_val, pop_val = compute_demographic_profile(
                name=str(node["name"]),
                node_type=n_type,
                tier=tier,
                lon=float(node["x"]),
                lat=float(node["y"]),
            )

        graph.add_node(
            node["name"],
            type=n_type,
            x=float(node["x"]),
            y=float(node["y"]),
            tier=tier,
            capacity=cap,
            battery_backup_hours=backup_h,
            social_vulnerability_index=svi_val,
            population_served=pop_val,
            voltage_kv=float(node.get("voltage_kv", 0.0)),
            area_sqm=float(node.get("area_sqm", 0.0)),
            street_node_id=int(node["street_node_id"]),
        )
        nodes_by_type.setdefault(n_type, []).append(node)
        # Scale global cross-sector capacity budget by tier (Primary: 2x base, Secondary: base)
        remaining_global_capacity[node["name"]] = cap * 2 if tier == "Primary" else cap + 1

    # 1. Wire Intra-Sector Primary -> Secondary Hierarchies (Transmission -> Distribution)
    #    For energy: Primary power plants/substations -> Secondary substations, plus Primary ring
    for sector in ("energy", "water", "comms"):
        if len(nodes_by_type.get(sector, [])) >= 2:
            wire_intra_sector_hierarchy(
                street_graph=street_graph,
                undirected_street=undirected_street,
                graph=graph,
                sector_nodes=nodes_by_type[sector],
                dependency_type=sector,
                remaining_global_capacity=remaining_global_capacity,
            )

    # 2. Wire Cross-Sector Interdependency Matrix using capacity-constrained nx.min_cost_flow
    for supplier_sector, consumer_sector, is_cyclic in INTERDEPENDENCY_MATRIX:
        suppliers = nodes_by_type.get(supplier_sector, [])
        consumers = nodes_by_type.get(consumer_sector, [])
        if not suppliers or not consumers:
            continue

        wire_sector_with_min_cost_flow(
            street_graph=street_graph,
            undirected_street=undirected_street,
            graph=graph,
            suppliers=suppliers,
            consumers=consumers,
            dependency_type=supplier_sector,
            remaining_global_capacity=remaining_global_capacity,
            is_cyclic_fallback=is_cyclic,
        )

    return graph


def build_full_miami_street_topology() -> nx.DiGraph:
    """
    Synchronous pipeline executed in a worker thread:
      1. Downloads Miami drive street network (`ox.graph_from_place`).
      2. Extracts critical OSM facilities (`ox.features_from_place`) with Task 1 Tier & Capacity.
      3. Snaps facilities to the closest street intersections (`ox.nearest_nodes`).
      4. Computes capacity-constrained minimum-cost flow dependency edges (`nx.min_cost_flow`).
    """
    street_graph = fetch_street_network()
    osm_nodes = extract_osm_miami_nodes()
    snapped_nodes = snap_facilities_to_street_grid(street_graph, osm_nodes)
    return build_street_dependency_graph(street_graph, snapped_nodes)


async def seed_miami_database() -> None:
    """
    Clears existing Node and Edge tables and persists all OSM-extracted
    Miami nodes (with tier, capacity, battery_backup_hours, social_vulnerability_index,
    and population_served) and capacity-constrained street-routed dependency edges into PostgreSQL.
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
            text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tier VARCHAR(30) DEFAULT 'Secondary';")
        )
        await conn.execute(
            text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS capacity INTEGER DEFAULT 3;")
        )
        await conn.execute(
            text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS battery_backup_hours DOUBLE PRECISION DEFAULT 24.0;")
        )
        await conn.execute(
            text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS social_vulnerability_index DOUBLE PRECISION DEFAULT 0.5;")
        )
        await conn.execute(
            text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS population_served INTEGER DEFAULT 25000;")
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
                initial_cap = max(
                    int(attrs.get("capacity", 3)),
                    int(graph.out_degree(node_name)),
                )
                node_obj = Node(
                    name=str(node_name),
                    type=str(attrs.get("type", "energy")),
                    x=float(attrs.get("x", 0.0)),
                    y=float(attrs.get("y", 0.0)),
                    tier=str(attrs.get("tier", "Secondary")),
                    capacity=initial_cap,
                    battery_backup_hours=float(attrs.get("battery_backup_hours", 24.0)),
                    social_vulnerability_index=float(attrs.get("social_vulnerability_index", 0.5)),
                    population_served=int(attrs.get("population_served", 25000)),
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
        tier_counts: dict[str, int] = {"Primary": 0, "Secondary": 0}
        for _, d in graph.nodes(data=True):
            t = str(d.get("type", "unknown"))
            tier = str(d.get("tier", "Secondary"))
            counts[t] = counts.get(t, 0) + 1
            tier_counts[tier] = tier_counts.get(tier, 0) + 1

        print(
            f"Successfully seeded {graph.number_of_nodes()} OSM Miami nodes {counts} "
            f"(Tiers: {tier_counts}) and {graph.number_of_edges()} capacity-constrained "
            f"street-routed dependency edges into PostgreSQL."
        )

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed_miami_database())
