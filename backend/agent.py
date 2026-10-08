import asyncio
import json
import os
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv()

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")


def _fallback_epicenter_by_trajectory(
    trajectory: str,
    available_nodes: list[dict[str, Any]],
) -> dict[str, str]:
    """
    Deterministic spatial fallback that selects the most geographically exposed node
    based on trajectory direction (East/West/North/South) if the LLM call fails.
    """
    if not available_nodes:
        return {
            "epicenter_id": "Miami Substation",
            "reasoning": "Fallback: Defaulted to primary coastal substation.",
        }

    traj_lower = trajectory.lower()
    if "west" in traj_lower or "everglades" in traj_lower or "inland" in traj_lower:
        chosen = min(available_nodes, key=lambda n: float(n.get("x", 0.0)))
    elif "north" in traj_lower:
        chosen = max(available_nodes, key=lambda n: float(n.get("y", 0.0)))
    elif "south" in traj_lower or "keys" in traj_lower:
        chosen = min(available_nodes, key=lambda n: float(n.get("y", 0.0)))
    else:
        # Default East / Atlantic coast -> largest longitude (least negative x)
        chosen = max(available_nodes, key=lambda n: float(n.get("x", 0.0)))

    chosen_id = str(chosen.get("id") or chosen.get("name"))
    return {
        "epicenter_id": chosen_id,
        "reasoning": (
            f"Spatial trajectory analysis ({trajectory}) identified {chosen_id} "
            f"as the first coastal/perimeter point of impact."
        ),
    }


async def determine_epicenter(
    disaster_type: str,
    magnitude: str,
    trajectory: str,
    available_nodes: list[dict[str, Any]],
) -> dict[str, str]:
    """
    Autonomously determines the initial epicenter node in Miami based on the disaster
    type, magnitude, geographical trajectory, and spatial (x, y) node coordinates.

    Args:
        disaster_type: Type of climate disaster impacting Miami.
        magnitude: Intensity/scale metric of the disaster.
        trajectory: Geographical approach vector (e.g., 'Coming from the Atlantic East coast').
        available_nodes: List of dicts with node 'id', 'name', 'type', 'x', and 'y' coordinates.

    Returns:
        A dict with keys "epicenter_id" (str) and "reasoning" (str, max 25 words).
    """
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise ValueError(
            "GROQ_API_KEY environment variable is missing. "
            "Please define GROQ_API_KEY in your .env file or environment."
        )

    if not available_nodes:
        return _fallback_epicenter_by_trajectory(trajectory, available_nodes)

    system_prompt = (
        f"You are an advanced meteorological and geographical risk AI. "
        f"A {disaster_type} (Magnitude: {magnitude}) is hitting Miami from the {trajectory}. "
        f"Analyze the spatial coordinates (x, y) and types of the provided infrastructure nodes. "
        f"Select the single most logical node to be hit first (the epicenter). "
        f'Return ONLY valid JSON: {{"epicenter_id": "string", '
        f'"reasoning": "string (max 25 words explaining why this node is the first point of failure based on location/trajectory)"}}.'
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
                    f"Disaster: {disaster_type} (Magnitude: {magnitude}). "
                    f"Trajectory: {trajectory}. "
                    f"Infrastructure nodes (x=longitude, y=latitude): {json.dumps(available_nodes)}"
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

            raw_id = str(parsed.get("epicenter_id") or "").strip()
            reasoning = str(parsed.get("reasoning") or "").strip()
            if not raw_id or not reasoning:
                raise json.JSONDecodeError("Missing epicenter_id or reasoning", raw_content, 0)

            # Resolve raw_id against available_nodes
            valid_ids = {str(n.get("id") or n.get("name")): str(n.get("id") or n.get("name")) for n in available_nodes}
            resolved_id: str | None = valid_ids.get(raw_id)
            if resolved_id is None:
                norm_raw = raw_id.lower().replace("_", " ").replace("-", " ")
                for cand_id in valid_ids:
                    norm_cand = cand_id.lower().replace("_", " ").replace("-", " ")
                    if norm_cand == norm_raw or norm_raw in norm_cand or norm_cand in norm_raw:
                        resolved_id = cand_id
                        break

            if resolved_id is None:
                fallback = _fallback_epicenter_by_trajectory(trajectory, available_nodes)
                resolved_id = fallback["epicenter_id"]

            return {
                "epicenter_id": resolved_id,
                "reasoning": reasoning,
            }

    except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.HTTPError, json.JSONDecodeError, KeyError, ValueError) as exc:
        print(f"[WARNING] Groq LLM determine_epicenter failed: {exc}")
        return _fallback_epicenter_by_trajectory(trajectory, available_nodes)


async def evaluate_node_failure(
    node_name: str,
    node_type: str,
    parent_name: str,
    disaster_type: str,
    magnitude: str = "Category 5",
    disaster_direction: str = "Coastal",
    missing_dependency_type: str = "energy",
    route_distance: float = 0.0,
    route_path_nodes: int = 0,
    candidate_nodes: list[dict[str, Any]] | None = None,
    available_nodes: list[Any] | None = None,
) -> dict[str, Any]:
    """
    Evaluates a child infrastructure node during a disaster cascade, enforcing vector
    and magnitude structural physics thresholds and performing distance-weighted
    self-healing recovery routing across alive candidates of the exact missing supply type.

    Args:
        node_name: Real-world name of the child infrastructure node being evaluated.
        node_type: Infrastructure sector/category of the child node.
        parent_name: Name of the upstream parent node that failed.
        disaster_type: Type of climate disaster driving the cascade.
        magnitude: Physical intensity/scale metric of the disaster.
        disaster_direction: Approach vector/direction of the disaster (e.g., 'North-West', 'Coastal').
        missing_dependency_type: Exact infrastructure type of the severed upstream lifeline (e.g., 'energy', 'water').
        route_distance: Physical street network routing distance in meters from parent.
        route_path_nodes: Number of street intersections crossed along the physical route.
        candidate_nodes: Viable alive candidate nodes of the exact missing_dependency_type with OSM street distances (meters).
        available_nodes: Optional legacy fallback list of available nodes.

    Returns:
        A dict with keys:
        - "status" (bool, False = failed, True = survived)
        - "reasoning" (str, explanation based on structural physics, distance, and type matching)
        - "recovery_command" (Optional[str])
        - "estimated_cost" (Optional[int])
        - "recovery_time_ms" (Optional[int])
        - "new_edge" (Optional[dict[str, Any]])
    """
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise ValueError(
            "GROQ_API_KEY environment variable is missing. "
            "Please define GROQ_API_KEY in your .env file or environment."
        )

    effective_candidates = candidate_nodes if candidate_nodes is not None else (available_nodes or [])[:3]
    candidate_nodes_list = json.dumps(effective_candidates)

    system_prompt = (
        f"You are an autonomous emergency infrastructure AI.\n"
        f"A {disaster_type} of Magnitude {magnitude} is hitting from the {disaster_direction}. "
        f"You must evaluate if the physical structure of node {node_name} ({node_type}) collapses. "
        f"Do not rely on chance; if a magnitude {magnitude} event from this vector exceeds the structural "
        f"limits of a typical {node_type} facility, it fails.\n\n"
        f'Node "{node_name}" ({node_type}) has lost its critical "{missing_dependency_type}" lifeline from '
        f'upstream facility "{parent_name}".\n'
        f"Available alive '{missing_dependency_type}' candidate nodes (with exact physical OSM street grid distance in meters): "
        f"{candidate_nodes_list}\n\n"
        f"To restore the severed {missing_dependency_type}, select a node from the candidate list. "
        f"You MUST prioritize candidates with the shortest physical distance. Long distances drastically increase "
        f"{{recovery_time_ms}} and the probability of the new route failing due to the {disaster_direction} trajectory. "
        f"Justify your choice based on distance and type matching.\n\n"
        f'Return ONLY valid JSON: {{"status": false, "reasoning": "Brief explanation justifying structural impact and '
        f'why you chose this specific {missing_dependency_type} candidate based on shortest physical distance (meters) and type matching.", '
        f'"new_edge": {{"source": "chosen_candidate_id", "target": "{node_name}", '
        f'"estimated_cost": 15000, "recovery_time_ms": 120}}}}.'
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
                    f"Disaster: {disaster_type} (Magnitude: {magnitude}, Direction: {disaster_direction}). "
                    f'Failed upstream parent: "{parent_name}" (severed lifeline type: {missing_dependency_type}). '
                    f'Target node: "{node_name}" (type: {node_type}). '
                    f"Original route from parent: {route_distance} meters across {route_path_nodes} intersections. "
                    f"Viable '{missing_dependency_type}' candidate nodes for rerouting (with distance_m): {candidate_nodes_list}"
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
            raw_content = str(response_data["choices"][0]["message"]["content"]).strip()

            # Strip markdown code fences if present before json.loads
            if raw_content.startswith("```"):
                raw_content = raw_content.strip("`")
                if raw_content.lower().startswith("json"):
                    raw_content = raw_content[4:].strip()

            parsed = json.loads(raw_content)
            if not isinstance(parsed, dict) or "status" not in parsed or "reasoning" not in parsed:
                raise json.JSONDecodeError("Missing required keys in LLM JSON response", raw_content, 0)

            status = bool(parsed["status"])
            reasoning = str(parsed["reasoning"])

            if status is True:
                recovery_command = None
                new_edge = None
                estimated_cost = None
                recovery_time_ms = None
            else:
                raw_cmd = parsed.get("recovery_command")
                recovery_command = str(raw_cmd) if raw_cmd else None

                raw_edge = parsed.get("new_edge")
                if isinstance(raw_edge, dict) and raw_edge.get("source") and effective_candidates:
                    chosen_src = str(raw_edge["source"])
                    cand_dist_m = 1500.0
                    for c in effective_candidates:
                        if isinstance(c, dict) and str(c.get("id") or c.get("name")) == chosen_src:
                            cand_dist_m = float(c.get("distance_m", 1500.0))
                            break

                    default_cost = max(5000, int(round(cand_dist_m * 6.5)))
                    default_latency = max(25, int(round(cand_dist_m * 0.045)))

                    try:
                        est_cost = int(float(raw_edge.get("estimated_cost", parsed.get("estimated_cost", default_cost))))
                    except (TypeError, ValueError):
                        est_cost = default_cost

                    try:
                        rec_time = int(float(raw_edge.get("recovery_time_ms", parsed.get("recovery_time_ms", default_latency))))
                    except (TypeError, ValueError):
                        rec_time = default_latency

                    new_edge = {
                        "source": chosen_src,
                        "target": str(raw_edge.get("target") or node_name),
                        "estimated_cost": est_cost,
                        "recovery_time_ms": rec_time,
                    }
                    estimated_cost = est_cost
                    recovery_time_ms = rec_time
                else:
                    new_edge = None
                    estimated_cost = None
                    recovery_time_ms = None

            return {
                "status": status,
                "reasoning": reasoning,
                "recovery_command": recovery_command,
                "estimated_cost": estimated_cost,
                "recovery_time_ms": recovery_time_ms,
                "new_edge": new_edge,
            }

    except Exception as exc:
        print(f"[WARNING] Groq LLM evaluation failed for node '{node_name}': {exc}")
        fallback_source = None
        fallback_dist_m = 1500.0
        if effective_candidates and isinstance(effective_candidates[0], dict):
            fallback_source = effective_candidates[0].get("id") or effective_candidates[0].get("name")
            fallback_dist_m = float(effective_candidates[0].get("distance_m", 1500.0))
        elif effective_candidates and isinstance(effective_candidates[0], str):
            fallback_source = effective_candidates[0]

        if fallback_source:
            est_cost = max(5000, int(round(fallback_dist_m * 6.5)))
            rec_time = max(25, int(round(fallback_dist_m * 0.045)))
            return {
                "status": False,
                "reasoning": (
                    f"Severed {missing_dependency_type} lifeline under {magnitude} ({disaster_direction}); "
                    f"rerouted to shortest-distance {missing_dependency_type} candidate {fallback_source} "
                    f"({fallback_dist_m:.0f} m)."
                ),
                "recovery_command": None,
                "estimated_cost": est_cost,
                "recovery_time_ms": rec_time,
                "new_edge": {
                    "source": str(fallback_source),
                    "target": node_name,
                    "estimated_cost": est_cost,
                    "recovery_time_ms": rec_time,
                },
            }

        return {
            "status": False,
            "reasoning": (
                f"Node {node_name} ({node_type}) failed due to severed {missing_dependency_type} lifeline "
                f"and no viable {missing_dependency_type} recovery candidates remain operational."
            ),
            "recovery_command": None,
            "estimated_cost": None,
            "recovery_time_ms": None,
            "new_edge": None,
        }


