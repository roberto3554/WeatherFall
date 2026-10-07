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
    from .seed_data import MIAMI_EDGES, MIAMI_NODES
except ImportError:
    from agent import evaluate_node_failure
    from database import get_db, init_db
    from models import Edge, Node, SimulationTrace
    from schemas import NodeState, SimulationRequest
    from seed_data import MIAMI_EDGES, MIAMI_NODES


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
    description="AI-driven climate risk cascade simulation API (Miami Infrastructure Edition).",
    version="1.1.0",
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
    Initializes a static NetworkX DiGraph representing real-world Miami infrastructure
    with node types and spatial (x, y) coordinates.
    """
    graph = nx.DiGraph()

    for item in MIAMI_NODES:
        graph.add_node(
            item["name"],
            type=item["type"],
            x=item["x"],
            y=item["y"],
        )

    graph.add_edges_from(MIAMI_EDGES)
    return graph


async def load_infrastructure_graph(db: AsyncSession) -> nx.DiGraph:
    """
    Loads the city infrastructure graph from PostgreSQL into a NetworkX DiGraph,
    falling back to the default Miami graph if the database is empty or unreachable.
    """
    try:
        nodes_result = await db.execute(select(Node))
        db_nodes = list(nodes_result.scalars().all())
        if not db_nodes:
            return build_base_infrastructure_graph()

        edges_result = await db.execute(select(Edge))
        db_edges = list(edges_result.scalars().all())

        graph = nx.DiGraph()
        id_to_name: dict[int, str] = {}
        for node in db_nodes:
            id_to_name[node.id] = node.name
            graph.add_node(
                node.name,
                id=node.id,
                type=node.type,
                x=node.x if node.x is not None else 0.0,
                y=node.y if node.y is not None else 0.0,
            )

        for edge in db_edges:
            source_name = id_to_name.get(edge.source_node_id)
            target_name = id_to_name.get(edge.target_node_id)
            if source_name and target_name:
                graph.add_edge(source_name, target_name)

        return graph
    except Exception:
        return build_base_infrastructure_graph()


@app.get("/")
async def serve_index() -> FileResponse:
    """Serves the frontend index.html application."""
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/api/v1/topology")
async def get_topology(db: AsyncSession = Depends(get_db)) -> dict[str, list[dict[str, Any]]]:
    """Returns the real-world city infrastructure graph (nodes with x/y and directed edges)."""
    graph = await load_infrastructure_graph(db)

    nodes_list = [
        {
            "id": str(node),
            "name": str(node),
            "label": str(node),
            "type": str(data.get("type", "unknown")),
            "group": str(data.get("type", "unknown")),
            "x": float(data.get("x", 0.0)),
            "y": float(data.get("y", 0.0)),
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
    `epicenter_node`, propagates `magnitude` into every Groq LLM node evaluation,
    persists the JSON trace (with magnitude) to PostgreSQL, and returns the trace.
    """
    graph: nx.DiGraph = await load_infrastructure_graph(db)
    magnitude: str = request.magnitude

    if request.epicenter_node not in graph:
        valid_nodes = list(graph.nodes)
        raise HTTPException(
            status_code=404,
            detail=(
                f"Epicenter node '{request.epicenter_node}' not found in infrastructure graph. "
                f"Available nodes: {valid_nodes}"
            ),
        )

    bfs_queue: deque[str] = deque([request.epicenter_node])
    visited: set[str] = {request.epicenter_node}
    failed_nodes: set[str] = {request.epicenter_node}

    epicenter_type = str(graph.nodes[request.epicenter_node].get("type", "unknown"))
    execution_trace: list[dict[str, Any]] = [
        {
            "parent_node": None,
            "child_node": request.epicenter_node,
            "node_name": request.epicenter_node,
            "node_type": epicenter_type,
            "magnitude": magnitude,
            "status": False,
            "reasoning": (
                f"Direct epicenter hit from {request.disaster_type} ({magnitude}) "
                f"caused immediate failure at {request.epicenter_node}."
            ),
            "recovery_command": None,
            "new_edge": None,
        }
    ]

    while bfs_queue:
        parent_name = bfs_queue.popleft()

        for child_name in list(graph.successors(parent_name)):
            if child_name in visited:
                continue
            visited.add(child_name)

            child_type = str(graph.nodes[child_name].get("type", "unknown"))
            available_nodes = [
                str(n) for n in graph.nodes if n not in failed_nodes and n != child_name
            ]

            try:
                evaluation = await evaluate_node_failure(
                    node_name=child_name,
                    node_type=child_type,
                    parent_name=parent_name,
                    disaster_type=request.disaster_type,
                    magnitude=magnitude,
                    available_nodes=available_nodes,
                )
            except ValueError as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc

            child_status = bool(evaluation["status"])
            reasoning = str(evaluation["reasoning"])
            recovery_command: str | None = evaluation.get("recovery_command")
            raw_new_edge = evaluation.get("new_edge")
            validated_new_edge: dict[str, str] | None = None

            if child_status is False:
                failed_nodes.add(child_name)

            # Validate and dynamically mutate the NetworkX graph if a valid self-healing edge is returned
            if isinstance(raw_new_edge, dict):
                raw_source = raw_new_edge.get("source")
                target_node = str(raw_new_edge.get("target") or child_name)
                resolved_source: str | None = None

                if isinstance(raw_source, str):
                    if raw_source in graph:
                        resolved_source = raw_source
                    else:
                        norm_raw = raw_source.strip().lower().replace("_", " ").replace("-", " ")
                        for candidate in graph.nodes:
                            norm_cand = str(candidate).strip().lower().replace("_", " ").replace("-", " ")
                            if norm_cand == norm_raw or norm_raw in norm_cand or norm_cand in norm_raw:
                                resolved_source = str(candidate)
                                break

                if (
                    resolved_source is not None
                    and resolved_source in graph
                    and resolved_source not in failed_nodes
                    and resolved_source != target_node
                ):
                    graph.add_edge(resolved_source, target_node)
                    validated_new_edge = {
                        "source": resolved_source,
                        "target": target_node,
                    }

            execution_trace.append(
                {
                    "parent_node": parent_name,
                    "child_node": child_name,
                    "node_name": child_name,
                    "node_type": child_type,
                    "magnitude": magnitude,
                    "status": child_status,
                    "reasoning": reasoning,
                    "recovery_command": recovery_command if validated_new_edge or recovery_command else None,
                    "new_edge": validated_new_edge,
                }
            )

            # Continue the cascade down this branch only if the child node failed (status == False)
            if child_status is False:
                bfs_queue.append(child_name)

    # Serialize execution_trace + magnitude metadata and persist in PostgreSQL SimulationTrace
    serialized_trace: str = json.dumps(execution_trace)

    try:
        trace_record = SimulationTrace(
            disaster_type=request.disaster_type,
            magnitude=magnitude,
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
