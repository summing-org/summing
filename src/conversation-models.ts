import type { CodexAppServer, CodexModel } from "./codex-app-server.js";
import type { RuntimeConfig } from "./config.js";
import type { Conversation, StateStore } from "./state-store.js";

export interface ModelSelection {
  model: string;
  effort: string;
  source: "conversation" | "config" | "codex-default";
}

/** Shared by Telegram and the Mini App. Saved preferences are not execution evidence. */
export class ConversationModels {
  private models: CodexModel[] = [];
  private updatedAt = 0;
  private inFlight: Promise<CodexModel[]> | null = null;

  constructor(
    private readonly config: Pick<RuntimeConfig, "model" | "effort">,
    private readonly state: StateStore,
    private readonly codex: Pick<CodexAppServer, "models">,
  ) {}

  async catalog(force = false): Promise<CodexModel[]> {
    if (!force && Date.now() - this.updatedAt < 300_000) return this.models;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.codex.models(false).then((models) => {
      const visible = models.filter((model) => !model.hidden);
      if (!visible.length) throw new Error("Codex не вернул доступных моделей");
      this.models = visible;
      this.updatedAt = Date.now();
      return visible;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private inherited(models: CodexModel[]): ModelSelection {
    const model = this.config.model
      ? models.find((item) => item.model === this.config.model || item.id === this.config.model)
      : models.find((item) => item.isDefault);
    if (!model && !this.config.model) throw new Error("Codex не обозначил default; выберите модель явно");
    const supported = model?.supportedReasoningEfforts.map((item) => item.reasoningEffort) ?? [];
    const effort = supported.includes(this.config.effort)
      ? this.config.effort
      : model?.defaultReasoningEffort || this.config.effort;
    return {
      model: model?.model || this.config.model,
      effort,
      source: this.config.model ? "config" : "codex-default",
    };
  }

  private selected(conversation: Conversation, models: CodexModel[]): ModelSelection {
    return conversation.modelOverride
      ? { model: conversation.modelOverride, effort: conversation.effortOverride, source: "conversation" }
      : this.inherited(models);
  }

  async resolve(conversation: Conversation): Promise<ModelSelection> {
    if (conversation.modelOverride) return this.selected(conversation, this.models);
    try { return this.inherited(await this.catalog()); }
    catch (error) {
      if (this.config.model) return this.inherited(this.models);
      throw error;
    }
  }

  async overview(conversationId: string, refresh = true) {
    let catalogError: string | null = null;
    try { await this.catalog(refresh); }
    catch { catalogError = "Каталог Codex недоступен. Сохранённая настройка не изменена."; }
    const conversation = this.state.get(conversationId);
    let selection: ModelSelection | null = null;
    try { selection = this.selected(conversation, this.models); }
    catch (error) { catalogError ||= (error as Error).message; }
    return {
      conversationId,
      chatId: conversation.chatId,
      topicId: conversation.topicId,
      override: { model: conversation.modelOverride, effort: conversation.effortOverride },
      selection,
      models: this.models,
      catalogError,
      catalogUpdatedAt: this.updatedAt || null,
      inheritedSource: this.config.model ? "config" : "codex-default",
    };
  }

  async set(conversationId: string, model: string | null, effort?: string): Promise<ModelSelection> {
    const before = this.state.get(conversationId);
    let selection: ModelSelection;
    if (model === null) {
      // Resolve first: a missing default must never erase a working override.
      let models: CodexModel[];
      try { models = await this.catalog(true); }
      catch (error) {
        if (!this.config.model) throw error;
        models = this.models;
      }
      selection = this.inherited(models);
    } else {
      const models = await this.catalog(true);
      const candidate = models.find((item) => item.model === model || item.id === model);
      if (!candidate) throw new Error("Модель отсутствует в каталоге Codex");
      const selectedEffort = effort ?? candidate.defaultReasoningEffort;
      if (!candidate.supportedReasoningEfforts.some((item) => item.reasoningEffort === selectedEffort)) {
        throw new Error(`Для ${candidate.model} доступны effort: ${candidate.supportedReasoningEfforts.map((item) => item.reasoningEffort).join(", ")}`);
      }
      selection = { model: candidate.model, effort: selectedEffort, source: "conversation" };
    }
    const current = this.state.get(conversationId);
    if (current.projectId !== before.projectId || current.workspaceId !== before.workspaceId ||
        current.role !== before.role || current.modelOverride !== before.modelOverride ||
        current.effortOverride !== before.effortOverride) {
      throw new Error("Привязка или настройка topic изменилась; обновите состояние и повторите выбор");
    }
    this.state.setConversationModel(conversationId, model === null ? "" : selection.model,
      model === null ? "" : selection.effort);
    return selection;
  }
}
