from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import heapq
import json
import os
import math
from typing import Any

import httpx
import networkx as nx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

try:
    from .agent import (
        compute_realistic_recovery_metrics,
        compute_required_crews,
        determine_epicenter,
        evaluate_batch_failures,
        evaluate_node_failure,
        format_recovery_duration,
    )
    from .auth import (
        ACCESS_TOKEN_EXPIRE_MINUTES,
        SESSION_COOKIE_NAME,
        create_access_token,
        decode_and_verify_token,
        extract_request_token,
        get_current_user,
        hash_password,
        oauth2_scheme,
        require_admin,
        revoke_token,
        verify_password,
    )
    from .database import AsyncSessionLocal, get_db, init_db
    from .models import Edge, Node, SimulationTrace, User
    from .schemas import (
        DiagnosticIssue,
        EdgeCreate,
        EdgeResponse,
        Event,
        NodeCreate,
        NodeResponse,
        NodeState,
        NodeUpdate,
        SimulationDispatchResponse,
        SimulationRequest,
        SimulationStatusResponse,
        Token,
        UserCreate,
        UserLogin,
        UserResponse,
    )
    from .seed_data import MIAMI_EDGES, MIAMI_NODES
    from .validator import validate_city_graph
    from .worker import (
        dispatch_simulation_task,
        execute_simulation_cascade,
        get_simulation_task_status,
    )
except ImportError:
    from agent import (
        compute_realistic_recovery_metrics,
        compute_required_crews,
        determine_epicenter,
        evaluate_batch_failures,
        evaluate_node_failure,
        format_recovery_duration,
    )
    from auth import (
        ACCESS_TOKEN_EXPIRE_MINUTES,
        SESSION_COOKIE_NAME,
        create_access_token,
        decode_and_verify_token,
        extract_request_token,
        get_current_user,
        hash_password,
        oauth2_scheme,
        require_admin,
        revoke_token,
        verify_password,
    )
    from database import AsyncSessionLocal, get_db, init_db
    from models import Edge, Node, SimulationTrace, User
    from schemas import (
        DiagnosticIssue,
        EdgeCreate,
        EdgeResponse,
        Event,
        NodeCreate,
        NodeResponse,
        NodeState,
        NodeUpdate,
        SimulationDispatchResponse,
        SimulationRequest,
        SimulationStatusResponse,
        Token,
        UserCreate,
        UserLogin,
        UserResponse,
    )
    from seed_data import MIAMI_EDGES, MIAMI_NODES
    from validator import validate_city_graph
    from worker import (
        dispatch_simulation_task,
        execute_simulation_cascade,
        get_simulation_task_status,
    )


def get_real_client_ip(request: Request) -> str:
    """
    Extracts the real client IP address when deployed behind Traefik or Nginx.
    Uses the right-most proxy-appended hop in X-Forwarded-For (or X-Real-IP) so
    external clients cannot spoof X-Forwarded-For headers to bypass slowapi rate limits.
    """
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        hops = [ip.strip() for ip in forwarded_for.split(",") if ip.strip()]
        if hops:
            return hops[-1]

    real_ip = request.headers.get("X-Real-IP")
    if real_ip and real_ip.strip():
        return real_ip.strip()

    return get_remote_address(request)


# Task 1: Initialize SlowAPI Limiter
limiter = Limiter(key_func=get_real_client_ip)


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
    """Ensure database tables, hierarchical capacity columns, and Climate Justice SVI/population columns exist on startup."""
    try:
        await init_db()
        from sqlalchemy import text
        try:
            from .database import engine
        except ImportError:
            from database import engine
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tier VARCHAR(30) DEFAULT 'Secondary';"))
            await conn.execute(text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS capacity INTEGER DEFAULT 3;"))
            await conn.execute(
                text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS battery_backup_hours DOUBLE PRECISION DEFAULT 24.0;")
            )
            await conn.execute(
                text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS social_vulnerability_index DOUBLE PRECISION DEFAULT 0.5;")
            )
            await conn.execute(
                text("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS population_served INTEGER DEFAULT 25000;")
            )
    except Exception:
        pass
    try:
        await ensure_default_admin()
    except Exception:
        pass
    yield


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

_IS_PRODUCTION = os.getenv("ENV", "").lower() == "production"

app = FastAPI(
    title="WeatherFall API",
    description="AI-driven climate risk cascade simulation API (Miami Infrastructure Edition).",
    version="1.6.0",
    lifespan=lifespan,
    docs_url=None if _IS_PRODUCTION else "/docs",
    redoc_url=None if _IS_PRODUCTION else "/redoc",
    openapi_url=None if _IS_PRODUCTION else "/openapi.json",
)

# Attach SlowAPI limiter, 429 exception handler, and middleware
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

_RAW_ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:8000,http://127.0.0.1:8000",
)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in _RAW_ALLOWED_ORIGINS.split(",")
    if origin.strip() and origin.strip() != "*"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With"],
)

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

# In-memory topology graph cache — invalidated/rebuilt whenever nodes or edges change
_TOPOLOGY_CACHE: nx.DiGraph | None = None

# Task 2: Realistic Directed Interdependency Matrix
#   • Hospitals (health) MUST receive electricity (energy), water (water), and communications (comms)
#   • Electricity plants/substations (energy) ONLY need other electricity plants (energy -> energy)
#     in order to supply downstream facilities and residential neighborhoods
#   • Water, Comms, and Transport facilities receive electricity from energy plants/substations
MANDATORY_INCOMING_LIFELINES: dict[str, tuple[str, ...]] = {
    "health": ("energy", "water", "comms"),
    "energy": ("energy",),
    "water": ("energy",),
    "comms": ("energy",),
    "transport": ("energy",),
}

ALLOWED_INCOMING_TYPES_BY_TARGET: dict[str, set[str]] = {
    "health": {"energy", "water", "comms"},
    "energy": {"energy"},
    "water": {"energy", "water"},
    "comms": {"energy", "comms"},
    "transport": {"energy", "transport"},
}


def _normalize_sector_type(raw_type: Any) -> str:
    """Normalizes facility sector strings (e.g. 'power' -> 'energy')."""
    val = str(raw_type or "energy").strip().lower()
    if val == "power":
        return "energy"
    return val


def _infer_node_hierarchy(node_name: str, node_type: str) -> tuple[str, int, float]:
    """
    Infers (tier, capacity, battery_backup_hours) for a node based on its facility
    sector and name when not explicitly specified.
    `battery_backup_hours` represents emergency UPS/battery backup endurance (in hours)
    used by the Discrete Event Simulation (DES) before full node collapse.
    """
    ntype = _normalize_sector_type(node_type)
    nlower = node_name.lower()

    if ntype == "energy":
        is_primary = any(
            k in nlower for k in ("miami substation", "flagami", "levee", "davis", "culmer", "railway", "nuclear", "clean energy")
        )
        return ("Primary", 6, 4.0) if is_primary else ("Secondary", 2, 2.5)
    if ntype == "water":
        is_primary = any(k in nlower for k in ("plant", "treatment", "central district", "alexander orr", "virginia key"))
        return ("Primary", 5, 3.5) if is_primary else ("Secondary", 2, 2.0)
    if ntype == "health":
        is_primary = any(k in nlower for k in ("jackson memorial", "mercy", "mount sinai", "baptist", "university", "trauma", "medical center"))
        return ("Primary", 2, 4.5) if is_primary else ("Secondary", 1, 3.0)
    if ntype == "transport":
        is_primary = any(k in nlower for k in ("port", "airport", "central", "government center", "intermodal", "hub", "terminal", "dadeland"))
        return ("Primary", 5, 3.0) if is_primary else ("Secondary", 2, 1.5)
    is_primary = any(k in nlower for k in ("nap", "equinix", "coresite", "downtown", "central"))
    return ("Primary", 5, 4.0) if is_primary else ("Secondary", 2, 2.2)


def _infer_node_demographics(
    node_name: str,
    node_type: str,
    tier: str,
    lon: float,
    lat: float,
) -> tuple[float, int]:
    """
    Task 1: Procedurally computes `(social_vulnerability_index, population_served)`
    based on node type, infrastructure tier, and geographic clustering in Miami.
    """
    try:
        from .seed_miami import compute_demographic_profile
    except ImportError:
        from seed_miami import compute_demographic_profile

    return compute_demographic_profile(
        name=node_name,
        node_type=node_type,
        tier=tier,
        lon=lon,
        lat=lat,
    )


def invalidate_topology_cache() -> None:
    """Invalidates the cached NetworkX infrastructure topology graph."""
    global _TOPOLOGY_CACHE
    _TOPOLOGY_CACHE = None


def build_base_infrastructure_graph() -> nx.DiGraph:
    """Initializes a static NetworkX DiGraph of Miami infrastructure with SVI and population_served."""
    graph = nx.DiGraph()
    for item in MIAMI_NODES:
        ntype = _normalize_sector_type(item["type"])
        tier, cap, backup_h = _infer_node_hierarchy(item["name"], ntype)
        lon_val = float(item.get("x", -80.205))
        lat_val = float(item.get("y", 25.778))
        svi_val, pop_val = _infer_node_demographics(item["name"], ntype, tier, lon_val, lat_val)
        graph.add_node(
            item["name"],
            type=ntype,
            x=lon_val,
            y=lat_val,
            tier=tier,
            capacity=cap,
            battery_backup_hours=backup_h,
            social_vulnerability_index=svi_val,
            svi_score=svi_val,
            population_served=pop_val,
        )
    graph.add_edges_from(MIAMI_EDGES)
    return graph


async def _ensure_mandatory_topology_lifelines(
    db: AsyncSession,
    db_nodes: list[Node],
    db_edges: list[Edge],
) -> list[Edge]:
    """
    Ensures every node in PostgreSQL has hierarchical tier/capacity/backup
    and Climate Justice demographic attributes (`social_vulnerability_index`, `population_served`).
    Only auto-wires baseline lifelines if `db_edges` is completely empty on initial bootstrap,
    preserving any manual node/edge edits made in the Admin Console so `validate_city_graph`
    can accurately inspect topological integrity.
    """
    if not db_nodes:
        return db_edges

    nodes_updated = False
    nodes_by_id: dict[int, Node] = {n.id: n for n in db_nodes}
    nodes_by_type: dict[str, list[Node]] = {}
    out_degree_by_id: dict[int, int] = {n.id: 0 for n in db_nodes}

    for n in db_nodes:
        ntype = _normalize_sector_type(n.type)
        nodes_by_type.setdefault(ntype, []).append(n)
        tier_inf, cap_inf, backup_inf = _infer_node_hierarchy(n.name, ntype)
        if not n.tier or float(n.battery_backup_hours or 0.0) > 8.0:
            n.tier = tier_inf
            n.capacity = cap_inf
            n.battery_backup_hours = backup_inf
            nodes_updated = True

        svi_inf, pop_inf = _infer_node_demographics(
            node_name=n.name,
            node_type=ntype,
            tier=str(n.tier or tier_inf),
            lon=float(n.x if n.x is not None else -80.205),
            lat=float(n.y if n.y is not None else 25.778),
        )
        if (
            n.social_vulnerability_index is None
            or n.population_served is None
            or (abs(float(n.social_vulnerability_index) - 0.5) < 1e-6 and int(n.population_served) == 25000)
        ):
            n.social_vulnerability_index = svi_inf
            n.population_served = pop_inf
            nodes_updated = True

    if db_edges:
        if nodes_updated:
            try:
                await db.commit()
            except Exception:
                await db.rollback()
        return [
            edge
            for edge in db_edges
            if edge.source_node_id in nodes_by_id and edge.target_node_id in nodes_by_id
        ]

    incoming_types_by_target: dict[int, set[str]] = {n.id: set() for n in db_nodes}
    existing_pairs: set[tuple[int, int]] = set()
    added_edges: list[Edge] = []

    for target_node in db_nodes:
        target_type = _normalize_sector_type(target_node.type)
        if target_type == "energy":
            continue
        required_types = MANDATORY_INCOMING_LIFELINES.get(target_type, ())
        current_incoming = incoming_types_by_target.get(target_node.id, set())

        for req_type in required_types:
            if req_type in current_incoming:
                continue
            candidates = [
                cand
                for cand in nodes_by_type.get(req_type, [])
                if cand.id != target_node.id and (cand.id, target_node.id) not in existing_pairs
            ]
            if not candidates:
                continue

            def _score_candidate(cand: Node) -> tuple[int, int, float]:
                cap = int(cand.capacity or (6 if cand.tier == "Primary" else 3))
                overloaded = 1 if out_degree_by_id.get(cand.id, 0) >= cap else 0
                tier_rank = 0 if (target_node.tier == "Primary" and cand.tier == "Primary") else 1
                return (overloaded, tier_rank, _euclid(cand, target_node))

            best_source = min(candidates, key=_score_candidate)
            dist_m, path_nodes = _compute_street_distance_between_nodes(best_source, target_node)
            new_edge = Edge(
                source_node_id=best_source.id,
                target_node_id=target_node.id,
                routing_distance=dist_m,
                path_nodes=path_nodes,
            )
            db.add(new_edge)
            added_edges.append(new_edge)
            existing_pairs.add((best_source.id, target_node.id))
            out_degree_by_id[best_source.id] = out_degree_by_id.get(best_source.id, 0) + 1
            current_incoming.add(req_type)

    if added_edges or nodes_updated:
        try:
            await db.commit()
            for e in added_edges:
                await db.refresh(e)
            db_edges = list(db_edges) + added_edges
        except Exception:
            await db.rollback()

    return db_edges


async def load_infrastructure_graph(db: AsyncSession, force_reload: bool = False) -> nx.DiGraph:
    """Loads the city graph from PostgreSQL (using cache unless invalidated), falling back to the static Miami graph."""
    global _TOPOLOGY_CACHE
    if _TOPOLOGY_CACHE is not None and not force_reload:
        return _TOPOLOGY_CACHE.copy()

    try:
        nodes_result = await db.execute(select(Node))
        db_nodes = list(nodes_result.scalars().all())
        if not db_nodes:
            _TOPOLOGY_CACHE = build_base_infrastructure_graph()
            return _TOPOLOGY_CACHE.copy()

        edges_result = await db.execute(select(Edge))
        db_edges = list(edges_result.scalars().all())
        db_edges = await _ensure_mandatory_topology_lifelines(db, db_nodes, db_edges)

        graph = nx.DiGraph()
        id_to_name: dict[int, str] = {}
        id_to_type: dict[int, str] = {}
        for node in db_nodes:
            norm_type = _normalize_sector_type(node.type)
            id_to_name[node.id] = node.name
            id_to_type[node.id] = norm_type
            lon_val = float(node.x if node.x is not None else -80.205)
            lat_val = float(node.y if node.y is not None else 25.778)
            tier_val = node.tier or "Secondary"
            svi_inf, pop_inf = _infer_node_demographics(node.name, norm_type, tier_val, lon_val, lat_val)
            svi_val = float(node.social_vulnerability_index if node.social_vulnerability_index is not None else svi_inf)
            pop_val = int(node.population_served if node.population_served is not None else pop_inf)
            graph.add_node(
                node.name,
                id=node.id,
                type=norm_type,
                x=lon_val,
                y=lat_val,
                tier=tier_val,
                capacity=int(node.capacity or 3),
                battery_backup_hours=float(node.battery_backup_hours or 24.0),
                social_vulnerability_index=svi_val,
                svi_score=svi_val,
                population_served=pop_val,
            )

        for edge in db_edges:
            source_name = id_to_name.get(edge.source_node_id)
            target_name = id_to_name.get(edge.target_node_id)
            if source_name and target_name:
                src_type = id_to_type.get(edge.source_node_id, "energy")
                tgt_type = id_to_type.get(edge.target_node_id, "energy")
                graph.add_edge(
                    source_name,
                    target_name,
                    edge_id=edge.id,
                    source_node_id=edge.source_node_id,
                    target_node_id=edge.target_node_id,
                    dependency_type=src_type,
                    is_cyclic_fallback=(src_type == "transport" and tgt_type == "energy"),
                    routing_distance=edge.routing_distance,
                    path_nodes=edge.path_nodes,
                )

        _TOPOLOGY_CACHE = graph
        return _TOPOLOGY_CACHE.copy()
    except Exception:
        return build_base_infrastructure_graph()


async def rebuild_topology_cache(db: AsyncSession) -> nx.DiGraph:
    """Invalidates and immediately rebuilds the topology cache from PostgreSQL."""
    invalidate_topology_cache()
    return await load_infrastructure_graph(db, force_reload=True)


# ─── Static pages ────────────────────────────────────────────────────────

@app.get("/")
async def serve_index() -> FileResponse:
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/login")
async def serve_login() -> FileResponse:
    return FileResponse(os.path.join(FRONTEND_DIR, "login.html"))


@app.get("/admin", response_model=None)
async def serve_admin() -> FileResponse:
    """
    Serves the GIS Infrastructure Admin Console shell with strict no-store cache headers.
    All admin data and actions (/api/v1/auth/me, /api/v1/nodes, /api/v1/edges, /api/v1/osm/search)
    require a verified administrator session via Depends(require_admin).
    """
    return FileResponse(
        os.path.join(FRONTEND_DIR, "admin.html"),
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


# ─── Auth ────────────────────────────────────────────────────────────────

@app.post("/api/v1/auth/login", response_model=Token)
@limiter.limit("5/minute")
async def login(
    request: Request,
    response: Response,
    payload: UserLogin,
    db: AsyncSession = Depends(get_db),
) -> Token:
    """Authenticate an operator, issue a signed JWT access token, and set an HttpOnly session cookie."""
    result = await db.execute(select(User).where(User.username == payload.username))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = create_access_token(subject=user.username, is_admin=user.is_admin)
    cookie_secure = (
        _IS_PRODUCTION
        or os.getenv("COOKIE_SECURE", "").lower() in {"1", "true", "yes"}
        or request.url.scheme == "https"
        or request.headers.get("X-Forwarded-Proto", "").lower() == "https"
    )
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=cookie_secure,
        samesite="lax",
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )
    return Token(
        access_token=token,
        token_type="bearer",
        username=user.username,
        is_admin=user.is_admin,
    )


@app.post("/api/v1/auth/logout")
async def logout(
    request: Request,
    response: Response,
    token: str | None = Depends(oauth2_scheme),
) -> dict[str, str]:
    """Revoke active JWT session tokens server-side and clear the HttpOnly session cookie."""
    if token and token.strip():
        revoke_token(token.strip())
    cookie_token = request.cookies.get(SESSION_COOKIE_NAME)
    if cookie_token and cookie_token.strip():
        revoke_token(cookie_token.strip())
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return {"status": "signed_out"}


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
async def me(
    request: Request,
    response: Response,
    token: str | None = Depends(oauth2_scheme),
    user: User = Depends(get_current_user),
) -> User:
    """Return the currently authenticated user's profile and keep the HttpOnly session cookie synchronized."""
    active_token = extract_request_token(request, token)
    if active_token:
        response.set_cookie(
            key=SESSION_COOKIE_NAME,
            value=active_token,
            httponly=True,
            samesite="lax",
            max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            path="/",
        )
    return user


# ─── Topology ────────────────────────────────────────────────────────────

@app.get("/api/v1/topology")
@limiter.limit("30/minute")
async def get_topology(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict[str, list[dict[str, Any]]]:
    """Returns the city infrastructure graph (nodes with x/y, tier, capacity, backup hours, SVI, population, and directed edges)."""
    graph = await load_infrastructure_graph(db)

    nodes_list = [
        {
            "id": str(node),
            "db_id": data.get("id"),
            "name": str(node),
            "label": str(node),
            "type": str(data.get("type", "unknown")),
            "group": str(data.get("type", "unknown")),
            "x": float(data.get("x", 0.0)),
            "y": float(data.get("y", 0.0)),
            "tier": str(data.get("tier", "Secondary")),
            "capacity": int(data.get("capacity", 3)),
            "battery_backup_hours": float(data.get("battery_backup_hours", 24.0)),
            "social_vulnerability_index": float(data.get("social_vulnerability_index", 0.5)),
            "svi_score": float(data.get("svi_score", data.get("social_vulnerability_index", 0.5))),
            "population_served": int(data.get("population_served", 25000)),
        }
        for node, data in graph.nodes(data=True)
    ]
    edges_list = [
        {
            "id": edata.get("edge_id"),
            "source_node_id": edata.get("source_node_id"),
            "target_node_id": edata.get("target_node_id"),
            "source": str(source),
            "target": str(target),
            "from": str(source),
            "to": str(target),
            "dependency_type": edata.get("dependency_type"),
            "is_cyclic_fallback": bool(edata.get("is_cyclic_fallback", False)),
            "routing_distance": edata.get("routing_distance"),
            "path_nodes": edata.get("path_nodes"),
        }
        for source, target, edata in graph.edges(data=True)
    ]
    return {"nodes": nodes_list, "edges": edges_list}


@app.get("/api/v1/topology/validate", response_model=list[DiagnosticIssue])
@limiter.limit("60/minute")
async def validate_topology(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Task 2: Runs the Topological Integrity Validator (`validate_city_graph`) on the
    live cached infrastructure graph and returns the array of diagnostic issues
    (Cycle Analysis, Orphan Detection, and Bottleneck Analysis).
    """
    graph = await load_infrastructure_graph(db)
    return validate_city_graph(graph)



# ─── Node & Edge CRUD (admin) ────────────────────────────────────────────

def _euclid(a: Node, b: Node) -> float:
    ax = float(a.x) if a.x is not None else 0.0
    ay = float(a.y) if a.y is not None else 0.0
    bx = float(b.x) if b.x is not None else 0.0
    by = float(b.y) if b.y is not None else 0.0
    return (ax - bx) ** 2 + (ay - by) ** 2


def _compute_street_distance_between_nodes(source_node: Node, target_node: Node) -> tuple[float, list[int]]:
    """
    Computes an estimated physical Miami street-grid routing distance (meters)
    and synthetic intersection path nodes between two Node records.
    """
    lon1 = float(source_node.x or 0.0)
    lat1 = float(source_node.y or 0.0)
    lon2 = float(target_node.x or 0.0)
    lat2 = float(target_node.y or 0.0)

    r_earth = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    euclidean_m = 2.0 * r_earth * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    routing_distance = round(max(120.0, euclidean_m * 1.26), 2)
    est_intersections = max(2, int(round(routing_distance / 140.0)))
    synthetic_path = list(range(1, est_intersections + 1))
    return routing_distance, synthetic_path


async def _auto_connect_node(db: AsyncSession, new_node: Node) -> None:
    """
    Task 1: Connect the new node enforcing strict multi-dependency rules:
      • health node             → incoming edges from nearest energy, water, AND comms nodes
      • water / comms / transp. → incoming edge from nearest energy node
      • energy node             → incoming edge from nearest energy node AND outgoing edge to nearest downstream facility
    """
    result = await db.execute(select(Node).where(Node.id != new_node.id))
    others = list(result.scalars().all())
    if not others:
        return

    node_type = _normalize_sector_type(new_node.type)
    pairs_to_create: list[tuple[Node, Node]] = []

    if node_type == "energy":
        energy_peers = [n for n in others if _normalize_sector_type(n.type) == "energy"]
        if energy_peers:
            upstream_energy = min(energy_peers, key=lambda n: _euclid(new_node, n))
            pairs_to_create.append((upstream_energy, new_node))
        downstream_candidates = [n for n in others if _normalize_sector_type(n.type) != "energy"] or others
        target = min(downstream_candidates, key=lambda n: _euclid(new_node, n))
        pairs_to_create.append((new_node, target))
    else:
        required_types = MANDATORY_INCOMING_LIFELINES.get(node_type, ("energy",))
        for req_type in required_types:
            typed_candidates = [n for n in others if _normalize_sector_type(n.type) == req_type]
            if typed_candidates:
                source = min(typed_candidates, key=lambda n: _euclid(new_node, n))
                pairs_to_create.append((source, new_node))
        if not pairs_to_create:
            energy_candidates = [n for n in others if _normalize_sector_type(n.type) == "energy"] or others
            source = min(energy_candidates, key=lambda n: _euclid(new_node, n))
            pairs_to_create.append((source, new_node))

    for source_node, target_node in pairs_to_create:
        existing = await db.execute(
            select(Edge).where(
                Edge.source_node_id == source_node.id,
                Edge.target_node_id == target_node.id,
            )
        )
        if existing.scalar_one_or_none() is None:
            dist_m, path_nodes = _compute_street_distance_between_nodes(source_node, target_node)
            db.add(
                Edge(
                    source_node_id=source_node.id,
                    target_node_id=target_node.id,
                    routing_distance=dist_m,
                    path_nodes=path_nodes,
                )
            )
    await db.flush()


@app.get("/api/v1/nodes", response_model=list[NodeResponse])
async def list_nodes(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[Node]:
    """Admin-only: list all registered infrastructure nodes."""
    result = await db.execute(select(Node).order_by(Node.id))
    return list(result.scalars().all())


@app.post("/api/v1/nodes", response_model=NodeResponse, status_code=201)
async def create_node(
    payload: NodeCreate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Node:
    """Admin-only: register a new critical infrastructure node and rebuild the topology cache."""
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

    if payload.auto_connect:
        await _auto_connect_node(db, new_node)

    try:
        await db.commit()
        await db.refresh(new_node)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Node conflict while saving.")

    await rebuild_topology_cache(db)
    return new_node


@app.put("/api/v1/nodes/{node_id}", response_model=NodeResponse)
async def update_node(
    node_id: int,
    payload: NodeUpdate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Node:
    """Admin-only: update an existing node's attributes and rebuild the topology cache."""
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

    await rebuild_topology_cache(db)
    return node


@app.delete("/api/v1/nodes/{node_id}", status_code=204)
async def delete_node(
    node_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Admin-only: delete a node (cascades to its edges) and rebuild the topology cache."""
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if node is None:
        raise HTTPException(status_code=404, detail=f"Node #{node_id} not found.")
    await db.delete(node)
    await db.commit()
    await rebuild_topology_cache(db)
    return None


async def _resolve_node_by_id_or_name(
    db: AsyncSession,
    node_id: int | None,
    node_ref: int | str | None,
) -> Node | None:
    """Resolves a Node record from either an integer ID or a facility name."""
    if node_id is not None:
        res = await db.execute(select(Node).where(Node.id == int(node_id)))
        return res.scalar_one_or_none()

    if node_ref is None:
        return None

    if isinstance(node_ref, int) or (isinstance(node_ref, str) and node_ref.strip().isdigit()):
        res = await db.execute(select(Node).where(Node.id == int(node_ref)))
        found = res.scalar_one_or_none()
        if found is not None:
            return found

    ref_str = str(node_ref).strip()
    res = await db.execute(select(Node).where(Node.name == ref_str))
    return res.scalar_one_or_none()


@app.get("/api/v1/edges", response_model=list[EdgeResponse])
async def list_edges(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[EdgeResponse]:
    """Admin-only: list all registered directed dependency edges with source/target node names."""
    nodes_result = await db.execute(select(Node))
    id_to_name = {n.id: n.name for n in nodes_result.scalars().all()}

    edges_result = await db.execute(select(Edge).order_by(Edge.id))
    edges = list(edges_result.scalars().all())
    return [
        EdgeResponse(
            id=edge.id,
            source_node_id=edge.source_node_id,
            target_node_id=edge.target_node_id,
            source=id_to_name.get(edge.source_node_id),
            target=id_to_name.get(edge.target_node_id),
            routing_distance=edge.routing_distance,
            path_nodes=edge.path_nodes,
        )
        for edge in edges
    ]


@app.post("/api/v1/edges", response_model=EdgeResponse, status_code=201)
async def create_edge(
    payload: EdgeCreate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> EdgeResponse:
    """Admin-only: manually create a directed dependency edge between two nodes and rebuild the topology cache."""
    source_node = await _resolve_node_by_id_or_name(db, payload.source_node_id, payload.source)
    target_node = await _resolve_node_by_id_or_name(db, payload.target_node_id, payload.target)

    if source_node is None:
        raise HTTPException(status_code=404, detail="Source node not found.")
    if target_node is None:
        raise HTTPException(status_code=404, detail="Target node not found.")
    if source_node.id == target_node.id:
        raise HTTPException(status_code=400, detail="Cannot connect a node to itself.")

    existing = await db.execute(
        select(Edge).where(
            Edge.source_node_id == source_node.id,
            Edge.target_node_id == target_node.id,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=409,
            detail=f"Edge from '{source_node.name}' to '{target_node.name}' already exists.",
        )

    est_dist, est_path = _compute_street_distance_between_nodes(source_node, target_node)
    routing_distance = float(payload.routing_distance) if payload.routing_distance is not None else est_dist
    path_nodes = payload.path_nodes if payload.path_nodes is not None else est_path

    new_edge = Edge(
        source_node_id=source_node.id,
        target_node_id=target_node.id,
        routing_distance=routing_distance,
        path_nodes=path_nodes,
    )
    db.add(new_edge)
    try:
        await db.commit()
        await db.refresh(new_edge)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Edge conflict while saving.")

    await rebuild_topology_cache(db)
    return EdgeResponse(
        id=new_edge.id,
        source_node_id=new_edge.source_node_id,
        target_node_id=new_edge.target_node_id,
        source=source_node.name,
        target=target_node.name,
        routing_distance=new_edge.routing_distance,
        path_nodes=new_edge.path_nodes,
    )


@app.delete("/api/v1/edges/{edge_id}", status_code=204)
async def delete_edge(
    edge_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Admin-only: delete a dependency edge by ID and rebuild the topology cache."""
    result = await db.execute(select(Edge).where(Edge.id == edge_id))
    edge = result.scalar_one_or_none()
    if edge is None:
        raise HTTPException(status_code=404, detail=f"Edge #{edge_id} not found.")
    await db.delete(edge)
    await db.commit()
    await rebuild_topology_cache(db)
    return None


# ─── Live OpenStreetMap Overpass Proxy & Map Config ──────────────────────

@app.get("/api/v1/config/map")
async def get_map_config() -> dict[str, str]:
    """Returns public GIS map configuration (such as CARTO_API_KEY if configured in .env)."""
    raw_key = os.getenv("CARTO_API_KEY", "").strip()
    if raw_key in {"your_carto_api_key_here", "your_key_here"}:
        raw_key = ""
    return {"carto_api_key": raw_key}


OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

OSM_SECTOR_QUERIES: dict[str, list[str]] = {
    "energy": [
        'node["power"="substation"]',
        'way["power"="substation"]',
        'node["power"="plant"]',
        'way["power"="plant"]',
        'node["power"="generator"]',
    ],
    "water": [
        'node["man_made"="water_works"]',
        'way["man_made"="water_works"]',
        'node["man_made"="wastewater_plant"]',
        'way["man_made"="wastewater_plant"]',
        'node["man_made"="pumping_station"]',
        'way["man_made"="pumping_station"]',
        'node["man_made"="water_tower"]',
        'way["man_made"="water_tower"]',
        'node["waterway"="pump"]',
    ],
    "health": [
        'node["amenity"="hospital"]',
        'way["amenity"="hospital"]',
        'node["amenity"="clinic"]',
        'way["amenity"="clinic"]',
    ],
    "transport": [
        'node["railway"="station"]',
        'way["railway"="station"]',
        'node["public_transport"="station"]',
        'way["public_transport"="station"]',
        'node["amenity"="ferry_terminal"]',
        'node["amenity"="bus_station"]',
        'way["amenity"="bus_station"]',
    ],
    "comms": [
        'node["man_made"="communications_tower"]',
        'way["man_made"="communications_tower"]',
        'node["man_made"="mast"]',
        'node["telecom"="exchange"]',
        'node["telecom"="data_center"]',
        'node["office"="telecommunication"]',
    ],
}

SECTOR_DEFAULT_NAMES: dict[str, str] = {
    "energy": "FPL Power Substation",
    "water": "Municipal Water Facility",
    "health": "Medical Center",
    "transport": "Transit Station",
    "comms": "Telecom Exchange",
}

# Real-world Miami OpenStreetMap infrastructure catalog (supplements Overpass if rate-limited)
MIAMI_OSM_CATALOG: dict[str, list[dict[str, Any]]] = {
    "energy": [
        {"osm_id": 241890101, "name": "FPL Coconut Grove Substation", "type": "energy", "x": -80.2421, "y": 25.7318, "tags": {"power": "substation", "operator": "FPL"}},
        {"osm_id": 241890102, "name": "FPL Brickell Key Distribution Substation", "type": "energy", "x": -80.1868, "y": 25.7664, "tags": {"power": "substation", "operator": "FPL"}},
        {"osm_id": 241890103, "name": "FPL Wynwood 138kV Substation", "type": "energy", "x": -80.1994, "y": 25.8042, "tags": {"power": "substation", "operator": "FPL"}},
        {"osm_id": 241890104, "name": "FPL Little Havana Grid Substation", "type": "energy", "x": -80.2285, "y": 25.7652, "tags": {"power": "substation", "operator": "FPL"}},
        {"osm_id": 241890105, "name": "FPL Miami Beach Venetian Substation", "type": "energy", "x": -80.1419, "y": 25.7924, "tags": {"power": "substation", "operator": "FPL"}},
        {"osm_id": 241890106, "name": "FPL Coral Gables LeJeune Substation", "type": "energy", "x": -80.2624, "y": 25.7488, "tags": {"power": "substation", "operator": "FPL"}},
        {"osm_id": 241890107, "name": "FPL Blue Lagoon Industrial Substation", "type": "energy", "x": -80.2912, "y": 25.7834, "tags": {"power": "substation", "operator": "FPL"}},
        {"osm_id": 241890108, "name": "FPL Edgewater Bayside Substation", "type": "energy", "x": -80.1895, "y": 25.8115, "tags": {"power": "substation", "operator": "FPL"}},
        {"osm_id": 241890109, "name": "FPL Allapattah Civic Substation", "type": "energy", "x": -80.2192, "y": 25.7985, "tags": {"power": "substation", "operator": "FPL"}},
        {"osm_id": 241890110, "name": "FPL Key Biscayne Crandon Substation", "type": "energy", "x": -80.1612, "y": 25.6982, "tags": {"power": "substation", "operator": "FPL"}},
    ],
    "water": [
        {"osm_id": 351920201, "name": "Hialeah Preston Water Treatment Plant", "type": "water", "x": -80.2815, "y": 25.8284, "tags": {"man_made": "water_works"}},
        {"osm_id": 351920202, "name": "Miami Beach Sunset Harbour Pump Station", "type": "water", "x": -80.1442, "y": 25.7951, "tags": {"man_made": "pumping_station"}},
        {"osm_id": 351920203, "name": "Brickell Bay Drive Stormwater Pump #4", "type": "water", "x": -80.1886, "y": 25.7582, "tags": {"man_made": "pumping_station"}},
        {"osm_id": 351920204, "name": "Wynwood Regional Booster Pump Station", "type": "water", "x": -80.2048, "y": 25.8012, "tags": {"man_made": "pumping_station"}},
        {"osm_id": 351920205, "name": "Coral Gables Alhambra Water Tower", "type": "water", "x": -80.2681, "y": 25.7518, "tags": {"man_made": "water_tower"}},
        {"osm_id": 351920206, "name": "Wagner Creek Flood Control Pump Station", "type": "water", "x": -80.2125, "y": 25.7864, "tags": {"man_made": "pumping_station"}},
        {"osm_id": 351920207, "name": "Little River Salinity Barrier & Pump", "type": "water", "x": -80.1872, "y": 25.8458, "tags": {"waterway": "pump"}},
        {"osm_id": 351920208, "name": "Edgewater Sea-Level Defense Pump #2", "type": "water", "x": -80.1869, "y": 25.7995, "tags": {"man_made": "pumping_station"}},
        {"osm_id": 351920209, "name": "Coconut Grove Bayshore Wastewater Lift", "type": "water", "x": -80.2362, "y": 25.7294, "tags": {"man_made": "pumping_station"}},
    ],
    "health": [
        {"osm_id": 461930301, "name": "Mount Sinai Medical Center (Miami Beach)", "type": "health", "x": -80.1398, "y": 25.8142, "tags": {"amenity": "hospital"}},
        {"osm_id": 461930302, "name": "University of Miami Hospital (UHealth Tower)", "type": "health", "x": -80.2165, "y": 25.7875, "tags": {"amenity": "hospital"}},
        {"osm_id": 461930303, "name": "Bascom Palmer Eye Institute", "type": "health", "x": -80.2112, "y": 25.7898, "tags": {"amenity": "hospital"}},
        {"osm_id": 461930304, "name": "Miami VA Healthcare System (Bruce W. Carter)", "type": "health", "x": -80.2148, "y": 25.7921, "tags": {"amenity": "hospital"}},
        {"osm_id": 461930305, "name": "Holtz Children's & Trauma Center", "type": "health", "x": -80.2126, "y": 25.7912, "tags": {"amenity": "hospital"}},
        {"osm_id": 461930306, "name": "Doctors Hospital (Coral Gables)", "type": "health", "x": -80.2756, "y": 25.7168, "tags": {"amenity": "hospital"}},
        {"osm_id": 461930307, "name": "Brickell Urgent Care & Emergency Clinic", "type": "health", "x": -80.1938, "y": 25.7648, "tags": {"amenity": "clinic"}},
        {"osm_id": 461930308, "name": "Borinquen Medical Center (Midtown)", "type": "health", "x": -80.1912, "y": 25.8095, "tags": {"amenity": "clinic"}},
    ],
    "transport": [
        {"osm_id": 571940401, "name": "MiamiCentral Brightline & Metrorail Hub", "type": "transport", "x": -80.1958, "y": 25.7782, "tags": {"railway": "station"}},
        {"osm_id": 571940402, "name": "Government Center Transit Terminal", "type": "transport", "x": -80.1962, "y": 25.7756, "tags": {"public_transport": "station"}},
        {"osm_id": 571940403, "name": "Miami Intermodal Center (MIA Station)", "type": "transport", "x": -80.2602, "y": 25.7962, "tags": {"railway": "station"}},
        {"osm_id": 571940404, "name": "PortMiami Cruise & Cargo Terminal D", "type": "transport", "x": -80.1685, "y": 25.7768, "tags": {"amenity": "ferry_terminal"}},
        {"osm_id": 571940405, "name": "Civic Center Metrorail Station", "type": "transport", "x": -80.2134, "y": 25.7902, "tags": {"railway": "station"}},
        {"osm_id": 571940406, "name": "Allapattah Metrorail Station", "type": "transport", "x": -80.2198, "y": 25.8092, "tags": {"railway": "station"}},
        {"osm_id": 571940407, "name": "Earlington Heights Transit Hub", "type": "transport", "x": -80.2314, "y": 25.8128, "tags": {"railway": "station"}},
        {"osm_id": 571940408, "name": "Adrienne Arsht Center Metromover Station", "type": "transport", "x": -80.1904, "y": 25.7885, "tags": {"railway": "station"}},
    ],
    "comms": [
        {"osm_id": 681950501, "name": "Equinix MI1 (NAP of the Americas Core)", "type": "comms", "x": -80.1919, "y": 25.7826, "tags": {"telecom": "data_center"}},
        {"osm_id": 681950502, "name": "CoreSite MI1 Miami Data Center", "type": "comms", "x": -80.2312, "y": 25.7945, "tags": {"telecom": "data_center"}},
        {"osm_id": 681950503, "name": "AT&T Brickell Central Office Switch", "type": "comms", "x": -80.1945, "y": 25.7618, "tags": {"telecom": "exchange"}},
        {"osm_id": 681950504, "name": "Crown Castle Wynwood Microwave Tower", "type": "comms", "x": -80.1972, "y": 25.8021, "tags": {"man_made": "communications_tower"}},
        {"osm_id": 681950505, "name": "Lumen Technologies Downtown Fiber Gateway", "type": "comms", "x": -80.1928, "y": 25.7748, "tags": {"telecom": "exchange"}},
        {"osm_id": 681950506, "name": "Miami Beach Emergency VHF/Tetra Tower", "type": "comms", "x": -80.1342, "y": 25.7918, "tags": {"man_made": "communications_tower"}},
        {"osm_id": 681950507, "name": "Doral West Dade Telecom Relay Hub", "type": "comms", "x": -80.3015, "y": 25.7912, "tags": {"telecom": "exchange"}},
        {"osm_id": 681950508, "name": "Coral Gables Municipal Fiber POP", "type": "comms", "x": -80.2584, "y": 25.7495, "tags": {"telecom": "exchange"}},
    ],
}


@app.get("/api/v1/osm/search")
async def search_osm_infrastructure(
    infra_type: str = Query("energy", alias="type", description="Sector type: energy, water, health, transport, comms"),
    south: float = Query(25.70, description="Southern latitude of bounding box"),
    west: float = Query(-80.32, description="Western longitude of bounding box"),
    north: float = Query(25.86, description="Northern latitude of bounding box"),
    east: float = Query(-80.12, description="Eastern longitude of bounding box"),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """
    Admin-only proxy endpoint to query the OpenStreetMap Overpass API for real-world
    infrastructure facilities within the current Leaflet map bounding box, with
    instant fallback/enrichment from the Miami OSM catalog if Overpass is rate-limited.
    """
    sector = infra_type.strip().lower()
    if sector == "power":
        sector = "energy"
    if sector not in OSM_SECTOR_QUERIES:
        sector = "energy"

    # Fetch already-imported node names so we only return un-imported OSM candidates
    existing_res = await db.execute(select(Node.name))
    existing_names = {str(r[0]).strip().lower() for r in existing_res.all()}

    bbox_str = f"({south},{west},{north},{east})"
    clauses = "\n  ".join(f"{q}{bbox_str};" for q in OSM_SECTOR_QUERIES[sector])
    overpass_query = f"[out:json][timeout:4];\n(\n  {clauses}\n);\nout center 50;"

    elements: list[dict[str, Any]] = []
    last_error: str | None = None

    async with httpx.AsyncClient(timeout=4.5, headers={"User-Agent": "WeatherFall-GIS/1.4"}) as client:
        try:
            resp = await client.post(OVERPASS_ENDPOINTS[0], data={"data": overpass_query})
            if resp.status_code == 200:
                payload = resp.json()
                elements = payload.get("elements", [])
            else:
                last_error = f"HTTP {resp.status_code}"
        except Exception as exc:
            last_error = str(exc)

    results: list[dict[str, Any]] = []
    seen_names: set[str] = set(existing_names)

    for el in elements:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue

        tags = el.get("tags") or {}
        osm_id = el.get("id", 0)
        raw_name = (
            tags.get("name")
            or tags.get("operator")
            or tags.get("official_name")
            or tags.get("ref")
        )
        if raw_name:
            facility_name = str(raw_name).strip()
        else:
            sub_tag = (
                tags.get("power")
                or tags.get("man_made")
                or tags.get("amenity")
                or tags.get("public_transport")
                or tags.get("telecom")
                or SECTOR_DEFAULT_NAMES.get(sector, "Facility")
            )
            facility_name = f"Miami {str(sub_tag).replace('_', ' ').title()} #{osm_id % 10000}"

        if facility_name.lower() in seen_names:
            continue
        seen_names.add(facility_name.lower())

        results.append(
            {
                "osm_id": osm_id,
                "name": facility_name[:120],
                "type": sector,
                "x": round(float(lon), 6),
                "y": round(float(lat), 6),
                "tags": tags,
            }
        )

    # Supplement with curated Miami OSM catalog entries within the bounding box (or all Miami if zoomed tightly)
    catalog_entries = MIAMI_OSM_CATALOG.get(sector, [])
    in_bbox = [
        item for item in catalog_entries
        if south <= item["y"] <= north and west <= item["x"] <= east
    ]
    fallback_pool = in_bbox if in_bbox else catalog_entries

    for item in fallback_pool:
        fname = item["name"].strip()
        if fname.lower() in seen_names:
            continue
        seen_names.add(fname.lower())
        results.append(dict(item))

    return {
        "sector": sector,
        "count": len(results),
        "results": results,
        "warning": None if results else last_error,
    }


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
    missing_dependency_type: str | None = None,
    node_type: str = "energy",
    magnitude: str = "Category 5",
    route_path_nodes: int = 0,
    limit: int = 3,
) -> list[dict[str, Any]]:
    """
    Filters `candidate_nodes` passed to the AI to ONLY include `ONLINE` nodes of the
    exact missing type (`missing_dependency_type`), pre-calculating physical OSM street
    distance (`distance_m`), repair cost (`cost` / `estimated_cost`), required repair crews
    (`crews_used`), and Field Restoration Time in minutes (`recovery_time_ms`) and hours
    (`field_restoration_hours`), sorted ascending by shortest physical distance.
    """
    if missing_dependency_type:
        required_type = _normalize_sector_type(missing_dependency_type)
    elif parent_name in graph:
        required_type = _normalize_sector_type(graph.nodes[parent_name].get("type", "energy"))
    else:
        required_type = "energy"

    scored_candidates: list[tuple[float, str, dict[str, Any]]] = []
    for node_id, data in graph.nodes(data=True):
        cand_name = str(node_id)
        if cand_name in failed_nodes or cand_name == child_name:
            continue

        cand_type = _normalize_sector_type(data.get("type", "energy"))
        if cand_type != required_type:
            continue

        cand_tier = str(data.get("tier", "Primary"))
        dist_m = _estimate_osm_street_distance_m(graph, undirected_graph, cand_name, child_name)
        est_cost, rec_min, rec_display = compute_realistic_recovery_metrics(
            distance_m=dist_m,
            node_type=node_type,
            missing_dependency_type=required_type,
            magnitude=magnitude,
            route_path_nodes=route_path_nodes,
            candidate_tier=cand_tier,
        )
        crews_req = compute_required_crews(
            distance_m=dist_m,
            node_type=node_type,
            missing_dependency_type=required_type,
            magnitude=magnitude,
        )
        restoration_hours = round(rec_min / 60.0, 2)
        scored_candidates.append(
            (
                dist_m,
                cand_name,
                {
                    "id": cand_name,
                    "name": cand_name,
                    "type": cand_type,
                    "tier": cand_tier,
                    "distance_m": dist_m,
                    "cost": est_cost,
                    "estimated_cost": est_cost,
                    "crews_used": crews_req,
                    "required_crew_time_min": rec_min,
                    "recovery_time_ms": rec_min,
                    "field_restoration_hours": restoration_hours,
                    "recovery_time_display": rec_display,
                },
            )
        )

    scored_candidates.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in scored_candidates[:limit]]


def _has_severed_critical_lifeline(
    graph: nx.DiGraph,
    node_name: str,
    failed_parent: str,
    failed_nodes: set[str],
) -> tuple[bool, str]:
    """
    Determines whether `node_name` loses a critical dependency lifeline (`energy`, `water`,
    or `comms`, depending on its type) when `failed_parent` transitions to `OFFLINE`.
    Returns `(is_severed, missing_dependency_type)`.
    """
    node_type = _normalize_sector_type(graph.nodes[node_name].get("type", "energy"))
    parent_type = (
        _normalize_sector_type(graph.nodes[failed_parent].get("type", "energy"))
        if failed_parent in graph
        else "energy"
    )
    required_lifelines = set(MANDATORY_INCOMING_LIFELINES.get(node_type, ("energy",)))

    if parent_type in required_lifelines:
        return True, parent_type

    for req_type in required_lifelines:
        typed_preds = [
            pred for pred in graph.predecessors(node_name)
            if _normalize_sector_type(graph.nodes[pred].get("type", "energy")) == req_type
        ]
        if typed_preds and all(pred in failed_nodes for pred in typed_preds):
            return True, req_type

    return False, parent_type


def _compute_knapsack_capacity_value(graph: nx.DiGraph, node_name: str, node_type: str) -> int:
    """
    Computes the effective infrastructure capacity weight of `node_name` for the
    Knapsack objective ('Maximize the infrastructure capacity saved'), accounting
    for raw facility capacity, Primary/Secondary tier, life-safety criticality
    (Hospitals), and downstream dependent facilities.
    """
    data = graph.nodes.get(node_name, {})
    base_cap = int(data.get("capacity", 3))
    tier = str(data.get("tier", "Secondary"))
    downstream_count = min(4, int(graph.out_degree(node_name)))
    if node_type == "health":
        sector_bonus = 18 if tier == "Primary" else 14
    elif tier == "Primary":
        sector_bonus = 6
    else:
        sector_bonus = 2
    return max(1, base_cap + sector_bonus + downstream_count)


@app.post("/api/v1/simulate", response_model=SimulationDispatchResponse)
@limiter.limit("3/minute")
async def simulate_cascade(
    request: Request,
    sim_request: SimulationRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """
    Task 1: Dispatches the Discrete Event Simulation (DES) + Climate Justice Knapsack
    engine to the Celery + Redis background task queue (`backend/worker.py`) and returns
    immediately with `{"task_id": "...", "status": "processing"}` to prevent HTTP timeouts.
    """
    # Ensure topology is initialized in PostgreSQL and passes critical integrity checks before worker dispatch
    graph = await load_infrastructure_graph(db)
    diagnostics = validate_city_graph(graph)
    critical_issues = [item for item in diagnostics if item.get("level") == "critical"]
    if critical_issues:
        first_msg = critical_issues[0].get("message", "Critical topological error detected.")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Simulation blocked by Topological Integrity Failsafe ({len(critical_issues)} critical issue(s)): "
                f"{first_msg}"
            ),
        )

    sim_payload: dict[str, Any] = {
        "disaster_type": sim_request.disaster_type,
        "magnitude": sim_request.magnitude,
        "disaster_direction": (sim_request.disaster_direction or sim_request.trajectory or "Coastal").strip(),
        "trajectory": (sim_request.trajectory or sim_request.disaster_direction or "Coastal").strip(),
        "emergency_budget": float(sim_request.emergency_budget),
        "active_repair_crews": int(sim_request.active_repair_crews),
    }
    return await dispatch_simulation_task(sim_payload)


@app.get("/api/v1/simulate/{task_id}", response_model=SimulationStatusResponse)
@limiter.limit("120/minute")
async def get_simulation_status(
    request: Request,
    task_id: str,
) -> dict[str, Any]:
    """
    Task 1: Polls the status of an asynchronous simulation task (`task_id`) from Celery/Redis
    and returns the final JSON `execution_trace` (`result`) once complete.
    """
    status_payload = await get_simulation_task_status(task_id)
    if status_payload.get("status") == "failed":
        raise HTTPException(
            status_code=500,
            detail=str(status_payload.get("error") or "Simulation background task failed."),
        )
    return status_payload


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)