export function helpMessage(isAdministrator: boolean): string {
  const lines = [
    "*Помощь по Summate*",
    "Аргументы в `<угловых скобках>` обязательны, в `[квадратных]` — нет",
    "",
    "*Проекты*",
    "`/projects` — показать доступные проекты и Workspace",
    "`/bind <project> [workspace]` — привязать текущий topic",
    "Пример: `/bind shop backend`",
    "`/status` — показать состояние Codex, привязку и очередь",
    "",
    "*Работа*",
    "Отправьте задачу обычным сообщением",
    "Пример: `Добавь валидацию email и запусти тесты`",
    "`/steer <текст>` — уточнить активную задачу",
    "Пример: `/steer Не меняй публичный API`",
    "Ответ на сообщение текущего ответа тоже уточняет активную задачу",
    "`/cancel` — остановить активную задачу или создание проекта",
    "",
    "*Контекст и память*",
    "`/new` — начать новый контекст в topic",
    "`/remember <факт>` — сохранить факт в общей памяти проекта",
    "Пример: `/remember Все даты в API передаём в UTC`",
    "`/review` — проверить текущие незакоммиченные изменения без их исправления",
  ];

  if (isAdministrator) {
    lines.push(
      "",
      "*Только для администратора*",
      "`/login` — войти в ChatGPT через device code в личном чате",
      "`/project_create <project> <owner_id> <repo>` — создать локальный Git\\-проект",
      "Пример: `/project_create shop 123456789 backend`",
      "`/project_clone <project> <owner_id> <repo> <git_url>` — клонировать Git\\-проект",
      "Пример: `/project_clone shop 123456789 backend https://github.com/acme/backend.git`",
      "`/restart` — перезапустить Summate",
      "`/panic` — немедленно остановить Summate без автоматического рестарта",
    );
  }

  return lines.join("\n");
}
