from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import json
import os
from typing import Any

import networkx as nx
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

try:
    from .agent import determine_epicenter, evaluate_node_failure
    from .auth import (
        create_access_token,
        get_current_user,
        hash_password,
        require_admin,
        verify_password,
    )
    from .database import AsyncSessionLocal, get_db, init_db
    from .models import Edge, Node, SimulationTrace, User
    from .schemas import (
        NodeCreate,
        NodeResponse,
        NodeState,
        NodeUpdate,
        SimulationRequest,
        Token,
        UserCreate,
        UserLogin,
        UserResponse,
    )
    from .seed_data import MIAMI_EDGES, MIAMI_NODES
except ImportError:
    from agent import determine_epicenter, evaluate_node_failure
    from auth import (
        create_access_token,
        get_current_user,
        hash_password,
        require_admin,
        verify_password,
    )
    from database import AsyncSessionLocal, get_db, init_db
    from models import Edge, Node, SimulationTrace, User
    from schemas import (
        NodeCreate,
        NodeResponse,
        NodeState,
        NodeUpdate,
        SimulationRequest,
        Token,
        UserCreate,
        UserLogin,
        UserResponse,
    )
    from seed_data import MIAMI_EDGES, MIAMI_NODES


async def ensure_default_admin() -> None:
    """Creates the default admin user if the users table is empty."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(User).where(User.is_admin.is_(True)))
            if result.scalars().first() is not None:
                return

            username = os.getenv("ADMIN_USERNAME", "admin")
            password = os.getenv("ADMIN_PASSWORD", "weatherfall")
            admin = User(
                username=username,
                hashed_password=hash_password(password),
                is_admin=True,
                is_active=True,
            )
            session.add(admin)
            await session.commit()
            print(f"[AUTH] Default admin user created — username='{username}'")
            print(f"[AUTH] Change the password by setting ADMIN_PASSWORD in your .env file.")
    except Exception as exc:
        print(f"[AUTH] Could not ensure default admin: {exc}")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Ensure database tables exist and a default admin is present on startup."""
    try:
        await init_db()
    except Exception:
        pass
    try:
        await ensure_default_admin()
    except Exception:
        pass
    yield


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

app = FastAPI(
    title="WeatherFall API",
    description="AI-driven climate risk cascade simulation API (Miami Infrastructure Edition).",
    version="1.3.0",
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
    """Initializes a static NetworkX DiGraph of Miami infrastructure."""
    graph = nx.DiGraph()
    for item in MIAMI_NODES:
        graph.add_node(item["name"], type=item["type"], x=item["x"], y=item["y"])
    graph.add_edges_from(MIAMI_EDGES)
    return graph


async def load_infrastructure_graph(db: AsyncSession) -> nx.DiGraph:
    """Loads the city graph from PostgreSQL, falling back to the static Miami graph."""
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
                graph.add_edge(
                    source_name,
                    target_name,
                    routing_distance=edge.routing_distance,
                    path_nodes=edge.path_nodes,
                )

        return graph
    except Exception:
        return build_base_infrastructure_graph()


# ─── Static pages ────────────────────────────────────────────────────────

@app.get("/")
async def serve_index() -> FileResponse:
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/login")
async def serve_login() -> FileResponse:
    return FileResponse(os.path.join(FRONTEND_DIR, "login.html"))


@app.get("/admin")
async def serve_admin() -> FileResponse:
    return FileResponse(os.path.join(FRONTEND_DIR, "admin.html"))


# ─── Auth ────────────────────────────────────────────────────────────────

@app.post("/api/v1/auth/login", response_model=Token)
async def login(
    payload: UserLogin,
    db: AsyncSession = Depends(get_db),
) -> Token:
    """Authenticate an operator and issue a JWT access token."""
    result = await db.execute(select(User).where(User.username == payload.username))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = create_access_token(subject=user.username, is_admin=user.is_admin)
    return Token(
        access_token=token,
        token_type="bearer",
        username=user.username,
        is_admin=user.is_admin,
    )


@app.post("/api/v1/auth/register", response_model=UserResponse, status_code=201)
async def register_user(
    payload: UserCreate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Admin-only: register a new operator account."""
    existing = await db.execute(select(User).where(User.username == payload.username))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail=f"User '{payload.username}' already exists.")

    user = User(
        username=payload.username,
        hashed_password=hash_password(payload.password),
        is_admin=bool(payload.is_admin),
        is_active=True,
    )
    db.add(user)
    try:
        await db.commit()
        await db.refresh(user)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Username conflict.")
    return user


@app.get("/api/v1/auth/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_user)) -> User:
    """Return the currently authenticated user's profile."""
    return user


# ─── Topology ────────────────────────────────────────────────────────────

@app.get("/api/v1/topology")
async def get_topology(db: AsyncSession = Depends(get_db)) -> dict[str, list[dict[str, Any]]]:
    """Returns the city infrastructure graph (nodes with x/y and directed edges)."""
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
            "routing_distance": edata.get("routing_distance"),
            "path_nodes": edata.get("path_nodes"),
        }
        for source, target, edata in graph.edges(data=True)
    ]
    return {"nodes": nodes_list, "edges": edges_list}


# ─── Node CRUD (admin) ───────────────────────────────────────────────────

def _euclid(a: Node, b: Node) -> float:
    ax = float(a.x) if a.x is not None else 0.0
    ay = float(a.y) if a.y is not None else 0.0
    bx = float(b.x) if b.x is not None else 0.0
    by = float(b.y) if b.y is not None else 0.0
    return (ax - bx) ** 2 + (ay - by) ** 2


async def _auto_connect_node(db: AsyncSession, new_node: Node) -> None:
    """
    Connect the new node to the nearest compatible existing node:
      • non-energy node → connects from its nearest energy node
      • energy node     → connects to its nearest non-energy node
    Falls back to the overall nearest node if no type match exists.
    """
    result = await db.execute(select(Node).where(Node.id != new_node.id))
    others = list(result.scalars().all())
    if not others:
        return

    if new_node.type == "energy":
        candidates = [n for n in others if n.type != "energy"] or others
        target = min(candidates, key=lambda n: _euclid(new_node, n))
        source_id, target_id = new_node.id, target.id
    else:
        energy_nodes = [n for n in others if n.type == "energy"]
        candidates = energy_nodes or others
        source = min(candidates, key=lambda n: _euclid(new_node, n))
        source_id, target_id = source.id, new_node.id

    existing = await db.execute(
        select(Edge).where(Edge.source_node_id == source_id, Edge.target_node_id == target_id)
    )
    if existing.scalar_one_or_none() is None:
        db.add(Edge(source_node_id=source_id, target_node_id=target_id))
        await db.flush()


@app.get("/api/v1/nodes", response_model=list[NodeResponse])
async def list_nodes(db: AsyncSession = Depends(get_db)) -> list[Node]:
    """List all registered infrastructure nodes."""
    result = await db.execute(select(Node).order_by(Node.id))
    return list(result.scalars().all())


@app.post("/api/v1/nodes", response_model=NodeResponse, status_code=201)
async def create_node(
    payload: NodeCreate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Node:
    """Admin-only: register a new critical infrastructure node and auto-connect it."""
    new_node = Node(
        name=payload.name.strip(),
        type=payload.type.strip().lower(),
        x=float(payload.x),
        y=float(payload.y),
    )
    db.add(new_node)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"Node '{payload.name}' already exists.")

    await _auto_connect_node(db, new_node)

    try:
        await db.commit()
        await db.refresh(new_node)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Node conflict while saving.")
    return new_node


@app.put("/api/v1/nodes/{node_id}", response_model=NodeResponse)
async def update_node(
    node_id: int,
    payload: NodeUpdate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Node:
    """Admin-only: update an existing node's attributes."""
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if node is None:
        raise HTTPException(status_code=404, detail=f"Node #{node_id} not found.")

    if payload.name is not None:
        node.name = payload.name.strip()
    if payload.type is not None:
        node.type = payload.type.strip().lower()
    if payload.x is not None:
        node.x = float(payload.x)
    if payload.y is not None:
        node.y = float(payload.y)

    try:
        await db.commit()
        await db.refresh(node)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Update conflicts with an existing node.")
    return node


@app.delete("/api/v1/nodes/{node_id}", status_code=204)
async def delete_node(
    node_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Admin-only: delete a node (cascades to its edges)."""
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if node is None:
        raise HTTPException(status_code=404, detail=f"Node #{node_id} not found.")
    await db.delete(node)
    await db.commit()
    return None


# ─── Simulation ──────────────────────────────────────────────────────────

def _estimate_osm_street_distance_m(
    graph: nx.DiGraph,
    undirected_graph: nx.Graph,
    source_node: str,
    target_node: str,
) -> float:
    """
    Calculates the physical OSM street network distance (in meters) between two
    infrastructure nodes, using stored OSMnx routing_distance on edges/paths or
    street-grid Haversine distance when nodes are not directly linked.
    """
    import math

    direct_edge = (
        graph.get_edge_data(source_node, target_node)
        or graph.get_edge_data(target_node, source_node)
    )
    if direct_edge and direct_edge.get("routing_distance"):
        return round(float(direct_edge["routing_distance"]), 1)

    s_data = graph.nodes[source_node]
    t_data = graph.nodes[target_node]
    lon1, lat1 = float(s_data.get("x", 0.0)), float(s_data.get("y", 0.0))
    lon2, lat2 = float(t_data.get("x", 0.0)), float(t_data.get("y", 0.0))

    # Haversine + Miami rectilinear street-grid factor (~1.26x)
    r_earth = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    euclidean_m = 2.0 * r_earth * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    street_grid_m = max(150.0, euclidean_m * 1.26)

    try:
        if nx.has_path(undirected_graph, source_node, target_node):
            graph_path_m = float(
                nx.shortest_path_length(
                    undirected_graph,
                    source=source_node,
                    target=target_node,
                    weight="routing_distance",
                )
            )
            if graph_path_m > 0 and graph_path_m <= street_grid_m * 2.2:
                return round(graph_path_m, 1)
    except Exception:
        pass

    return round(street_grid_m, 1)


def _get_viable_candidates(
    graph: nx.DiGraph,
    undirected_graph: nx.Graph,
    child_name: str,
    parent_name: str,
    failed_nodes: set[str],
    limit: int = 3,
) -> list[dict[str, Any]]:
    """
    Task 2: Selects up to `limit` viable candidate nodes that are currently alive,
    of a compatible infrastructure type to supply the failed child node, and physically
    closest based on OSM street network distance.
    """
    parent_type = str(graph.nodes[parent_name].get("type", "energy")) if parent_name in graph else "energy"
    child_type = str(graph.nodes[child_name].get("type", "unknown")) if child_name in graph else "unknown"

    compatible_types = {parent_type, "energy"}
    if child_type in {"water", "comms", "transport"}:
        compatible_types.add(child_type)

    scored_candidates: list[tuple[int, float, dict[str, Any]]] = []
    for node_id, data in graph.nodes(data=True):
        cand_name = str(node_id)
        if cand_name in failed_nodes or cand_name == child_name:
            continue

        cand_type = str(data.get("type", "energy"))
        dist_m = _estimate_osm_street_distance_m(graph, undirected_graph, cand_name, child_name)

        # Priority 0: exact same type as failed parent or energy supplier
        # Priority 1: other compatible type
        # Priority 2: fallback alive facility if fewer than 3 compatible nodes exist
        if cand_type == parent_type or cand_type == "energy":
            type_priority = 0
        elif cand_type in compatible_types:
            type_priority = 1
        else:
            type_priority = 2

        scored_candidates.append(
            (
                type_priority,
                dist_m,
                {
                    "id": cand_name,
                    "type": cand_type,
                    "distance_m": dist_m,
                },
            )
        )

    scored_candidates.sort(key=lambda item: (item[0], item[1], item[2]["id"]))
    return [item[2] for item in scored_candidates[:limit]]


@app.post("/api/v1/simulate", response_model=list[NodeState])
async def simulate_cascade(
    request: SimulationRequest,
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Run the AI-driven cascade simulation and return the execution trace."""
    graph: nx.DiGraph = await load_infrastructure_graph(db)
    magnitude: str = request.magnitude

    nodes_list: list[dict[str, Any]] = [
        {
            "id": str(node),
            "name": str(node),
            "type": str(data.get("type", "unknown")),
            "x": round(float(data.get("x", 0.0)), 5),
            "y": round(float(data.get("y", 0.0)), 5),
        }
        for node, data in graph.nodes(data=True)
    ]

    try:
        epicenter_eval = await determine_epicenter(
            disaster_type=request.disaster_type,
            magnitude=magnitude,
            trajectory=request.trajectory,
            available_nodes=nodes_list,
        )
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    chosen_id: str = epicenter_eval["epicenter_id"]
    llm_reasoning: str = epicenter_eval["reasoning"]

    if chosen_id not in graph:
        chosen_id = next(iter(graph.nodes))

    undirected_graph = graph.to_undirected()
    bfs_queue: deque[str] = deque([chosen_id])
    visited: set[str] = {chosen_id}
    failed_nodes: set[str] = {chosen_id}

    epicenter_type = str(graph.nodes[chosen_id].get("type", "unknown"))
    execution_trace: list[dict[str, Any]] = [
        {
            "step": "impact",
            "node": chosen_id,
            "parent_node": None,
            "child_node": chosen_id,
            "node_name": chosen_id,
            "node_type": epicenter_type,
            "magnitude": magnitude,
            "status": False,
            "reasoning": llm_reasoning,
            "recovery_command": None,
            "estimated_cost": None,
            "recovery_time_ms": None,
            "new_edge": None,
        }
    ]

    while bfs_queue:
        parent_name = bfs_queue.popleft()

        neighbors = list(graph.successors(parent_name))
        if not neighbors and parent_name == chosen_id:
            neighbors = list(graph.predecessors(parent_name))

        for child_name in neighbors:
            if child_name in visited:
                continue
            visited.add(child_name)

            child_type = str(graph.nodes[child_name].get("type", "unknown"))
            edge_data = (
                graph.get_edge_data(parent_name, child_name)
                or graph.get_edge_data(child_name, parent_name)
                or {}
            )
            raw_distance = edge_data.get("routing_distance")
            route_distance = round(float(raw_distance), 2) if raw_distance is not None else 0.0
            raw_path_nodes = edge_data.get("path_nodes")
            route_path_nodes = len(raw_path_nodes) if isinstance(raw_path_nodes, list) else 0

            candidate_nodes = _get_viable_candidates(
                graph=graph,
                undirected_graph=undirected_graph,
                child_name=child_name,
                parent_name=parent_name,
                failed_nodes=failed_nodes,
                limit=3,
            )

            try:
                evaluation = await evaluate_node_failure(
                    node_name=child_name,
                    node_type=child_type,
                    parent_name=parent_name,
                    disaster_type=request.disaster_type,
                    magnitude=magnitude,
                    route_distance=route_distance,
                    route_path_nodes=route_path_nodes,
                    candidate_nodes=candidate_nodes,
                )
            except ValueError as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc

            child_status = bool(evaluation["status"])
            reasoning = str(evaluation["reasoning"])
            recovery_command: str | None = evaluation.get("recovery_command")
            raw_new_edge = evaluation.get("new_edge")
            validated_new_edge: dict[str, Any] | None = None
            step_cost: int | None = None
            step_time_ms: int | None = None

            if child_status is False:
                failed_nodes.add(child_name)

            if isinstance(raw_new_edge, dict):
                raw_source = raw_new_edge.get("source")
                target_node = str(raw_new_edge.get("target") or child_name)
                resolved_source: str | None = None

                if isinstance(raw_source, str):
                    if raw_source in graph:
                        resolved_source = raw_source
                    else:
                        norm_raw = "".join(ch for ch in raw_source.lower() if ch.isalnum())
                        for candidate in graph.nodes:
                            norm_cand = "".join(ch for ch in str(candidate).lower() if ch.isalnum())
                            if norm_raw and (
                                norm_cand == norm_raw
                                or norm_raw in norm_cand
                                or norm_cand in norm_raw
                            ):
                                resolved_source = str(candidate)
                                break

                if (
                    resolved_source is None
                    or resolved_source not in graph
                    or resolved_source in failed_nodes
                    or resolved_source == target_node
                ) and candidate_nodes:
                    resolved_source = str(candidate_nodes[0]["id"])

                if (
                    resolved_source is not None
                    and resolved_source in graph
                    and resolved_source not in failed_nodes
                    and resolved_source != target_node
                ):
                    try:
                        est_cost = int(float(raw_new_edge.get("estimated_cost", evaluation.get("estimated_cost", 15000))))
                    except (TypeError, ValueError):
                        est_cost = 15000

                    try:
                        rec_time = int(float(raw_new_edge.get("recovery_time_ms", evaluation.get("recovery_time_ms", 120))))
                    except (TypeError, ValueError):
                        rec_time = 120

                    graph.add_edge(resolved_source, target_node)
                    validated_new_edge = {
                        "source": resolved_source,
                        "target": target_node,
                        "estimated_cost": est_cost,
                        "recovery_time_ms": rec_time,
                    }
                    step_cost = est_cost
                    step_time_ms = rec_time

            execution_trace.append(
                {
                    "step": "cascade",
                    "node": child_name,
                    "parent_node": parent_name,
                    "child_node": child_name,
                    "node_name": child_name,
                    "node_type": child_type,
                    "magnitude": magnitude,
                    "status": child_status,
                    "reasoning": reasoning,
                    "recovery_command": recovery_command if validated_new_edge or recovery_command else None,
                    "estimated_cost": step_cost,
                    "recovery_time_ms": step_time_ms,
                    "new_edge": validated_new_edge,
                }
            )

            if child_status is False:
                bfs_queue.append(child_name)

    try:
        trace_record = SimulationTrace(
            disaster_type=request.disaster_type,
            magnitude=magnitude,
            epicenter_node=chosen_id,
            trace_data=json.loads(json.dumps(execution_trace)),
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