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


# ─── Infrastructure Nodes ────────────────────────────────────────────────

class NodeCreate(BaseModel):
    """Payload to register a new critical infrastructure node."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=120)
    type: str = Field(..., min_length=1, max_length=60)
    x: float = Field(..., description="Longitude or canvas X coordinate.")
    y: float = Field(..., description="Latitude or canvas Y coordinate.")


class NodeUpdate(BaseModel):
    """Payload to partially update an existing node."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(None, min_length=1, max_length=120)
    type: Optional[str] = Field(None, min_length=1, max_length=60)
    x: Optional[float] = None
    y: Optional[float] = None


class NodeResponse(BaseModel):
    """Public representation of a critical infrastructure node."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    type: str
    x: float
    y: float


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
    trajectory: str = Field(
        ...,
        min_length=1,
        examples=["Coming from the Atlantic East coast"],
        description="Geographical trajectory or approach vector of the disaster.",
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
    reasoning: str = Field(..., description="AI reasoning (max 25 words).")
    recovery_command: Optional[str] = Field(default=None)
    new_edge: Optional[dict[str, Any]] = Field(default=None)