"""Authentication utilities: password hashing, JWT issuance, session revocation, and FastAPI dependencies."""
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

try:
    from .database import get_db
    from .models import User
except ImportError:
    from database import get_db
    from models import User


SECRET_KEY = os.getenv("SECRET_KEY", "weatherfall-dev-secret-change-me-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "480"))
SESSION_COOKIE_NAME = "weatherfall_session"

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)

# Server-side denylist of revoked JWT IDs (jti) and raw tokens upon explicit sign-out
_REVOKED_TOKEN_JTIS: set[str] = set()


def hash_password(password: str) -> str:
    """Hash a plaintext password with PBKDF2-SHA256."""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plaintext password against a stored hash."""
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except Exception:
        return False


def create_access_token(
    subject: str,
    is_admin: bool = False,
    expires_delta: Optional[timedelta] = None,
) -> str:
    """Create a signed JWT access token with unique jti and issued-at timestamps."""
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    payload = {
        "sub": subject,
        "is_admin": bool(is_admin),
        "iat": int(now.timestamp()),
        "exp": expire,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def revoke_token(token: Optional[str]) -> None:
    """Revoke a JWT token immediately so it can no longer be used before its exp time."""
    if not token:
        return
    try:
        payload = jwt.decode(
            token,
            SECRET_KEY,
            algorithms=[ALGORITHM],
            options={"verify_exp": False},
        )
        jti = payload.get("jti")
        if jti and isinstance(jti, str):
            _REVOKED_TOKEN_JTIS.add(jti)
        else:
            _REVOKED_TOKEN_JTIS.add(token)
    except JWTError:
        _REVOKED_TOKEN_JTIS.add(token)


def extract_request_token(request: Request, bearer_token: Optional[str] = None) -> Optional[str]:
    """Extract JWT from Authorization Bearer header or fallback to the HttpOnly session cookie."""
    if bearer_token and bearer_token.strip():
        return bearer_token.strip()
    cookie_token = request.cookies.get(SESSION_COOKIE_NAME)
    if cookie_token and cookie_token.strip():
        return cookie_token.strip()
    return None


def decode_and_verify_token(raw_token: str) -> dict[str, Any]:
    """Decode JWT, verify signature/expiration, and ensure the token has not been revoked."""
    if raw_token in _REVOKED_TOKEN_JTIS:
        raise JWTError("Token has been revoked.")
    payload = jwt.decode(raw_token, SECRET_KEY, algorithms=[ALGORITHM])
    jti = payload.get("jti")
    if jti and jti in _REVOKED_TOKEN_JTIS:
        raise JWTError("Session token has been revoked.")
    return payload


async def get_current_user(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """FastAPI dependency: resolve the authenticated User from Bearer token or HttpOnly session cookie."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required. Please sign in to continue.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    candidates: list[str] = []
    if token and token.strip():
        candidates.append(token.strip())
    cookie_token = request.cookies.get(SESSION_COOKIE_NAME)
    if cookie_token and cookie_token.strip() and cookie_token.strip() not in candidates:
        candidates.append(cookie_token.strip())

    if not candidates:
        raise credentials_exception

    username: Optional[str] = None
    for cand in candidates:
        try:
            payload = decode_and_verify_token(cand)
            sub = payload.get("sub")
            if sub and isinstance(sub, str):
                username = sub
                break
        except JWTError:
            continue

    if not username:
        raise credentials_exception

    result = await db.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise credentials_exception
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    """FastAPI dependency: require the authenticated user to be an active administrator."""
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges are required for this action.",
        )
    return user