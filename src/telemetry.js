import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

if (process.env.OTEL_DEBUG === "true") {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

const serviceName =
  process.env.OTEL_SERVICE_NAME ||
  process.env.SERVICE_NAME ||
  "agent-service";

const resource = new Resource({
  [SemanticResourceAttributes.SERVICE_NAME]: serviceName
});

const sdk = new NodeSDK({
  resource,
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 10000
  }),
  instrumentations: [getNodeAutoInstrumentations()]
});

sdk.start();

const shutdown = async () => {
  try {
    await sdk.shutdown();
  } catch (error) {
    console.error("OTel shutdown error", error);
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
