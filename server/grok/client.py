"""Small async adapter over the source-verified xai-sdk API."""
import asyncio
import inspect
import json
from contextlib import asynccontextmanager

from xai_sdk import AsyncClient
from xai_sdk.chat import system as system_message, tool_result, user as user_message

from server.config import settings


class GrokUnavailable(RuntimeError):
    def __init__(self, trace=None):
        super().__init__("Ground Control is offline or unavailable. No action was taken.")
        self.trace = trace or []


@asynccontextmanager
async def _connection(cfg, client, timeout):
    if client is not None:
        yield client
        return
    if not cfg.XAI_API_KEY or not cfg.XAI_MODEL:
        raise GrokUnavailable()
    async with AsyncClient(api_key=cfg.XAI_API_KEY, timeout=timeout) as connection:
        yield connection


async def parse(system, user, schema, timeout, *, cfg=settings, client=None):
    async with asyncio.timeout(timeout):
        async with _connection(cfg, client, timeout) as connection:
            chat = connection.chat.create(
                model=cfg.XAI_MODEL,
                messages=[system_message(system), user_message(user)],
            )
            _, parsed = await chat.parse(schema)
            return parsed


async def chat_with_tools(messages, tools, tool_impls, max_rounds, timeout, *, cfg=settings, client=None):
    """Bound client-side tool rounds; every executed read is retained in trace."""
    trace = []
    try:
        async with asyncio.timeout(timeout):
            async with _connection(cfg, client, timeout) as connection:
                chat = connection.chat.create(model=cfg.XAI_MODEL, messages=messages, tools=tools)
                for round_index in range(max_rounds + 1):
                    response = await chat.sample()
                    chat.append(response)
                    if not response.tool_calls:
                        return response.content or "No answer was returned from mission data.", trace
                    if round_index == max_rounds:
                        return "The tool round limit was reached. Narrow the question; no action was taken.", trace
                    for call in response.tool_calls:
                        name = call.function.name
                        entry = {"id": call.id, "name": name, "arguments": {}, "result": None}
                        trace.append(entry)
                        try:
                            arguments = json.loads(call.function.arguments)
                            if not isinstance(arguments, dict):
                                raise ValueError("Tool arguments must be an object")
                            entry["arguments"] = arguments
                            if name not in tool_impls:
                                raise ValueError("Unknown read-only tool")
                            result = tool_impls[name](**arguments)
                            entry["result"] = await result if inspect.isawaitable(result) else result
                        except (ValueError, TypeError, KeyError):
                            entry["result"] = {"error": "Invalid read-only tool or arguments"}
                        chat.append(tool_result(json.dumps(entry["result"], allow_nan=False), tool_call_id=call.id))
    except Exception as exc:
        raise GrokUnavailable(trace) from exc

