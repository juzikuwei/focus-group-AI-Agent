from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import re
from copy import deepcopy
from datetime import date
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from langchain_core.messages import HumanMessage

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT / "config"
PROMPTS_DIR = ROOT / "prompts"

app = FastAPI(title="Focus Lab API", version="0.4.0")


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config(name: str) -> dict[str, Any]:
    base = load_json(CONFIG_DIR / f"{name}.json")
    local = load_json(CONFIG_DIR / f"{name}.local.json")
    return deep_merge(base, local)


def normalize_provider_name(name: str | None) -> str:
    value = (name or "").strip().lower()
    return "mimo" if value == "mino" else value


def active_provider(config: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    providers = config.get("providers") or {}
    active = normalize_provider_name(config.get("active") or config.get("activeProvider"))
    if active not in providers and active == "mimo" and "mino" in providers:
        active = "mino"
    if not active or active not in providers:
        active = next(iter(providers), "")
    provider = deepcopy(providers.get(active) or {})
    provider.setdefault("name", active)
    return normalize_provider_name(active), provider


API_CONFIG = load_config("api.config")
SEARCH_CONFIG = load_config("search.config")
ACTIVE_PROVIDER_NAME, ACTIVE_PROVIDER = active_provider(API_CONFIG)


def today_iso() -> str:
    return date.today().isoformat()


def clean_text(value: Any, limit: int | None = None) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if limit and len(text) > limit:
        return text[: limit - 1] + "…"
    return text


def safe_list(value: Any, limit: int = 5) -> list[str]:
    if isinstance(value, list):
        return [clean_text(item) for item in value if clean_text(item)][:limit]
    if isinstance(value, str) and value.strip():
        return [clean_text(value)]
    return []


def parse_int(value: Any, default: int, minimum: int = 1, maximum: int = 10) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def extract_json_object(text: str) -> Any:
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    candidates = []
    first_obj, last_obj = raw.find("{"), raw.rfind("}")
    first_arr, last_arr = raw.find("["), raw.rfind("]")
    if first_obj >= 0 and last_obj > first_obj:
        candidates.append(raw[first_obj : last_obj + 1])
    if first_arr >= 0 and last_arr > first_arr:
        candidates.append(raw[first_arr : last_arr + 1])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise ValueError("模型没有返回合法 JSON")


def render_prompt(name: str, values: dict[str, Any]) -> str:
    text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    for key, value in values.items():
        if isinstance(value, (dict, list)):
            replacement = compact_json(value)
        else:
            replacement = str(value or "")
        text = text.replace("{{" + key + "}}", replacement)
    return re.sub(r"{{[^}]+}}", "", text)


def interview_rules(config: dict[str, Any]) -> str:
    count = parse_int(config.get("roundCount"), 3)
    return "\n".join(
        [
            f"- 总轮次：{count} 轮。",
            "- 受访者必须结合真实使用场景表达，不要只说功能态度。",
            "- 主持人要追问替代方案、价格门槛、证据需求和拒绝理由。",
            "- 每轮都要推动分歧显性化，避免所有人只给正面评价。",
        ]
    )


def evidence_rules() -> str:
    return "\n".join(
        [
            "- 报告结论必须能追溯到受访者原话或外部资料。",
            "- 价格、替代方案、购买阻力和证据门槛必须具体。",
            "- 对不确定结论要标注还需要真实调研验证。",
        ]
    )


class LangChainClient:
    def __init__(self, provider_name: str, provider: dict[str, Any]):
        self.provider_name = normalize_provider_name(provider_name)
        self.provider = provider

    @property
    def api_key(self) -> str:
        return str(self.provider.get("apiKey") or "").strip()

    def assert_ready(self) -> None:
        if self.provider.get("requiresKey", True) is not False and not self.api_key:
            raise HTTPException(status_code=403, detail="请先配置模型 API Key")

    def _openai_base_url(self) -> str:
        endpoint = str(self.provider.get("endpoint") or "").strip()
        return re.sub(r"/chat/completions/?$", "", endpoint)

    def _model(self, temperature: float, max_tokens: int | None = None):
        fmt = str(self.provider.get("format") or "openai").lower()
        model_name = str(self.provider.get("model") or "").strip()
        if fmt == "anthropic":
            from langchain_anthropic import ChatAnthropic

            kwargs: dict[str, Any] = {
                "model": model_name,
                "api_key": self.api_key,
                "temperature": temperature,
            }
            if max_tokens:
                kwargs["max_tokens"] = max_tokens
            return ChatAnthropic(**kwargs)
        if fmt == "gemini":
            from langchain_google_genai import ChatGoogleGenerativeAI

            kwargs = {
                "model": model_name,
                "google_api_key": self.api_key,
                "temperature": temperature,
            }
            if max_tokens:
                kwargs["max_output_tokens"] = max_tokens
            return ChatGoogleGenerativeAI(**kwargs)

        from langchain_openai import ChatOpenAI

        kwargs = {
            "model": model_name,
            "api_key": self.api_key,
            "base_url": self._openai_base_url(),
            "temperature": temperature,
        }
        if max_tokens:
            kwargs["max_tokens"] = max_tokens
        return ChatOpenAI(**kwargs)

    async def text(self, prompt: str, temperature: float = 0.5, max_tokens: int | None = None) -> str:
        self.assert_ready()
        model = self._model(temperature, max_tokens)
        result = await model.ainvoke([HumanMessage(content=prompt)])
        return clean_text(getattr(result, "content", result))

    async def json(self, prompt: str, temperature: float = 0.5, max_tokens: int | None = None) -> Any:
        text = await self.text(prompt, temperature, max_tokens)
        return extract_json_object(text)

    async def stream(self, prompt: str, temperature: float = 0.45, max_tokens: int | None = None) -> AsyncIterator[str]:
        self.assert_ready()
        model = self._model(temperature, max_tokens)
        async for chunk in model.astream([HumanMessage(content=prompt)]):
            content = getattr(chunk, "content", "")
            if isinstance(content, list):
                content = "".join(str(part.get("text", part)) if isinstance(part, dict) else str(part) for part in content)
            if content:
                yield str(content)


def request_provider(
    x_fg_api_provider: str | None,
    x_fg_api_key: str | None,
    x_fg_api_base_url: str | None,
    x_fg_api_model: str | None,
) -> tuple[str, dict[str, Any]]:
    provider_name = normalize_provider_name(x_fg_api_provider) or ACTIVE_PROVIDER_NAME
    providers = API_CONFIG.get("providers") or {}
    provider = deepcopy(providers.get(provider_name) or ACTIVE_PROVIDER)
    if x_fg_api_key:
        provider["apiKey"] = x_fg_api_key
    if x_fg_api_base_url:
        endpoint = x_fg_api_base_url.rstrip("/")
        if provider.get("format", "openai") == "openai" and not endpoint.endswith("/chat/completions"):
            endpoint += "/chat/completions"
        provider["endpoint"] = endpoint
    if x_fg_api_model:
        provider["model"] = x_fg_api_model
    provider["name"] = provider_name
    return provider_name, provider


async def get_lc_client(
    x_fg_api_provider: str | None = Header(default=None),
    x_fg_api_key: str | None = Header(default=None),
    x_fg_api_base_url: str | None = Header(default=None),
    x_fg_api_model: str | None = Header(default=None),
) -> LangChainClient:
    provider_name, provider = request_provider(
        x_fg_api_provider,
        x_fg_api_key,
        x_fg_api_base_url,
        x_fg_api_model,
    )
    return LangChainClient(provider_name, provider)


def normalize_personas(value: Any, expected_count: int) -> list[dict[str, Any]]:
    personas = value.get("personas") if isinstance(value, dict) else value
    if not isinstance(personas, list):
        raise HTTPException(status_code=502, detail="模型返回的受访者格式不正确")
    result = []
    for index, persona in enumerate(personas[:expected_count]):
        item = persona if isinstance(persona, dict) else {}
        result.append(
            {
                "id": clean_text(item.get("id") or f"p{index + 1}"),
                "name": clean_text(item.get("name") or f"受访者{index + 1}"),
                "segment": clean_text(item.get("segment") or "目标用户"),
                "snapshot": clean_text(item.get("snapshot"), 48),
                "currentAlternative": clean_text(item.get("currentAlternative"), 60),
                "switchTrigger": clean_text(item.get("switchTrigger"), 60),
                "budgetAnchor": clean_text(item.get("budgetAnchor"), 60),
                "evidenceNeeded": clean_text(item.get("evidenceNeeded"), 60),
                "discussionRole": clean_text(item.get("discussionRole"), 80),
                "concerns": safe_list(item.get("concerns"), 2),
                "speakingStyle": clean_text(item.get("speakingStyle") or "自然表达，会说明取舍理由", 90),
                "dealBreaker": clean_text(item.get("dealBreaker"), 70),
            }
        )
    return result


def normalize_moderator_guide(value: Any, topics: list[str]) -> dict[str, Any]:
    guide = value.get("moderatorGuide") if isinstance(value, dict) and "moderatorGuide" in value else value
    guide = guide if isinstance(guide, dict) else {}
    plan = guide.get("roundPlan") if isinstance(guide.get("roundPlan"), list) else []
    if not plan:
        plan = [
            {
                "round": index + 1,
                "objective": f"验证第 {index + 1} 轮议题的真实接受度",
                "keyQuestion": topic,
                "mustProbe": ["具体使用场景", "替代方案", "购买阻力"],
                "shallowAnswerSignals": ["只说感兴趣但没有场景", "只评价功能不谈取舍"],
            }
            for index, topic in enumerate(topics)
        ]
    return {
        "researchObjectives": safe_list(guide.get("researchObjectives") or guide.get("objectives"), 5),
        "coreHypotheses": safe_list(guide.get("coreHypotheses") or guide.get("hypotheses"), 5),
        "roundPlan": [
            {
                "round": parse_int(round_item.get("round"), index + 1, 1, 20) if isinstance(round_item, dict) else index + 1,
                "objective": clean_text(round_item.get("objective") if isinstance(round_item, dict) else "", 120),
                "keyQuestion": clean_text(round_item.get("keyQuestion") if isinstance(round_item, dict) else topics[index] if index < len(topics) else "", 160),
                "mustProbe": safe_list(round_item.get("mustProbe") if isinstance(round_item, dict) else [], 6),
                "shallowAnswerSignals": safe_list(round_item.get("shallowAnswerSignals") if isinstance(round_item, dict) else [], 6),
            }
            for index, round_item in enumerate(plan[: len(topics) or len(plan)])
        ],
        "probeStrategies": safe_list(guide.get("probeStrategies"), 8),
        "redFlags": safe_list(guide.get("redFlags"), 8),
    }


def initial_participant_states(personas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": persona.get("name"),
            "currentAttitude": "尚未发言，初始立场未知",
            "mentionedConcerns": persona.get("concerns") or [],
            "conditionsToBuy": [],
            "objections": [],
            "evidenceNeeded": [persona.get("evidenceNeeded")] if persona.get("evidenceNeeded") else [],
            "contradictions": [],
            "concreteExamples": [],
            "alternativeComparisons": [persona.get("currentAlternative")] if persona.get("currentAlternative") else [],
            "quoteCandidates": [],
            "followUpQuestions": [],
            "lastRoundTakeaway": "",
        }
        for persona in personas
    ]


def context_state(config: dict[str, Any], topics: list[str], moderator_guide: dict[str, Any], personas: list[dict[str, Any]], participant_states: list[dict[str, Any]], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    state = {
        "projectName": config.get("projectName") or "",
        "productConcept": config.get("productConcept") or "",
        "topics": topics,
        "moderatorGuide": moderator_guide,
        "participants": [{"name": p.get("name"), "segment": p.get("segment")} for p in personas],
        "participantStates": participant_states,
    }
    if extra:
        state.update(extra)
    return state


def normalize_quick_fill(value: Any) -> dict[str, Any]:
    config = value.get("config") if isinstance(value, dict) else {}
    config = config if isinstance(config, dict) else {}
    return {
        "projectName": clean_text(config.get("projectName") or "未命名研究", 30),
        "productConcept": clean_text(config.get("productConcept"), 260),
        "coreSellingPoints": clean_text(config.get("coreSellingPoints"), 180),
        "targetAudience": clean_text(config.get("targetAudience"), 160),
        "discussionTopics": str(config.get("discussionTopics") or "").strip(),
    }


def ndjson_event(payload: dict[str, Any]) -> str:
    return compact_json(payload) + "\n"


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "backend": "fastapi",
        "llmFramework": "langchain",
        "provider": ACTIVE_PROVIDER.get("name") or ACTIVE_PROVIDER_NAME,
        "endpoint": ACTIVE_PROVIDER.get("endpoint", ""),
        "model": ACTIVE_PROVIDER.get("model", ""),
        "requiresKey": ACTIVE_PROVIDER.get("requiresKey", True),
        "hasKey": bool(ACTIVE_PROVIDER.get("apiKey")),
        "providers": list((API_CONFIG.get("providers") or {}).keys()),
        "search": search_status(),
    }


@app.get("/api/config")
async def config(
    x_fg_search_provider: str | None = Header(default=None),
    x_fg_search_api_key: str | None = Header(default=None),
) -> dict[str, Any]:
    providers = API_CONFIG.get("providers") or {}
    return {
        "activeProvider": ACTIVE_PROVIDER.get("name") or ACTIVE_PROVIDER_NAME,
        "providers": {
            key: {
                "name": key,
                "format": value.get("format", "openai"),
                "endpoint": value.get("endpoint", ""),
                "model": value.get("model", ""),
                "requiresKey": value.get("requiresKey", True),
                "hasKey": bool(value.get("apiKey")),
            }
            for key, value in providers.items()
        },
        "prompts": sorted(path.name for path in PROMPTS_DIR.glob("*.md")),
        "search": search_status(x_fg_search_provider, x_fg_search_api_key),
    }


@app.post("/api/quick-fill")
async def quick_fill(request: Request) -> dict[str, Any]:
    payload = await request.json()
    seed = clean_text(payload.get("seed"))
    if not seed:
        raise HTTPException(status_code=400, detail="请先输入产品想法")
    lc = await get_lc_client_from_request(request)
    prompt = render_prompt(
        "quick-fill.md",
        {
            "seed": seed,
            "searchResearchJson": compact_json({"status": "skipped", "reason": "未启用轻量搜索"}),
        },
    )
    data = await lc.json(prompt, 0.45, 2200)
    return {"config": normalize_quick_fill(data)}


@app.post("/api/personas")
async def personas(request: Request) -> dict[str, Any]:
    payload = await request.json()
    config_data = payload.get("config") or {}
    expected_count = parse_int(config_data.get("participantCount"), 5, 1, 10)
    lc = await get_lc_client_from_request(request)
    prompt = render_prompt(
        "persona-generator.md",
        {
            **config_data,
            "participantCount": expected_count,
            "interviewRulesText": interview_rules(config_data),
        },
    )
    data = await lc.json(prompt, 0.65, 3600)
    return {"personas": normalize_personas(data, expected_count)}


@app.post("/api/moderator-guide")
async def moderator_guide(request: Request) -> dict[str, Any]:
    payload = await request.json()
    config_data = payload.get("config") or {}
    personas_data = payload.get("personas") or []
    topics = [clean_text(topic) for topic in payload.get("topics") or [] if clean_text(topic)]
    lc = await get_lc_client_from_request(request)
    prompt = render_prompt(
        "moderator-guide.md",
        {
            **config_data,
            "interviewRulesText": interview_rules(config_data),
            "evidenceRulesText": evidence_rules(),
            "topicsJson": compact_json([{"round": i + 1, "topic": topic} for i, topic in enumerate(topics)]),
            "personasJson": compact_json(personas_data),
        },
    )
    data = await lc.json(prompt, 0.45, 3000)
    guide = normalize_moderator_guide(data, topics)
    states = initial_participant_states(personas_data)
    return {
        "moderatorGuide": guide,
        "participantStates": states,
        "contextState": context_state(config_data, topics, guide, personas_data, states),
    }


@app.post("/api/evidence-pack")
async def evidence_pack(request: Request) -> dict[str, Any]:
    payload = await request.json()
    config_data = payload.get("config") or {}
    topics = payload.get("topics") or []
    personas_data = payload.get("personas") or []
    guide = payload.get("moderatorGuide") or {}
    states = payload.get("participantStates") or initial_participant_states(personas_data)
    base_context = payload.get("contextState") or context_state(config_data, topics, guide, personas_data, states)
    if not config_data.get("useSearchEnhancement"):
        return {
            "evidencePack": {
                "status": "skipped",
                "generatedAt": today_iso(),
                "topic": config_data.get("productConcept") or config_data.get("projectName") or "未命名研究",
                "skipReason": "search enhancement not requested",
                "sourceCards": [],
            },
            "contextState": base_context,
        }

    search_provider = request.headers.get("x-fg-search-provider")
    search_key = request.headers.get("x-fg-search-api-key")
    pack = await build_evidence_pack(config_data, topics, search_provider, search_key)
    external_findings = [
        {
            "source": card.get("id"),
            "title": card.get("title"),
            "summary": "；".join((card.get("keyFacts") or [])[:2] + (card.get("userSignals") or [])[:2]),
            "url": card.get("url"),
        }
        for card in pack.get("sourceCards", [])
    ]
    return {
        "evidencePack": pack,
        "contextState": {**base_context, "externalFindings": external_findings},
    }


@app.post("/api/session/round/stream")
async def session_round_stream(request: Request) -> StreamingResponse:
    payload = await request.json()
    lc = await get_lc_client_from_request(request)

    async def generate() -> AsyncIterator[str]:
        round_number = parse_int(payload.get("roundNumber"), 1, 1, 20)
        yield ndjson_event({"type": "start", "roundNumber": round_number})
        try:
            messages = await generate_round_messages(lc, payload)
            states = update_participant_states(payload.get("participantStates") or [], messages)
            context = {
                **(payload.get("contextState") or {}),
                "lastRound": round_number,
                "lastRoundSummary": "；".join(clean_text(m.get("text"), 80) for m in messages[-3:]),
            }
            for message in messages:
                yield ndjson_event({"type": "messages", "messages": [message]})
                await asyncio.sleep(0)
            yield ndjson_event(
                {
                    "type": "done",
                    "roundNumber": round_number,
                    "messages": messages,
                    "participantStates": states,
                    "contextState": context,
                    "moderatorGuide": payload.get("moderatorGuide"),
                }
            )
        except Exception as exc:
            yield ndjson_event({"type": "error", "error": str(exc)})

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/api/report/stream")
async def report_stream(request: Request) -> StreamingResponse:
    payload = await request.json()
    lc = await get_lc_client_from_request(request)
    prompt = build_report_prompt(payload)

    async def generate() -> AsyncIterator[str]:
        yield ndjson_event({"type": "start"})
        parts: list[str] = []
        try:
            async for chunk in lc.stream(prompt, 0.45, 5000):
                parts.append(chunk)
                yield ndjson_event({"type": "chunk", "text": chunk})
            yield ndjson_event({"type": "done", "markdown": "".join(parts)})
        except Exception as exc:
            yield ndjson_event({"type": "error", "error": str(exc)})

    return StreamingResponse(generate(), media_type="application/x-ndjson")


async def get_lc_client_from_request(request: Request) -> LangChainClient:
    provider_name, provider = request_provider(
        request.headers.get("x-fg-api-provider"),
        request.headers.get("x-fg-api-key"),
        request.headers.get("x-fg-api-base-url"),
        request.headers.get("x-fg-api-model"),
    )
    return LangChainClient(provider_name, provider)


async def generate_round_messages(lc: LangChainClient, payload: dict[str, Any]) -> list[dict[str, Any]]:
    config_data = payload.get("config") or {}
    personas_data = payload.get("personas") or []
    round_number = parse_int(payload.get("roundNumber"), 1, 1, 20)
    topic = clean_text(payload.get("topic") or f"第 {round_number} 轮议题")
    prior_messages = payload.get("priorMessages") or []
    prompt = f"""
你是严谨的焦点小组主持系统。请生成第 {round_number} 轮访谈消息。

要求：
1. 只输出合法 JSON，不要 Markdown。
2. messages 第一条必须是主持人发言，type 为 "moderator"，speaker 为 "主持人"。
3. 每位受访者至少发言一次，type 为 "participant"，speaker 必须使用受访者 name。
4. 发言要具体，有真实场景、替代方案、价格或证据门槛，不要空泛夸赞。
5. 可以让受访者互相轻微分歧，但不要人身攻击。
6. 每条 text 控制在 60-180 个中文字符。

JSON 格式：
{{"messages":[{{"type":"moderator","speaker":"主持人","text":"..."}}]}}

项目配置 JSON：
{compact_json(config_data)}

本轮议题：
{topic}

受访者 JSON：
{compact_json(personas_data)}

主持指南 JSON：
{compact_json(payload.get("moderatorGuide") or {})}

既有访谈摘要 JSON：
{compact_json(prior_messages[-12:])}
"""
    data = await lc.json(prompt, 0.7, 4200)
    raw_messages = data.get("messages") if isinstance(data, dict) else data
    if not isinstance(raw_messages, list):
        raise HTTPException(status_code=502, detail="模型返回的访谈消息格式不正确")
    messages = []
    for item in raw_messages:
        if not isinstance(item, dict):
            continue
        speaker = clean_text(item.get("speaker") or item.get("name") or "受访者")
        msg_type = clean_text(item.get("type") or ("moderator" if speaker == "主持人" else "participant"))
        if msg_type not in {"moderator", "participant"}:
            msg_type = "participant"
        messages.append(
            {
                "type": msg_type,
                "speaker": speaker,
                "text": clean_text(item.get("text") or item.get("content"), 320),
                "round": round_number,
            }
        )
    if not messages or messages[0]["type"] != "moderator":
        messages.insert(0, {"type": "moderator", "speaker": "主持人", "text": topic, "round": round_number})
    return [message for message in messages if message["text"]]


def update_participant_states(states: list[dict[str, Any]], messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    state_by_name = {state.get("name"): dict(state) for state in states if isinstance(state, dict)}
    for message in messages:
        if message.get("type") != "participant":
            continue
        name = message.get("speaker")
        state = state_by_name.setdefault(
            name,
            {
                "name": name,
                "currentAttitude": "",
                "mentionedConcerns": [],
                "conditionsToBuy": [],
                "objections": [],
                "evidenceNeeded": [],
                "concreteExamples": [],
                "quoteCandidates": [],
                "followUpQuestions": [],
            },
        )
        text = clean_text(message.get("text"), 160)
        state["lastRoundTakeaway"] = text
        state["quoteCandidates"] = (state.get("quoteCandidates") or [])[:4] + [text]
        if re.search(r"担心|顾虑|不会|不买|太贵|麻烦|风险|隐私", text):
            state["objections"] = list(dict.fromkeys((state.get("objections") or []) + [text]))[:5]
        if re.search(r"如果|除非|看到|证明|试用|保证|低于|才会", text):
            state["conditionsToBuy"] = list(dict.fromkeys((state.get("conditionsToBuy") or []) + [text]))[:5]
    return list(state_by_name.values())


def build_report_prompt(payload: dict[str, Any]) -> str:
    return f"""
你是资深消费者洞察分析师。请基于虚拟焦点小组记录输出一份中文 Markdown 洞察报告。

要求：
1. 使用 Markdown，不要输出 JSON。
2. 报告必须包含：执行摘要、关键洞察、受访者分歧、购买阻力、可接受条件、产品优化建议、后续真实调研建议。
3. 每个关键洞察要引用至少一条受访者原话或访谈信号。
4. 不要把虚拟访谈当作真实市场结论，要标注仍需真实调研验证的地方。
5. 语言具体、克制，避免营销口吻。

项目配置：
{compact_json(payload.get("config") or {})}

受访者：
{compact_json(payload.get("personas") or [])}

访谈消息：
{compact_json(payload.get("messages") or [])}

主持指南：
{compact_json(payload.get("moderatorGuide") or {})}

受访者状态：
{compact_json(payload.get("participantStates") or [])}

外部资料包：
{compact_json(payload.get("evidencePack") or {})}
"""


def search_status(provider_override: str | None = None, key_override: str | None = None) -> dict[str, Any]:
    enabled = bool(SEARCH_CONFIG.get("enabled"))
    providers = SEARCH_CONFIG.get("providers") or {}
    active = provider_override or SEARCH_CONFIG.get("active") or SEARCH_CONFIG.get("activeProvider") or ""
    provider = providers.get(active) or {}
    api_key = key_override or provider.get("apiKey") or ""
    return {
        "enabled": enabled,
        "activeProvider": active,
        "provider": active,
        "endpoint": provider.get("endpoint", "https://api.tavily.com/search") if active else "",
        "requiresKey": True,
        "hasKey": bool(api_key),
        "maxQueries": SEARCH_CONFIG.get("maxQueries", 4),
        "maxResultsPerQuery": SEARCH_CONFIG.get("maxResultsPerQuery", 5),
    }


async def build_evidence_pack(config_data: dict[str, Any], topics: list[str], provider_override: str | None, key_override: str | None) -> dict[str, Any]:
    status = search_status(provider_override, key_override)
    api_key = key_override
    if not api_key:
        active = status.get("provider")
        api_key = ((SEARCH_CONFIG.get("providers") or {}).get(active) or {}).get("apiKey")
    if not status.get("enabled") or not api_key:
        return {
            "status": "failed",
            "generatedAt": today_iso(),
            "topic": config_data.get("projectName") or config_data.get("productConcept") or "未命名研究",
            "error": "搜索未配置",
            "sourceCards": [],
        }

    query = f"{config_data.get('productConcept') or config_data.get('projectName')} 用户痛点 替代方案 价格 顾虑"
    endpoint = status.get("endpoint") or "https://api.tavily.com/search"
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                endpoint,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"query": query, "search_depth": "basic", "max_results": 5, "include_answer": True},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        return {
            "status": "failed",
            "generatedAt": today_iso(),
            "topic": config_data.get("projectName") or "未命名研究",
            "error": str(exc),
            "sourceCards": [],
        }

    cards = []
    for index, result in enumerate(data.get("results") or []):
        content = clean_text(result.get("content") or result.get("raw_content"), 260)
        cards.append(
            {
                "id": f"S{index + 1}",
                "type": "market_signal",
                "title": clean_text(result.get("title") or f"来源 {index + 1}", 120),
                "url": result.get("url") or "",
                "sourceDate": result.get("published_date") or "未知",
                "reliability": "medium",
                "keyFacts": [content] if content else [],
                "userSignals": [content] if content else [],
                "quoteSnippets": [content] if content else [],
                "relevantFor": ["痛点", "替代方案", "购买阻力"],
            }
        )
    return {
        "status": "used" if cards else "failed",
        "generatedAt": today_iso(),
        "topic": config_data.get("projectName") or config_data.get("productConcept") or "未命名研究",
        "queries": [{"query": query, "purpose": "了解用户痛点和替代方案"}],
        "sourceCards": cards,
        "marketPatterns": safe_list(data.get("answer"), 3),
        "commonComplaints": [],
        "purchaseBarriers": [],
        "openQuestions": [clean_text(topic) for topic in topics[:5]],
        "stimulusScript": "以下外部资料仅用于帮助主持人追问，不作为最终市场结论。",
    }


@app.get("/{path:path}")
async def static_files(path: str) -> Response:
    safe_path = path.strip("/") or "index.html"
    file_path = (ROOT / safe_path).resolve()
    if ROOT not in file_path.parents and file_path != ROOT:
        raise HTTPException(status_code=404)
    if file_path.is_dir():
        file_path = file_path / "index.html"
    if not file_path.exists():
        file_path = ROOT / "index.html"
    media_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=media_type)

