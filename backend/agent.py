import json
import os
from typing import Any
import httpx

LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")

async def evaluate_node_failure(
    child_name: str,
    child_type: str,
    disaster_type: str,
    parent_status: bool,
    parent_name: str,
) -> dict[str, Any]:
    """
    Real async LLM call evaluating whether an infrastructure node survives or fails.
    Uses httpx to hit a generic OpenAI-compatible chat completion endpoint.
    """
    # If the upstream parent survived, this downstream node remains unaffected by cascade
    if parent_status:
        return {
            "status": True,
            "reasoning": (
                f"'{child_name}' remained operational during the {disaster_type} because its "
                f"upstream dependency stayed online and local defenses held."
            ),
        }

    system_prompt = (
        f"You are a critical infrastructure evaluation engine. "
        f"The parent node {parent_name} failed due to {disaster_type}. "
        f"Evaluate if the child node {child_name} (type: {child_type}) will cascade fail. "
        f"Respond ONLY in valid JSON with keys: status (boolean, false = fail) and reasoning (string, max 20 words)."
    )

    if not LLM_API_KEY:
        # Fallback if no API key is provided, mimicking a fail
        return {
            "status": False,
            "reasoning": "Failed to cascade. (MOCKED: No LLM_API_KEY provided)",
        }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{LLM_BASE_URL.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {LLM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt}
                    ],
                    "temperature": 0.2,
                    "response_format": {"type": "json_object"},
                },
            )
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            
            return {
                "status": bool(parsed.get("status", True)),
                "reasoning": str(parsed.get("reasoning", "Survives by default reasoning.")),
            }
    except Exception as e:
        # Fallback to True (node survives) if hallucinates or times out
        return {
            "status": True,
            "reasoning": f"Fallback: Survived due to evaluation error ({type(e).__name__}).",
        }
