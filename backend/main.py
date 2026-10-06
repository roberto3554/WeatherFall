from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import json
import os
from typing import Any

import networkx as nx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

try:
    from .agent import evaluate_node_failure
    from .database import get_db, init_db
    from .models import Edge, Node, SimulationTrace
    from .schemas import NodeState, SimulationRequest
except ImportError:
    from agent import evaluate_node_failure
    from database import get_db, init_db
    from models import Edge, Node, SimulationTrace
    from schemas import NodeState, SimulationRequest


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Ensure database tables exist on application startup."""
    try:
        await init_db()
    except Exception:
        pass
    yield


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

app = FastAPI(
    title="WeatherFall API",
    description="AI-driven climate risk cascade simulation API.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


def build_base_infrastructure_graph() -> nx.DiGraph:
    """
    Initializes a static NetworkX DiGraph representing core city infrastructure
    with at least 6 interconnected nodes and their 'type' attributes.
    """
    graph = nx.DiGraph()

    nodes: list[tuple[str, dict[str, str]]] = [
        ("Power Grid", {"type": "energy"}),
        ("Substation Alpha", {"type": "energy"}),
        ("Water Pump", {"type": "water"}),
        ("Wastewater Plant", {"type": "water"}),
        ("Telecom Tower", {"type": "comms"}),
        ("Emergency Dispatch", {"type": "public_safety"}),
        ("City Hospital", {"type": "healthcare"}),
        ("Regional Data Center", {"type": "it"}),
    ]
    graph.add_nodes_from(nodes)

    edges: list[tuple[str, str]] = [
        ("Power Grid", "Substation Alpha"),
        ("Power Grid", "Water Pump"),
        ("Power Grid", "Telecom Tower"),
        ("Substation Alpha", "City Hospital"),
        ("Substation Alpha", "Regional Data Center"),
        ("Water Pump", "City Hospital"),
        ("Water Pump", "Wastewater Plant"),
        ("Telecom Tower", "Emergency Dispatch"),
        ("Telecom Tower", "Regional Data Center"),
        ("Emergency Dispatch", "City Hospital"),
        ("Regional Data Center", "Emergency Dispatch"),
    ]
    graph.add_edges_from(edges)

    return graph


async def load_infrastructure_graph(db: AsyncSession) -> nx.DiGraph:
    """
    Initializes the base NetworkX DiGraph and enriches it with any additional
    nodes and directed edges stored in PostgreSQL.
    """
    graph = build_base_infrastructure_graph()

    try:
        nodes_result = await db.execute(select(Node))
        db_nodes = list(nodes_result.scalars().all())
        if not db_nodes:
            return graph

        edges_result = await db.execute(select(Edge))
        db_edges = list(edges_result.scalars().all())

        id_to_name: dict[int, str] = {}
        for node in db_nodes:
            id_to_name[node.id] = node.name
            graph.add_node(node.name, id=node.id, type=node.type)

        for edge in db_edges:
            source_name = id_to_name.get(edge.source_node_id)
            target_name = id_to_name.get(edge.target_node_id)
            if source_name and target_name:
                graph.add_edge(source_name, target_name)

        # Bridge base 'Power Grid' and seeded 'Main Power Grid' if both exist
        if "Main Power Grid" in graph and "Power Grid" in graph:
            graph.add_edge("Power Grid", "Main Power Grid")

    except Exception:
        pass

    return graph


@app.get("/")
async def serve_index() -> FileResponse:
    """Serves the frontend index.html application."""
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/api/v1/topology")
async def get_topology(db: AsyncSession = Depends(get_db)) -> dict[str, list[dict[str, str]]]:
    """Returns the city infrastructure graph (nodes and edges) for frontend visualization."""
    graph = await load_infrastructure_graph(db)

    nodes_list = [
        {
            "id": str(node),
            "name": str(node),
            "label": str(node),
            "type": str(data.get("type", "unknown")),
            "group": str(data.get("type", "unknown")),
        }
        for node, data in graph.nodes(data=True)
    ]
    edges_list = [
        {
            "source": str(source),
            "target": str(target),
            "from": str(source),
            "to": str(target),
        }
        for source, target in graph.edges()
    ]
    return {"nodes": nodes_list, "edges": edges_list}


@app.post("/api/v1/simulate", response_model=list[NodeState])
async def simulate_cascade(
    request: SimulationRequest,
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Executes an async Breadth-First Search (BFS) cascade simulation starting from
    `epicenter_node`, evaluates downstream nodes with Groq LLM, persists the JSON
    trace to PostgreSQL, and returns the execution trace.
    """
    # Task 1: Initialize the NetworkX DiGraph with typed infrastructure nodes
    graph: nx.DiGraph = await load_infrastructure_graph(db)

    if request.epicenter_node not in graph:
        valid_nodes = list(graph.nodes)
        raise HTTPException(
            status_code=404,
            detail=(
                f"Epicenter node '{request.epicenter_node}' not found in infrastructure graph. "
                f"Available nodes: {valid_nodes}"
            ),
        )

    # Task 2: Initialize BFS queue starting at epicenter_node (assumed failed: status=False)
    bfs_queue: deque[str] = deque([request.epicenter_node])
    visited: set[str] = {request.epicenter_node}

    epicenter_type = str(graph.nodes[request.epicenter_node].get("type", "unknown"))
    execution_trace: list[dict[str, Any]] = [
        {
            "parent_node": None,
            "child_node": request.epicenter_node,
            "node_name": request.epicenter_node,
            "node_type": epicenter_type,
            "status": False,
            "reasoning": (
                f"Epicenter node '{request.epicenter_node}' failed directly due to {request.disaster_type}."
            ),
        }
    ]

    while bfs_queue:
        parent_name = bfs_queue.popleft()

        for child_name in graph.successors(parent_name):
            # Prevent infinite loops in cyclic infrastructure graphs
            if child_name in visited:
                continue
            visited.add(child_name)

            child_type = str(graph.nodes[child_name].get("type", "unknown"))

            try:
                evaluation = await evaluate_node_failure(
                    node_name=child_name,
                    node_type=child_type,
                    parent_name=parent_name,
                    disaster_type=request.disaster_type,
                )
            except ValueError as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc

            child_status = bool(evaluation["status"])
            reasoning = str(evaluation["reasoning"])

            execution_trace.append(
                {
                    "parent_node": parent_name,
                    "child_node": child_name,
                    "node_name": child_name,
                    "node_type": child_type,
                    "status": child_status,
                    "reasoning": reasoning,
                }
            )

            # Only continue the cascade down this branch if the child node failed (status == False)
            if child_status is False:
                bfs_queue.append(child_name)

    # Task 3: Serialize execution_trace to JSON and persist in PostgreSQL SimulationTrace
    serialized_trace: str = json.dumps(execution_trace)

    try:
        trace_record = SimulationTrace(
            disaster_type=request.disaster_type,
            epicenter_node=request.epicenter_node,
            trace_data=json.loads(serialized_trace),
        )
        db.add(trace_record)
        await db.commit()
    except Exception as exc:
        await db.rollback()
        print(f"[WARNING] Failed to persist SimulationTrace to PostgreSQL: {exc}")

    return execution_trace


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
