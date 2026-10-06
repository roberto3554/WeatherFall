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
) -> dict[str, Any]:
    """
    Evaluates whether a real-world child infrastructure node survives or cascade-fails
    using the Groq LLM API, conditioned on disaster type, magnitude, and location.

    Args:
        node_name: Real-world name of the child infrastructure node being evaluated.
        node_type: Infrastructure sector/category of the child node.
        parent_name: Name of the upstream parent node that failed.
        disaster_type: Type of climate disaster driving the cascade.
        magnitude: Physical intensity/scale metric of the disaster (e.g., 'Category 5', 'Water level +2.5m').

    Returns:
        A dict with keys "status" (bool, False = failed, True = survived)
        and "reasoning" (str, max 25 words detailing the specific physical or systemic cause).
    """
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise ValueError(
            "GROQ_API_KEY environment variable is missing. "
            "Please define GROQ_API_KEY in your .env file or environment."
        )

    system_prompt = (
        f"You are an expert infrastructure risk analyst. "
        f'A {disaster_type} of magnitude {magnitude} has caused the failure of the parent node "{parent_name}". '
        f'Evaluate if the child node "{node_name}" (type: {node_type}) will survive or cascade fail. '
        f"Consider the physical reality of this specific real-world location, the disaster magnitude, "
        f"and the dependency on the parent node. "
        f'Return ONLY valid JSON: {{"status": boolean (false=fail), "reasoning": string '
        f"(max 25 words detailing the specific physical or systemic cause)}}."
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
                    f'Disaster: {disaster_type} (Magnitude: {magnitude}). '
                    f'Failed parent node: "{parent_name}". '
                    f'Target child node: "{node_name}" (type: {node_type}).'
                ),
            },
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(GROQ_API_URL, headers=headers, json=payload)
            response.raise_for_status()

            response_data = response.json()
            raw_content = response_data["choices"][0]["message"]["content"]
            parsed = json.loads(raw_content)

            if "status" not in parsed or "reasoning" not in parsed:
                raise json.JSONDecodeError("Missing required keys in LLM JSON response", raw_content, 0)

            return {
                "status": bool(parsed["status"]),
                "reasoning": str(parsed["reasoning"]),
            }

    except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.HTTPError, json.JSONDecodeError, KeyError, ValueError) as exc:
        print(f"[WARNING] Groq LLM evaluation failed for node '{node_name}': {exc}")
        return {
            "status": True,
            "reasoning": "Fallback: LLM evaluation failed or timed out.",
        }
