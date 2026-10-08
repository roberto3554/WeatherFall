import asyncio
from typing import Any
from sqlalchemy import delete, text

try:
    from .database import AsyncSessionLocal, engine, init_db
    from .models import Edge, Node, SimulationTrace
except ImportError:
    from database import AsyncSessionLocal, engine, init_db
    from models import Edge, Node, SimulationTrace


# Real-world Miami, Florida critical infrastructure topology (12 nodes with x, y coordinates)
MIAMI_NODES: list[dict[str, Any]] = [
    {
        "name": "Turkey Point Nuclear Generating Station",
        "type": "power",
        "x": -200.0,
        "y": 300.0,
    },
    {
        "name": "FPL Dania Beach Clean Energy Center",
        "type": "power",
        "x": -80.0,
        "y": -260.0,
    },
    {
        "name": "Downtown Miami Substation",
        "type": "power",
        "x": 0.0,
        "y": 0.0,
    },
    {
        "name": "Brickell Underground Vault Substation",
        "type": "power",
        "x": 35.0,
        "y": 95.0,
    },
    {
        "name": "Alexander Orr Jr. Water Treatment Plant",
        "type": "water",
        "x": -180.0,
        "y": 130.0,
    },
    {
        "name": "Virginia Key Wastewater Treatment Plant",
        "type": "water",
        "x": 190.0,
        "y": 120.0,
    },
    {
        "name": "Miami Beach Stormwater Pump Station #1",
        "type": "water",
        "x": 220.0,
        "y": -70.0,
    },
    {
        "name": "NAP of the Americas (Equinix MI1)",
        "type": "comms",
        "x": 20.0,
        "y": -55.0,
    },
    {
        "name": "Miami-Dade 911 Emergency Operations Center",
        "type": "safety",
        "x": -210.0,
        "y": -110.0,
    },
    {
        "name": "Jackson Memorial Hospital",
        "type": "health",
        "x": -50.0,
        "y": -20.0,
    },
    {
        "name": "PortMiami Logistics Hub",
        "type": "transport",
        "x": 100.0,
        "y": 50.0,
    },
    {
        "name": "Miami International Airport (MIA) Fuel & Airfield Grid",
        "type": "transport",
        "x": -160.0,
        "y": -40.0,
    },
]

# Directed dependency edges between real-world Miami infrastructure facilities
# Rules:
#   • Electricity plants/substations (power/energy) ONLY receive from other electricity plants/substations
#   • Hospitals (health) receive electricity, water, and communications
#   • Water, Comms, and Transport receive electricity from energy plants/substations
MIAMI_EDGES: list[tuple[str, str]] = [
    # Power Grid Hierarchy (Energy -> Energy)
    ("Turkey Point Nuclear Generating Station", "FPL Dania Beach Clean Energy Center"),
    ("FPL Dania Beach Clean Energy Center", "Turkey Point Nuclear Generating Station"),
    ("Turkey Point Nuclear Generating Station", "Downtown Miami Substation"),
    ("Turkey Point Nuclear Generating Station", "Brickell Underground Vault Substation"),
    ("FPL Dania Beach Clean Energy Center", "Downtown Miami Substation"),
    # Energy -> Water, Comms, Transport, Health
    ("Turkey Point Nuclear Generating Station", "Alexander Orr Jr. Water Treatment Plant"),
    ("FPL Dania Beach Clean Energy Center", "Miami International Airport (MIA) Fuel & Airfield Grid"),
    ("FPL Dania Beach Clean Energy Center", "Miami Beach Stormwater Pump Station #1"),
    ("Downtown Miami Substation", "Jackson Memorial Hospital"),
    ("Downtown Miami Substation", "PortMiami Logistics Hub"),
    ("Downtown Miami Substation", "NAP of the Americas (Equinix MI1)"),
    ("Downtown Miami Substation", "Miami-Dade 911 Emergency Operations Center"),
    ("Brickell Underground Vault Substation", "NAP of the Americas (Equinix MI1)"),
    ("Brickell Underground Vault Substation", "Virginia Key Wastewater Treatment Plant"),
    ("Brickell Underground Vault Substation", "PortMiami Logistics Hub"),
    # Water Hierarchy & Hospital Supply (Water -> Water, Water -> Health)
    ("Alexander Orr Jr. Water Treatment Plant", "Virginia Key Wastewater Treatment Plant"),
    ("Alexander Orr Jr. Water Treatment Plant", "Miami Beach Stormwater Pump Station #1"),
    ("Alexander Orr Jr. Water Treatment Plant", "Jackson Memorial Hospital"),
    # Telecommunications Supply (Comms -> Comms/Safety, Comms -> Health)
    ("NAP of the Americas (Equinix MI1)", "Miami-Dade 911 Emergency Operations Center"),
    ("NAP of the Americas (Equinix MI1)", "Jackson Memorial Hospital"),
]


async def seed_database() -> None:
    """Migrates schema columns if needed and seeds PostgreSQL with the Miami infrastructure graph."""
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

    async with AsyncSessionLocal() as session:
        async with session.begin():
            await session.execute(delete(Edge))
            await session.execute(delete(Node))

            node_objs: dict[str, Node] = {}
            for item in MIAMI_NODES:
                node_obj = Node(
                    name=item["name"],
                    type=item["type"],
                    x=item["x"],
                    y=item["y"],
                )
                session.add(node_obj)
                node_objs[item["name"]] = node_obj

            await session.flush()

            for source_name, target_name in MIAMI_EDGES:
                edge_obj = Edge(
                    source_node_id=node_objs[source_name].id,
                    target_node_id=node_objs[target_name].id,
                )
                session.add(edge_obj)

        print(
            f"Successfully seeded {len(MIAMI_NODES)} real-world Miami nodes and "
            f"{len(MIAMI_EDGES)} directed dependency edges into PostgreSQL."
        )

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed_database())
