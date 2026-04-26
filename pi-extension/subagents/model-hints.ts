export type ModelHint = "frontend" | "non-frontend" | "fast" | "reasoning";

export interface AgentModelDefaults {
  model?: string;
  frontendModel?: string;
  nonFrontendModel?: string;
  fastModel?: string;
  reasoningModel?: string;
}

const DEFAULT_HINT_MODELS: Record<ModelHint, string> = {
  frontend: "anthropic/claude-sonnet-4-7",
  "non-frontend": "openai-codex/gpt-5.5",
  fast: "openai-codex/gpt-5.4-mini",
  reasoning: "openai-codex/gpt-5.5",
};

const FRONTEND_HINT_ALIASES = new Set([
  "frontend",
  "front-end",
  "ui",
  "ux",
  "design",
  "visual",
  "web",
  "mobile",
]);
const NON_FRONTEND_HINT_ALIASES = new Set([
  "non-frontend",
  "non_frontend",
  "nonfrontend",
  "non-front-end",
  "backend",
  "general",
  "code",
  "coding",
  "api",
  "server",
  "runtime",
  "infra",
  "cli",
]);
const FAST_HINT_ALIASES = new Set([
  "fast",
  "quick",
  "speed",
  "speedy",
  "cheap",
  "mini",
  "small",
  "haiku",
]);
const REASONING_HINT_ALIASES = new Set([
  "reasoning",
  "reason",
  "deep",
  "hard",
  "complex",
  "smart",
  "strong",
  "large",
  "max",
  "opus",
]);

export function normalizeModelHint(
  hint?: string | null,
): ModelHint | undefined {
  const normalized = hint?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (FRONTEND_HINT_ALIASES.has(normalized)) return "frontend";
  if (NON_FRONTEND_HINT_ALIASES.has(normalized)) return "non-frontend";
  if (FAST_HINT_ALIASES.has(normalized)) return "fast";
  if (REASONING_HINT_ALIASES.has(normalized)) return "reasoning";
  return undefined;
}

export function modelMatchesHintFamily(
  model: string | undefined,
  hint: ModelHint,
): boolean {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return false;

  if (hint === "frontend") {
    return normalized.includes("anthropic/") || normalized.includes("claude-");
  }

  if (hint === "fast") {
    return (
      normalized.includes("mini") ||
      normalized.includes("haiku") ||
      normalized.includes("flash") ||
      normalized.includes("spark")
    );
  }

  if (hint === "reasoning") {
    return (
      normalized.includes("gpt-5.5") ||
      normalized.includes("opus") ||
      normalized.includes("max") ||
      normalized.includes("pro")
    );
  }

  return (
    normalized.includes("openai-codex/") ||
    normalized.includes("gpt-") ||
    normalized.includes("codex")
  );
}

export function resolveHintedModel(input: {
  explicitModel?: string;
  modelHint?: string;
  agentDefaults?: AgentModelDefaults | null;
}): { model?: string; modelHint?: ModelHint } {
  const modelHint = normalizeModelHint(input.modelHint);
  if (input.explicitModel) {
    return { model: input.explicitModel, modelHint };
  }

  const agentDefaults = input.agentDefaults ?? null;
  const agentDefaultModel = agentDefaults?.model;
  if (!modelHint) {
    return { model: agentDefaultModel };
  }

  const hintedOverride =
    modelHint === "frontend"
      ? agentDefaults?.frontendModel
      : modelHint === "non-frontend"
        ? agentDefaults?.nonFrontendModel
        : modelHint === "fast"
          ? agentDefaults?.fastModel
          : agentDefaults?.reasoningModel;

  if (hintedOverride) {
    return { model: hintedOverride, modelHint };
  }

  if (modelMatchesHintFamily(agentDefaultModel, modelHint)) {
    return { model: agentDefaultModel, modelHint };
  }

  return {
    model: DEFAULT_HINT_MODELS[modelHint],
    modelHint,
  };
}
