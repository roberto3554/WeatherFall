from datetime import datetime
from typing import Any, Optional
from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

try:
    from .database import Base
except ImportError:
    from database import Base


class User(Base):
    """Operator account for the WeatherFall admin console."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(60), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Node(Base):
    """Represents a real-world critical urban infrastructure node with spatial coordinates."""

    __tablename__ = "nodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    x: Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=0.0)
    y: Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=0.0)
    tier: Mapped[Optional[str]] = mapped_column(String(30), nullable=True, default="Secondary")
    capacity: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=3)
    battery_backup_hours: Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=24.0)

    outgoing_edges: Mapped[list["Edge"]] = relationship(
        "Edge",
        foreign_keys="Edge.source_node_id",
        back_populates="source_node",
        cascade="all, delete-orphan",
    )
    incoming_edges: Mapped[list["Edge"]] = relationship(
        "Edge",
        foreign_keys="Edge.target_node_id",
        back_populates="target_node",
        cascade="all, delete-orphan",
    )


class Edge(Base):
    """Represents a directed dependency edge (source_node -> target_node) routed over the street grid."""

    __tablename__ = "edges"
    __table_args__ = (
        UniqueConstraint("source_node_id", "target_node_id", name="uq_edge_source_target"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source_node_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("nodes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    target_node_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("nodes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    routing_distance: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        default=None,
    )
    path_nodes: Mapped[Optional[Any]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=True,
        default=None,
    )

    source_node: Mapped["Node"] = relationship(
        "Node",
        foreign_keys=[source_node_id],
        back_populates="outgoing_edges",
    )
    target_node: Mapped["Node"] = relationship(
        "Node",
        foreign_keys=[target_node_id],
        back_populates="incoming_edges",
    )


class SimulationTrace(Base):
    """Stores the JSON execution trace of a cascading failure simulation run."""

    __tablename__ = "simulation_traces"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    disaster_type: Mapped[str] = mapped_column(String(100), nullable=False)
    magnitude: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    epicenter_node: Mapped[str] = mapped_column(String(120), nullable=False)
    trace_data: Mapped[Any] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )