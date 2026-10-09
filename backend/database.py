import os
from collections.abc import AsyncGenerator
from urllib.parse import urlparse, urlunparse, parse_qs, urlencode

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase


def prepare_asyncpg_url(raw_url: str) -> tuple[str, dict]:
    """
    Adapta una URL de conexión PostgreSQL para que sea compatible con asyncpg.

    - Elimina 'sslmode' y 'channel_binding' de la query string (asyncpg no los acepta).
    - Devuelve el modo SSL como connect_arg ('ssl': 'require').
    - Añade 'statement_cache_size=0' para compatibilidad con el pooler de Neon.
    """
    if not raw_url:
        return raw_url, {}

    # Normaliza el prefijo del driver
    url = raw_url.replace("postgresql://", "postgresql+asyncpg://", 1)

    parsed = urlparse(url)
    query_params = parse_qs(parsed.query)

    # Extrae sslmode y lo elimina de la query (asyncpg no lo soporta)
    sslmode = query_params.pop("sslmode", [None])[0]

    # Parámetros problemáticos que Neon añade y asyncpg no entiende
    query_params.pop("channel_binding", None)
    query_params.pop("options", None)

    new_query = urlencode(query_params, doseq=True)
    new_url = urlunparse(parsed._replace(query=new_query))

    connect_args: dict = {}

    # asyncpg acepta 'ssl' como string ("require", "prefer", "allow", etc.)
    if sslmode:
        connect_args["ssl"] = sslmode
    else:
        # Neon exige SSL siempre; si no viene en la URL, lo forzamos
        connect_args["ssl"] = "require"

    # Requerido para el pooler de Neon (PgBouncer en modo transaction)
    connect_args["statement_cache_size"] = 0

    return new_url, connect_args


RAW_DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://weatherfall:weatherfall_pass@localhost:5433/weatherfall_db",
)

DATABASE_URL, CONNECT_ARGS = prepare_asyncpg_url(RAW_DATABASE_URL)

POOL_SIZE: int = int(os.getenv("DB_POOL_SIZE", "20"))
MAX_OVERFLOW: int = int(os.getenv("DB_MAX_OVERFLOW", "10"))
POOL_TIMEOUT: int = int(os.getenv("DB_POOL_TIMEOUT", "30"))
POOL_RECYCLE: int = int(os.getenv("DB_POOL_RECYCLE", "300"))


engine: AsyncEngine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=POOL_SIZE,
    max_overflow=MAX_OVERFLOW,
    pool_timeout=POOL_TIMEOUT,
    pool_recycle=POOL_RECYCLE,
    connect_args=CONNECT_ARGS,
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
