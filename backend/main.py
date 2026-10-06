from collections import deque
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
import networkx as nx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
        # Allow local fallback execution if PostgreSQL is not yet running
        pass
    yield


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


def build_fallback_graph() -> nx.DiGraph:
    """Fallback hardcoded directed graph used if the database has not been seeded yet."""
    graph = nx.DiGraph()
    graph.add_edges_from(
        [
            ("Main Power Plant", "Substation A"),
            ("Substation A", "Hospital"),
            ("Substation A", "Water Pump"),
        ]
    )
    return graph


async def load_infrastructure_graph(db: AsyncSession) -> tuple[nx.DiGraph, bool]:
    """
    Loads the infrastructure topology from PostgreSQL into a NetworkX DiGraph.
    Returns (graph, loaded_from_db). Falls back to hardcoded graph if DB is empty/unreachable.
    """
    try:
        nodes_result = await db.execute(select(Node))
        nodes = list(nodes_result.scalars().all())
        if not nodes:
            return build_fallback_graph(), False

        edges_result = await db.execute(select(Edge))
        edges = list(edges_result.scalars().all())

        graph = nx.DiGraph()
        id_to_name: dict[int, str] = {}
        for node in nodes:
            id_to_name[node.id] = node.name
            graph.add_node(node.name, id=node.id, type=node.type)

        for edge in edges:
            source_name = id_to_name.get(edge.source_node_id)
            target_name = id_to_name.get(edge.target_node_id)
            if source_name and target_name:
                graph.add_edge(source_name, target_name)

        return graph, True
    except Exception:
        return build_fallback_graph(), False


@app.post("/api/v1/simulate", response_model=list[NodeState])
async def simulate_cascade(
    request: SimulationRequest,
    db: AsyncSession = Depends(get_db),
) -> list[NodeState]:
    """
    Executes a Breadth-First Search (BFS) cascade simulation starting from `epicenter_node`,
    stores the resulting JSON execution trace in PostgreSQL, and returns the trace.
    """
    graph, loaded_from_db = await load_infrastructure_graph(db)

    if request.epicenter_node not in graph:
        valid_nodes = list(graph.nodes)
        raise HTTPException(
            status_code=404,
            detail=(
                f"Epicenter node '{request.epicenter_node}' not found in infrastructure graph. "
                f"Available nodes: {valid_nodes}"
            ),
        )

    execution_trace: list[NodeState] = []
    visited: set[str] = {request.epicenter_node}

    # Queue stores tuples of (current_node, parent_status)
    # The epicenter node receives parent_status=False as it absorbs the direct disaster impact.
    bfs_queue: deque[tuple[str, bool]] = deque([(request.epicenter_node, False)])

    while bfs_queue:
        current_node, parent_status = bfs_queue.popleft()

        evaluation: dict[str, bool | str] = await evaluate_node_failure(
            node=current_node,
            disaster_type=request.disaster_type,
            parent_status=parent_status,
        )

        current_status = bool(evaluation["status"])
        node_state = NodeState(
            node_name=current_node,
            status=current_status,
            reasoning=str(evaluation["reasoning"]),
        )
        execution_trace.append(node_state)

        for neighbor in graph.successors(current_node):
            if neighbor not in visited:
                visited.add(neighbor)
                bfs_queue.append((neighbor, current_status))

    # Persist simulation execution trace to PostgreSQL when DB is active
    if loaded_from_db:
        trace_record = SimulationTrace(
            disaster_type=request.disaster_type,
            epicenter_node=request.epicenter_node,
            trace_data=[step.model_dump() for step in execution_trace],
        )
        db.add(trace_record)
        await db.commit()

    return execution_trace


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
