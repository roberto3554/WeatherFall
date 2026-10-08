import os
from collections.abc import AsyncGenerator
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase


DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://weatherfall:weatherfall_pass@localhost:5433/weatherfall_db",
)

POOL_SIZE: int = int(os.getenv("DB_POOL_SIZE", "20"))
MAX_OVERFLOW: int = int(os.getenv("DB_MAX_OVERFLOW", "10"))
POOL_TIMEOUT: int = int(os.getenv("DB_POOL_TIMEOUT", "30"))
POOL_RECYCLE: int = int(os.getenv("DB_POOL_RECYCLE", "1800"))

engine: AsyncEngine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=POOL_SIZE,
    max_overflow=MAX_OVERFLOW,
    pool_timeout=POOL_TIMEOUT,
    pool_recycle=POOL_RECYCLE,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy ORM models."""


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding an async SQLAlchemy database session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db() -> None:
    """Creates all database tables registered on Base.metadata if they do not exist."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
