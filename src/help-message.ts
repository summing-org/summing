const MARKDOWN_V2_RESERVED_TEXT = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function text(value: string): string {
  return value.replace(MARKDOWN_V2_RESERVED_TEXT, (character) => `\\${character}`);
}

function bold(value: string): string {
  return `*${text(value)}*`;
}

function code(value: string): string {
  return `\`${value.replace(/[\\`]/g, (character) => `\\${character}`)}\``;
}

function command(syntax: string, description: string): string {
  return `${code(syntax)}${text(` — ${description}`)}`;
}

function example(value: string): string {
  return `${text("Пример: ")}${code(value)}`;
}

export function helpMessage(isAdministrator: boolean): string {
  const lines = [
    bold("Помощь по SUMMING"),
    text("Для администратора основной интерфейс — Mini App «Управление» в меню личного чата."),
    `${text("Аргументы в ")}${code("<угловых скобках>")}${text(" обязательны, в ")}${code("[квадратных]")}${text(" — нет")}`,
    "",
    bold("Проекты"),
    command("/projects", "показать доступные проекты и Workspace"),
    command("/bind <project> [workspace]", "привязать текущий topic"),
    example("/bind shop backend"),
    command("/topic_id", "показать chat_id и topic_id текущего Telegram-топика"),
    command("/status", "показать версию SUMMING, состояние Codex, привязку и очередь"),
    command("/files", "открыть дерево файлов, diff и project runner"),
    command("/env", "открыть энвы репозитория"),
    "",
    bold("Работа"),
    text("Отправьте задачу обычным сообщением"),
    example("Добавь валидацию email и запусти тесты"),
    text("Можно приложить document или ZIP до 20 МБ"),
    text("Voice и audio транскрибируются через OpenAI gpt-transcribe (или Groq) и передаются как текст"),
    command("/steer <текст>", "уточнить активную задачу"),
    example("/steer Не меняй публичный API"),
    text("Ответ на сообщение текущего ответа тоже уточняет активную задачу"),
    command("/cancel", "остановить активную задачу или создание проекта"),
    "",
    bold("Контекст и память"),
    command("/new", "начать новый контекст в topic"),
    command("/remember <факт>", "сохранить факт в общей памяти проекта"),
    example("/remember Все даты в API передаём в UTC"),
    command("/memory", "показать состояние и знания текущего Team Space"),
    command("/memory_me", "показать сохранённые обо мне события и выводы"),
    command(
      "/memory_forget_me",
      "удалить содержимое моих событий и остановить дальнейшее наблюдение",
    ),
    command("/memory_resume_me", "снова разрешить сохранять мои будущие сообщения"),
    command("/review", "проверить текущие незакоммиченные изменения без их исправления"),
  ];

  if (isAdministrator) {
    lines.push(
      "",
      bold("Только для администратора"),
      text("Команды ниже остаются резервным интерфейсом для диагностики и восстановления."),
      command("/admin", "открыть центр управления Mini App"),
      command("/login", "войти в ChatGPT через device code в личном чате"),
      command("/limits", "показать 5-часовой и недельный Codex limits этого VPS"),
      command("/sync_status [chat_id]", "показать состояние синхронизации базы знаний"),
      command("/topics", "показать обнаруженные Telegram группы, топики и привязки"),
      command("/memory_pause", "приостановить наблюдение текущего Team Space"),
      command("/memory_resume", "возобновить наблюдение текущего Team Space"),
      command(
        "/bind_topic <chat_id> <topic_id> <project> [workspace]",
        "привязать топик из личного чата",
      ),
      example("/bind_topic -1001234567890 42 summing repo"),
      command("/project_create <project> <primary_owner_id> <repo>", "создать локальный Git-проект"),
      example("/project_create shop 123456789 backend"),
      command(
        "/project_clone <project> <primary_owner_id> <repo> <git_url>",
        "клонировать Git-проект",
      ),
      example("/project_clone shop 123456789 backend https://github.com/acme/backend.git"),
      command("/restart", "перезапустить SUMMING"),
      command("/panic", "немедленно остановить SUMMING без автоматического рестарта"),
    );
  }

  return lines.join("\n");
}
