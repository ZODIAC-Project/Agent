import logging
import os
from collections.abc import Mapping

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.propagate import extract, inject
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind


logger = logging.getLogger(__name__)

_initialized = False


def configure_tracing() -> None:
    global _initialized

    if _initialized:
        return
    _initialized = True

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        logger.info("OTEL tracing disabled: no OTEL_EXPORTER_OTLP_ENDPOINT configured")
        return

    headers = {}
    raw_headers = os.getenv("OTEL_EXPORTER_OTLP_HEADERS", "").strip()
    if raw_headers:
        for part in raw_headers.split(","):
            if "=" not in part:
                continue
            key, value = part.split("=", 1)
            headers[key.strip()] = value.strip()

    service_name = os.getenv("OTEL_SERVICE_NAME", "agent-api")
    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": service_name,
                "service.namespace": os.getenv("OTEL_SERVICE_NAMESPACE", "zodiac"),
            }
        )
    )

    exporter = OTLPSpanExporter(
        endpoint=_normalize_trace_endpoint(endpoint),
        headers=headers or None,
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    logger.info("OTEL tracing enabled for service '%s'", service_name)


def get_tracer(name: str):
    return trace.get_tracer(name)


def inject_trace_headers(headers: Mapping[str, str] | None = None) -> dict[str, str]:
    carrier = dict(headers or {})
    inject(carrier)
    return carrier


def start_incoming_span(tracer, name: str, headers, **kwargs):
    return tracer.start_as_current_span(
        name,
        context=extract(_normalize_headers(headers)),
        kind=kwargs.pop("kind", SpanKind.SERVER),
        **kwargs,
    )


def current_trace_id() -> str:
    span_context = trace.get_current_span().get_span_context()
    if not span_context.is_valid:
        return ""
    return format(span_context.trace_id, "032x")


def _normalize_trace_endpoint(endpoint: str) -> str:
    endpoint = endpoint.rstrip("/")
    if endpoint.endswith("/v1/traces"):
        return endpoint
    return f"{endpoint}/v1/traces"


def _normalize_headers(headers) -> dict[str, str]:
    if headers is None:
        return {}
    if hasattr(headers, "items"):
        return {str(key): str(value) for key, value in headers.items()}
    return {str(key): str(value) for key, value in dict(headers).items()}
