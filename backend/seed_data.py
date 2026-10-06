import asyncio
from sqlalchemy import delete

try:
    from .database import AsyncSessionLocal, engine, init_db
    from .models import Edge, Node, SimulationTrace
except ImportError:
    from database import AsyncSessionLocal, engine, init_db
    from models import Edge, Node, SimulationTrace


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
    # Generation -> Main Grid & Regional Distribution
    ("Hydroelectric Dam", "Main Power Grid"),
    ("Hydroelectric Dam", "Water Treatment Plant"),
    ("Natural Gas Power Plant", "Main Power Grid"),
    ("Natural Gas Power Plant", "South Substation"),
    # Main Grid -> Substations & Core Utilities
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
    # Water & Sanitation Cascade
    ("Water Treatment Plant", "Municipal Pumping Station"),
    ("Water Treatment Plant", "City Hospital"),
    ("Water Treatment Plant", "Cold Storage Logistics Hub"),
    ("Municipal Pumping Station", "Wastewater Facility"),
    ("Municipal Pumping Station", "Community Clinic"),
    ("Wastewater Facility", "Water Treatment Plant"),
    # Telecom & IT Cascade
    ("5G Telecom Tower", "City Hospital"),
    ("5G Telecom Tower", "Emergency Dispatch Center"),
    ("5G Telecom Tower", "Traffic Management Grid"),
    ("5G Telecom Tower", "Regional Data Center"),
    ("Regional Data Center", "Emergency Dispatch Center"),
    ("Regional Data Center", "Metro Rail Control"),
    ("Regional Data Center", "Cold Storage Logistics Hub"),
    # Public Safety, Healthcare & Transport Cascade
    ("Emergency Dispatch Center", "City Hospital"),
    ("Emergency Dispatch Center", "Community Clinic"),
    ("Emergency Dispatch Center", "Traffic Management Grid"),
    ("Traffic Management Grid", "Emergency Dispatch Center"),
    ("Traffic Management Grid", "Cold Storage Logistics Hub"),
    ("Metro Rail Control", "Traffic Management Grid"),
    ("City Hospital", "Community Clinic"),
]


SAMPLE_TRACES: list[dict] = [
    {
        "disaster_type": "Category 5 Hurricane",
        "epicenter_node": "Hydroelectric Dam",
        "trace_data": [
            {
                "node_name": "Hydroelectric Dam",
                "status": False,
                "reasoning": "Direct Category 5 Hurricane impact overwhelmed Hydroelectric Dam primary structural and operational thresholds.",
            },
            {
                "node_name": "Main Power Grid",
                "status": False,
                "reasoning": "Failure of Hydroelectric Dam during Category 5 Hurricane starved Main Power Grid (Energy Transmission) of critical supply.",
            },
            {
                "node_name": "Water Treatment Plant",
                "status": False,
                "reasoning": "Failure of Hydroelectric Dam during Category 5 Hurricane starved Water Treatment Plant (Water & Sanitation) of critical supply.",
            },
            {
                "node_name": "North Substation",
                "status": False,
                "reasoning": "Failure of Main Power Grid during Category 5 Hurricane starved North Substation (Power Distribution) of critical supply.",
            },
            {
                "node_name": "South Substation",
                "status": False,
                "reasoning": "Failure of Main Power Grid during Category 5 Hurricane starved South Substation (Power Distribution) of critical supply.",
            },
            {
                "node_name": "5G Telecom Tower",
                "status": False,
                "reasoning": "Failure of Main Power Grid during Category 5 Hurricane starved 5G Telecom Tower (Telecommunications) of critical supply.",
            },
            {
                "node_name": "City Hospital",
                "status": True,
                "reasoning": "City Hospital survived loss of Water Treatment Plant by engaging isolated diesel generators and satellite link.",
            },
        ],
    }
]


async def seed_database() -> None:
    """Initializes schema and populates the database with the 16-node urban topology and sample traces."""
    await init_db()

    async with AsyncSessionLocal() as session:
        async with session.begin():
            # Clear existing topology for idempotent re-seeding
            await session.execute(delete(Edge))
            await session.execute(delete(Node))
            await session.execute(delete(SimulationTrace))

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

            for sample in SAMPLE_TRACES:
                session.add(
                    SimulationTrace(
                        disaster_type=sample["disaster_type"],
                        epicenter_node=sample["epicenter_node"],
                        trace_data=sample["trace_data"],
                    )
                )

        print(
            f"Successfully seeded {len(INITIAL_NODES)} nodes, "
            f"{len(INITIAL_EDGES)} directed edges, and "
            f"{len(SAMPLE_TRACES)} sample simulation traces into PostgreSQL."
        )

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed_database())
