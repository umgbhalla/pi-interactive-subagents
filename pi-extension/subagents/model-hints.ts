export type ModelHint = "frontend" | "non-frontend";

export interface AgentModelDefaults {
  model?: string;
  frontendModel?: string;
  nonFrontendModel?: string;
}

const DEFAULT_HINT_MODELS: Record<ModelHint, string> = {
  frontend: "anthropic/claude-sonnet-4-7",
  "non-frontend": "openai-codex/gpt-5.4",
};

const FRONTEND_HINT_ALIASES = new Set([
  "frontend",
  "front-end",
  "ui",
  "ux",
  "design",
  "visual",
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
]);

export function normalizeModelHint(
  hint?: string | null,
): ModelHint | undefined {
  const normalized = hint?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (FRONTEND_HINT_ALIASES.has(normalized)) return "frontend";
  if (NON_FRONTEND_HINT_ALIASES.has(normalized)) return "non-frontend";
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
      : agentDefaults?.nonFrontendModel;

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
