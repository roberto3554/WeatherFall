from typing import Any, Optional
from pydantic import BaseModel, ConfigDict, Field


# ─── Auth ────────────────────────────────────────────────────────────────

class UserLogin(BaseModel):
    """Credentials submitted by an operator to obtain a JWT."""

    model_config = ConfigDict(extra="forbid")

    username: str = Field(..., min_length=1, max_length=60)
    password: str = Field(..., min_length=1, max_length=128)


class UserCreate(UserLogin):
    """Payload for creating a new operator account."""

    is_admin: bool = Field(default=False)


class Token(BaseModel):
    """JWT response payload returned on successful login."""

    access_token: str
    token_type: str = "bearer"
    username: str
    is_admin: bool


class UserResponse(BaseModel):
    """Public representation of an operator account."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    is_admin: bool
    is_active: bool


# ─── Infrastructure Nodes & Edges ────────────────────────────────────────

class NodeCreate(BaseModel):
    """Payload to register a new critical infrastructure node."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=120)
    type: str = Field(..., min_length=1, max_length=60)
    x: float = Field(..., description="Longitude or canvas X coordinate.")
    y: float = Field(..., description="Latitude or canvas Y coordinate.")
    tier: Optional[str] = Field(default="Secondary", description="Hierarchical tier: 'Primary' or 'Secondary'.")
    capacity: Optional[int] = Field(default=3, description="Maximum downstream flow / out-degree capacity.")
    battery_backup_hours: Optional[float] = Field(
        default=24.0,
        description="Temporal backup autonomy in hours before cyclic dependency failure.",
    )
    auto_connect: bool = Field(
        default=True,
        description="Whether to automatically connect the new node to the nearest compatible node.",
    )


class NodeUpdate(BaseModel):
    """Payload to partially update an existing node."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(None, min_length=1, max_length=120)
    type: Optional[str] = Field(None, min_length=1, max_length=60)
    x: Optional[float] = None
    y: Optional[float] = None
    tier: Optional[str] = None
    capacity: Optional[int] = None
    battery_backup_hours: Optional[float] = None


class NodeResponse(BaseModel):
    """Public representation of a critical infrastructure node."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    type: str
    x: float
    y: float
    tier: Optional[str] = "Secondary"
    capacity: Optional[int] = 3
    battery_backup_hours: Optional[float] = 24.0


class EdgeCreate(BaseModel):
    """Payload to manually create a directed dependency edge between two nodes."""

    model_config = ConfigDict(extra="forbid")

    source_node_id: Optional[int] = Field(
        default=None,
        description="Database ID of the upstream source node.",
    )
    target_node_id: Optional[int] = Field(
        default=None,
        description="Database ID of the downstream target node.",
    )
    source: Optional[int | str] = Field(
        default=None,
        description="Source node ID or facility name (alternative to source_node_id).",
    )
    target: Optional[int | str] = Field(
        default=None,
        description="Target node ID or facility name (alternative to target_node_id).",
    )
    routing_distance: Optional[float] = Field(
        default=None,
        description="Optional physical surface route distance in meters.",
    )
    path_nodes: Optional[list[Any]] = Field(
        default=None,
        description="Optional list of street intersection node IDs along the route.",
    )


class EdgeResponse(BaseModel):
    """Public representation of a directed infrastructure dependency edge."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    source_node_id: int
    target_node_id: int
    source: Optional[str] = None
    target: Optional[str] = None
    routing_distance: Optional[float] = None
    path_nodes: Optional[Any] = None


# ─── Simulation ──────────────────────────────────────────────────────────

class SimulationRequest(BaseModel):
    """Request payload for triggering a climate risk cascade simulation."""

    model_config = ConfigDict(extra="forbid")

    disaster_type: str = Field(
        ...,
        min_length=1,
        examples=["Hurricane", "Storm Surge Flood", "Tornado"],
        description="The type of climate disaster impacting the infrastructure grid.",
    )
    magnitude: str = Field(
        default="Category 5",
        min_length=1,
        examples=["Category 5", "EF-3", "Water level +2.5m"],
        description="Physical scale or intensity metric of the disaster.",
    )
    disaster_direction: str = Field(
        default="Coastal",
        min_length=1,
        examples=["North-West", "Coastal", "Atlantic East"],
        description="Cardinal or geographical vector from which the disaster strikes (e.g., 'North-West', 'Coastal').",
    )
    trajectory: Optional[str] = Field(
        default=None,
        examples=["Coming from the Atlantic East coast"],
        description="Optional geographical trajectory description (defaults to disaster_direction if omitted).",
    )


class NewEdge(BaseModel):
    """Emergency self-healing edge proposed by the AI with cost and latency metrics."""

    model_config = ConfigDict(extra="allow")

    source: str = Field(..., description="ID/name of the alive candidate node supplying recovery.")
    target: str = Field(..., description="ID/name of the failed node receiving emergency supply.")
    estimated_cost: int = Field(
        ...,
        description="Estimated emergency deployment cost (e.g., USD or thousands of dollars).",
    )
    recovery_time_ms: int = Field(
        ...,
        description="Propagation delay or deployment latency in milliseconds.",
    )


class NodeState(BaseModel):
    """Evaluated state of a single infrastructure node in the self-healing simulation trace."""

    model_config = ConfigDict(extra="forbid")

    step: Optional[str] = Field(
        default="cascade",
        description="Type of trace step: 'impact' or 'cascade'.",
    )
    node: Optional[str] = Field(default=None)
    parent_node: Optional[str] = Field(default=None)
    child_node: Optional[str] = Field(default=None)
    node_name: Optional[str] = Field(default=None)
    node_type: str = Field(default="unknown")
    magnitude: Optional[str] = Field(default=None)
    status: bool = Field(default=False)
    reasoning: str = Field(..., description="AI reasoning balancing cost, latency, and physics.")
    recovery_command: Optional[str] = Field(default=None)
    estimated_cost: Optional[int] = Field(
        default=None,
        description="Estimated cost for emergency rerouting deployment when recovery is proposed.",
    )
    recovery_time_ms: Optional[int] = Field(
        default=None,
        description="Estimated recovery/propagation time in ms when recovery is proposed.",
    )
    new_edge: Optional[NewEdge] = Field(default=None)