import asyncio
from typing import Any


async def evaluate_node_failure(
    node: str,
    disaster_type: str,
    parent_status: bool,
) -> dict[str, Any]:
    """
    Mocked async LLM call evaluating whether an infrastructure node survives or fails.

    Args:
        node: Name of the infrastructure node being evaluated.
        disaster_type: Description of the climate disaster event.
        parent_status: Operational status of the upstream parent node
                       (False = parent failed / direct epicenter hit, True = parent operational).

    Returns:
        A dictionary containing:
            - "status" (bool): False if the node failed, True if it survived.
            - "reasoning" (str): Short explanation of the outcome.
    """
    # Simulate minimal async I/O latency for an LLM call
    await asyncio.sleep(0.01)

    # If the upstream parent survived, this downstream node remains unaffected by cascade
    if parent_status:
        return {
            "status": True,
            "reasoning": (
                f"'{node}' remained operational during the {disaster_type} because its "
                f"upstream dependency stayed online and local defenses held."
            ),
        }

    # Example resilience rule: Hospitals have emergency diesel backup unless hit by a severe flood
    if "hospital" in node.lower() and "flood" not in disaster_type.lower():
        return {
            "status": True,
            "reasoning": (
                f"Despite upstream power loss from the {disaster_type}, '{node}' survived by "
                f"automatically switching to isolated emergency diesel generators."
            ),
        }

    return {
        "status": False,
        "reasoning": (
            f"'{node}' failed during the {disaster_type} due to critical upstream supply loss "
            f"and severe environmental load exceeding local backup capacity."
        ),
    }
