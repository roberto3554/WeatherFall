import asyncio
import json
import os
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv()

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")


async def evaluate_node_failure(
    node_name: str,
    node_type: str,
    parent_name: str,
    disaster_type: str,
    magnitude: str = "Category 5",
    available_nodes: list[str] | None = None,
) -> dict[str, Any]:
    """
    Evaluates whether a real-world child infrastructure node survives or cascade-fails
    using the Groq LLM API, and orchestrates emergency self-healing rerouting if it fails.

    Args:
        node_name: Real-world name of the child infrastructure node being evaluated.
        node_type: Infrastructure sector/category of the child node.
        parent_name: Name of the upstream parent node that failed.
        disaster_type: Type of climate disaster driving the cascade.
        magnitude: Physical intensity/scale metric of the disaster (e.g., 'Category 5', 'Water level +2.5m').
        available_nodes: Optional list of currently alive node names in the city graph for rerouting.

    Returns:
        A dict with keys:
        - "status" (bool, False = failed, True = survived)
        - "reasoning" (str, max 25 words detailing the specific physical or systemic cause)
        - "recovery_command" (Optional[str], terminal command to reroute supply if status is False, else None)
        - "new_edge" (Optional[dict[str, str]], {"source": ..., "target": node_name} if status is False, else None)
    """
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise ValueError(
            "GROQ_API_KEY environment variable is missing. "
            "Please define GROQ_API_KEY in your .env file or environment."
        )

    candidate_nodes = (available_nodes or [])[:8]
    available_str = (
        f" Available alive city nodes: {json.dumps(candidate_nodes)}."
        if candidate_nodes
        else ""
    )

    system_prompt = (
        f"You are an autonomous network orchestration AI. "
        f"Parent node {parent_name} failed. Child node {node_name} is failing. "
        f"If it fails, you MUST generate a recovery terminal command to reroute its supply "
        f"from another available node in the city. "
        f'Return strictly JSON: {{"status": false, "reasoning": "...", '
        f'"recovery_command": "ln -s /city/grid/substation_b /city/grid/hospital", '
        f'"new_edge": {{"source": "substation_b", "target": "{node_name}"}}}}.'
        f" If the child node survives (status: true), set recovery_command and new_edge to null."
    )

    headers = {
        "Authorization": f"Bearer {groq_api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f'Disaster: {disaster_type} ({magnitude}). '
                    f'Failed parent: "{parent_name}". '
                    f'Child node: "{node_name}" (type: {node_type}).'
                    f"{available_str}"
                ),
            },
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(GROQ_API_URL, headers=headers, json=payload)
            if response.status_code == 429:
                await asyncio.sleep(1.5)
                response = await client.post(GROQ_API_URL, headers=headers, json=payload)
            response.raise_for_status()

            response_data = response.json()
            raw_content = response_data["choices"][0]["message"]["content"]
            parsed = json.loads(raw_content)

            if "status" not in parsed or "reasoning" not in parsed:
                raise json.JSONDecodeError("Missing required keys in LLM JSON response", raw_content, 0)

            status = bool(parsed["status"])
            reasoning = str(parsed["reasoning"])

            if status is True:
                recovery_command = None
                new_edge = None
            else:
                raw_cmd = parsed.get("recovery_command")
                recovery_command = str(raw_cmd) if raw_cmd else None

                raw_edge = parsed.get("new_edge")
                if isinstance(raw_edge, dict) and raw_edge.get("source"):
                    new_edge = {
                        "source": str(raw_edge["source"]),
                        "target": str(raw_edge.get("target") or node_name),
                    }
                else:
                    new_edge = None

            return {
                "status": status,
                "reasoning": reasoning,
                "recovery_command": recovery_command,
                "new_edge": new_edge,
            }

    except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.HTTPError, json.JSONDecodeError, KeyError, ValueError) as exc:
        print(f"[WARNING] Groq LLM evaluation failed for node '{node_name}': {exc}")
        return {
            "status": True,
            "reasoning": "Fallback: LLM evaluation failed or timed out.",
            "recovery_command": None,
            "new_edge": None,
        }
