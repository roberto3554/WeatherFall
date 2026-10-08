from typing import Any, Literal, Optional
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
    social_vulnerability_index: Optional[float] = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Social Vulnerability Index (SVI, 0.0 to 1.0) of the surrounding neighborhood.",
    )
    population_served: Optional[int] = Field(
        default=25000,
        ge=0,
        description="Estimated residential/civilian population served by this facility.",
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
    social_vulnerability_index: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    population_served: Optional[int] = Field(default=None, ge=0)


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
    social_vulnerability_index: Optional[float] = 0.5
    population_served: Optional[int] = 25000


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
    """Request payload for triggering a climate risk cascade simulation with finite Knapsack resources."""

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
    emergency_budget: float = Field(
        default=5000000.0,
        ge=0.0,
        examples=[5000000.0, 750000.0],
        description="Finite global emergency budget in USD available across the cascade simulation.",
    )
    active_repair_crews: int = Field(
        default=3,
        ge=0,
        examples=[3, 5],
        description="Finite global number of active field repair crews available across the cascade simulation.",
    )


class Event(BaseModel):
    """Task 1: Discrete Event Simulation (DES) priority queue event schema."""

    model_config = ConfigDict(extra="allow")

    event_time: float = Field(
        ...,
        ge=0.0,
        examples=[0.0, 1.5, 3.25],
        description="Global simulation clock timestamp T (in hours) when this event triggers.",
    )
    event_type: str = Field(
        ...,
        examples=["EPICENTER_IMPACT", "CRITICAL_BATTERY", "RECOVERY_COMPLETED", "BATTERY_DEPLETED"],
        description="DES event type identifier.",
    )
    node_id: str = Field(
        ...,
        examples=["Jackson Memorial Hospital", "Buena Vista Substation"],
        description="Identifier/name of the infrastructure node associated with this event.",
    )


class NewEdge(BaseModel):
    """Emergency self-healing edge selected by the AI dispatcher with cost, crews_used, and field restoration time."""

    model_config = ConfigDict(extra="allow")

    source: str = Field(..., description="ID/name of the alive candidate node supplying recovery.")
    target: str = Field(..., description="ID/name of the failed node receiving emergency supply.")
    cost: int = Field(
        ...,
        description="Emergency deployment cost in USD deducted from the global budget.",
    )
    crews_used: int = Field(
        default=1,
        ge=1,
        description="Number of active repair crews assigned to establish this recovery route.",
    )
    estimated_cost: Optional[int] = Field(
        default=None,
        description="Alias for emergency deployment cost in USD (matches `cost`).",
    )
    recovery_time_ms: Optional[int] = Field(
        default=None,
        description="Estimated field restoration duration in minutes.",
    )
    field_restoration_hours: Optional[float] = Field(
        default=None,
        description="Estimated field restoration duration in hours (must be strictly less than remaining battery time).",
    )
    recovery_time_display: Optional[str] = Field(
        default=None,
        description="Formatted human-readable restoration duration (e.g. '45 min' or '1h 25m').",
    )


class AgentDebateEntry(BaseModel):
    """Single agent proposal or Supervisor verdict in the Multi-Agent Crisis Committee deliberation."""

    model_config = ConfigDict(extra="allow")

    agent: str = Field(
        ...,
        examples=["Engineering_Agent", "Social_Agent", "Finance_Agent", "Supervisor_Agent"],
        description="Crisis Committee agent persona identifier.",
    )
    role: Optional[str] = Field(
        default=None,
        description="Human-readable crisis committee role of the agent.",
    )
    node_id: Optional[str] = Field(
        default=None,
        description="Identifier of the failing node evaluated by this agent.",
    )
    status: bool = Field(
        default=True,
        description="Whether this agent recommends dispatching a recovery route (true) or deferring/abandoning (false).",
    )
    cost: Optional[int] = Field(
        default=None,
        description="Estimated emergency recovery cost in USD for the proposed route.",
    )
    new_edge: Optional[dict[str, Any]] = Field(
        default=None,
        description="Proposed recovery route ({'source': ..., 'target': ..., 'cost': ..., 'crews_used': ...}).",
    )
    proposal: str = Field(
        ...,
        description="The agent's proposal rationale or Supervisor_Agent's 20-word negotiation summary.",
    )
    negotiation_summary: Optional[str] = Field(
        default=None,
        description="Concise (~20-word) summary of the committee negotiation (populated on Supervisor_Agent).",
    )


class NodeState(BaseModel):
    """Evaluated state of a single infrastructure node in the Discrete Event Simulation (DES) trace."""

    model_config = ConfigDict(extra="allow")

    step: Optional[str] = Field(
        default="cascade",
        description="Type of trace step: 'impact', 'critical_battery', or 'cascade'.",
    )
    event_time: float = Field(
        default=0.0,
        ge=0.0,
        description="Global simulation clock T (in hours) when this event occurred.",
    )
    event_type: Optional[str] = Field(
        default=None,
        description="DES event type: 'EPICENTER_IMPACT', 'CRITICAL_BATTERY', 'RECOVERY_COMPLETED', or 'BATTERY_DEPLETED'.",
    )
    node_state: Literal["ONLINE", "CRITICAL_BATTERY", "OFFLINE"] = Field(
        default="OFFLINE",
        description="Discrete Event Simulation node state: 'ONLINE', 'CRITICAL_BATTERY', or 'OFFLINE'.",
    )
    battery_backup_hours: Optional[float] = Field(
        default=None,
        description="Total UPS/battery backup duration in hours when entering CRITICAL_BATTERY.",
    )
    battery_deadline: Optional[float] = Field(
        default=None,
        description="Global simulation timestamp (T + battery_backup_hours) at which battery depletes if unrecovered.",
    )
    bfs_depth: Optional[int] = Field(
        default=0,
        description="Cascade wave depth in which this node was triggered.",
    )
    node: Optional[str] = Field(default=None)
    parent_node: Optional[str] = Field(default=None)
    child_node: Optional[str] = Field(default=None)
    node_name: Optional[str] = Field(default=None)
    node_type: str = Field(default="unknown")
    svi_score: Optional[float] = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Social Vulnerability Index (SVI, 0.0 to 1.0) of the evaluated node.",
    )
    population_served: Optional[int] = Field(
        default=25000,
        ge=0,
        description="Estimated residential/civilian population served by the evaluated node.",
    )
    magnitude: Optional[str] = Field(default=None)
    status: bool = Field(default=False)
    reasoning: str = Field(..., description="Time-aware AI dispatcher & Knapsack trade-off reasoning.")
    recovery_command: Optional[str] = Field(default=None)
    estimated_cost: Optional[int] = Field(
        default=None,
        description="Estimated cost in USD deducted when recovery is scheduled/completed.",
    )
    crews_used: Optional[int] = Field(
        default=None,
        description="Repair crews assigned when recovery is scheduled/completed.",
    )
    recovery_time_ms: Optional[int] = Field(
        default=None,
        description="Estimated field restoration duration in minutes when recovery is scheduled/completed.",
    )
    remaining_budget: Optional[float] = Field(
        default=None,
        description="Remaining global emergency budget in USD after this step.",
    )
    remaining_crews: Optional[int] = Field(
        default=None,
        description="Remaining global repair crews available after this step.",
    )
    crew_release_notice: Optional[str] = Field(
        default=None,
        description="Explicit notice when a repair crew is released back to the pool upon RECOVERY_COMPLETED.",
    )
    agent_debate_log: Optional[list[AgentDebateEntry] | list[dict[str, Any]] | dict[str, Any]] = Field(
        default=None,
        description=(
            "Multi-Agent Crisis Committee deliberation log containing recovery proposals from "
            "Engineering_Agent, Social_Agent, and Finance_Agent, plus the Supervisor_Agent negotiation summary."
        ),
    )
    new_edge: Optional[NewEdge] = Field(default=None)


class SimulationDispatchResponse(BaseModel):
    """Response returned when POST /api/v1/simulate dispatches a Celery background task."""

    task_id: str = Field(..., description="Unique Celery task UUID.")
    status: str = Field(default="processing", description="Task execution status ('processing').")


class SimulationStatusResponse(BaseModel):
    """Response returned by GET /api/v1/simulate/{task_id} while polling task status."""

    task_id: str = Field(..., description="Unique Celery task UUID.")
    status: str = Field(
        ...,
        description="Task status: 'processing', 'completed', or 'failed'.",
    )
    state: str = Field(
        default="PENDING",
        description="Celery raw task state (e.g. 'PENDING', 'STARTED', 'SUCCESS', 'FAILURE').",
    )
    result: Optional[list[NodeState]] = Field(
        default=None,
        description="Completed DES execution trace once status is 'completed'.",
    )
    execution_trace: Optional[list[NodeState]] = Field(
        default=None,
        description="Alias for result containing the completed DES execution trace.",
    )
    error: Optional[str] = Field(
        default=None,
        description="Error message if status is 'failed'.",
    )


class DiagnosticIssue(BaseModel):
    """Single topological integrity diagnostic issue returned by validate_city_graph(G)."""

    model_config = ConfigDict(extra="allow")

    level: Literal["critical", "warning"] = Field(
        ...,
        examples=["critical", "warning"],
        description="Severity level: 'critical' (Cycle deadlock or Orphan) or 'warning' (Capacity bottleneck).",
    )
    node_id: str = Field(
        ...,
        examples=["Jackson Memorial Hospital", "Miami Substation"],
        description="Identifier/name of the infrastructure node where the issue was detected.",
    )
    message: str = Field(
        ...,
        description="Human-readable diagnostic description of the cycle, orphan, or bottleneck.",
    )
    category: Optional[str] = Field(
        default=None,
        examples=["cycle", "orphan", "bottleneck"],
        description="Diagnostic category ('cycle', 'orphan', or 'bottleneck').",
    )
    node_type: Optional[str] = Field(
        default=None,
        examples=["health", "energy", "water", "comms", "transport"],
        description="Facility sector of the affected node.",
    )