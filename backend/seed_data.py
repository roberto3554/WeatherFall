import asyncio
from sqlalchemy import delete

try:
    from .database import AsyncSessionLocal, engine, init_db
    from .models import Edge, Node
except ImportError:
    from database import AsyncSessionLocal, engine, init_db
    from models import Edge, Node


# 16 interconnected urban infrastructure nodes across critical sectors
INITIAL_NODES: list[tuple[str, str]] = [
    ("Hydroelectric Dam", "Energy Generation"),
    ("Natural Gas Power Plant", "Energy Generation"),
    ("Main Power Grid", "Energy Transmission"),
    ("North Substation", "Power Distribution"),
    ("South Substation", "Power Distribution"),
    ("Water Treatment Plant", "Water & Sanitation"),
    ("Municipal Pumping Station", "Water & Sanitation"),
    ("Wastewater Facility", "Water & Sanitation"),
    ("5G Telecom Tower", "Telecommunications"),
    ("Regional Data Center", "IT & Cloud Infrastructure"),
    ("Emergency Dispatch Center", "Public Safety"),
    ("City Hospital", "Healthcare"),
    ("Community Clinic", "Healthcare"),
    ("Metro Rail Control", "Transportation"),
    ("Traffic Management Grid", "Transportation"),
    ("Cold Storage Logistics Hub", "Supply Chain"),
]

# Directed dependency edges: (source_node_name, target_node_name)
INITIAL_EDGES: list[tuple[str, str]] = [
    # Generation -> Main Grid
    ("Hydroelectric Dam", "Main Power Grid"),
    ("Natural Gas Power Plant", "Main Power Grid"),
    # Main Grid -> Substations & Heavy Infrastructure
    ("Main Power Grid", "North Substation"),
    ("Main Power Grid", "South Substation"),
    ("Main Power Grid", "Water Treatment Plant"),
    ("Main Power Grid", "5G Telecom Tower"),
    # North Substation -> Downstream Dependents
    ("North Substation", "Regional Data Center"),
    ("North Substation", "Metro Rail Control"),
    ("North Substation", "City Hospital"),
    # South Substation -> Downstream Dependents
    ("South Substation", "Municipal Pumping Station"),
    ("South Substation", "Cold Storage Logistics Hub"),
    ("South Substation", "Community Clinic"),
    # Water Infrastructure Cascade
    ("Water Treatment Plant", "Municipal Pumping Station"),
    ("Water Treatment Plant", "City Hospital"),
    ("Municipal Pumping Station", "Wastewater Facility"),
    ("Municipal Pumping Station", "Community Clinic"),
    # Telecom & IT Cascade
    ("5G Telecom Tower", "City Hospital"),
    ("5G Telecom Tower", "Emergency Dispatch Center"),
    ("5G Telecom Tower", "Traffic Management Grid"),
    ("Regional Data Center", "Emergency Dispatch Center"),
    ("Regional Data Center", "Metro Rail Control"),
    # Public Safety & Transport Cascade
    ("Emergency Dispatch Center", "City Hospital"),
    ("Traffic Management Grid", "Emergency Dispatch Center"),
]


async def seed_database() -> None:
    """Initializes schema and populates the database with the 16-node urban topology."""
    await init_db()

    async with AsyncSessionLocal() as session:
        async with session.begin():
            # Clear existing topology for idempotent re-seeding
            await session.execute(delete(Edge))
            await session.execute(delete(Node))

            node_objs: dict[str, Node] = {}
            for name, node_type in INITIAL_NODES:
                node_obj = Node(name=name, type=node_type)
                session.add(node_obj)
                node_objs[name] = node_obj

            # Flush to assign primary key IDs to all nodes
            await session.flush()

            for source_name, target_name in INITIAL_EDGES:
                edge_obj = Edge(
                    source_node_id=node_objs[source_name].id,
                    target_node_id=node_objs[target_name].id,
                )
                session.add(edge_obj)

        print(
            f"Successfully seeded {len(INITIAL_NODES)} nodes and "
            f"{len(INITIAL_EDGES)} directed edges into PostgreSQL."
        )

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed_database())
