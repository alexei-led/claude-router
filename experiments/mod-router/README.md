# Router через Claude Code Mods

**Вывод: Mods подходят для переноса роутера внутрь Claude Code.** Основное преимущество — выбор модели до отправки запроса и собственный UI в том же сеансе. Рекомендую перенести транспортный слой, сохранив существующую политику и её тесты. Полная замена production-роутера требует проверок ниже.

Проверено 4 октября 2026 года на Claude Code **2.1.289**, через `ce team`. Этот каталог содержит исследовательский прототип. Native controller и панель реализованы отдельно; их текущие проверки и ограничения описаны в [руководстве кандидата](../../docs/native-router.md). Production packaging и launcher ещё не переключены.

## Что дают Mods

`turn.step` возникает перед запросом модели. Hook может изменить `model` и `effort`, передать запрос через `yield* next(request)`, а затем прочитать ответ и usage. Остальные поля события закреплены за движком. Полный HTTP body и beta headers этот hook не предоставляет. [Контракт событий](https://code.claude.com/docs/en/plugins/mods/events), [типизация движка](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts).

`turn.start` даёт текст и ID нового turn. `turn.step` даёт ID, индекс запроса и `agentId` для subagent. Поэтому решение можно хранить на turn и применять к запросам после tool results, не классифицируя их повторно. Движок уже предоставляет идентичность turn: хешировать последний user message для этого больше не нужно.

UI можно рисовать в `AbovePrompt`, в отдельной `Pane` и в существующих render sites. `$.state` переживает hot reload и обновляет подписанный UI. `$.store` сохраняет данные между сеансами. [UI и состояние](https://code.claude.com/docs/en/plugins/mods/interface).

## Проверенный прототип

[register.mjs](hooks/register.mjs) меняет модель только при явном маркере в начале prompt:

| Prompt                  | Запрос                                          |
| ----------------------- | ----------------------------------------------- |
| `[router-mod:haiku] …`  | `claude-haiku-4-5`, без поля `effort` в событии |
| `[router-mod:sonnet] …` | `claude-sonnet-5-5`, `effort: low`              |
| Без маркера             | Исходная модель                                 |

Выбор сохраняется на продолжениях того же turn. Subagents и чужие turns проходят без изменений. Ответные chunks и usage передаются дальше. Строка над prompt показывает фактическую модель из response usage и сохраняет UI остальных mods.

Первый live-запрос обнаружил важное отличие: `model: 'haiku'` отправляется буквально и получает `404 model: haiku`. Здесь нужны полные model IDs. После исправления сеанс, запущенный с `--model sonnet`, ответил `MOD_OK` через **`claude-haiku-4-5-20251001`**. Это подтверждено response usage, а не словами самой модели.

`sec-default` был загружен первым и допустил этот user-tier Mod. Это проверка текущего Team-сеанса, не гарантия для любой организации: `allowManagedModsOnly` может запретить загрузку. [Политика организации](https://code.claude.com/docs/en/plugins/mods/admin), [реализация sec-default](https://github.com/anthropics/claude-code/blob/main/mods/sec-default/hooks/register.ts).

Дополнительно прошёл live roundtrip в одной беседе:

| Turn               | Фактическая модель          | Ответ   |
| ------------------ | --------------------------- | ------- |
| 1: запомнить слово | `claude-haiku-4-5-20251001` | `OK`    |
| 2: назвать слово   | `claude-sonnet-5-5`         | `LEMON` |
| 3: назвать слово   | `claude-haiku-4-5-20251001` | `LEMON` |

Модель каждого turn проверялась по `assistant.message.model`. `modelUsage` в stream-json накапливается за сеанс и для этой проверки не годится. Простая история пережила обе смены модели.

Первый roundtrip наследовал настройки `ce team`. Последующие probes использовали прямой Anthropic base URL и отключённый старый router plugin. Sonnet/Opus приняли более 589K input tokens; последовательность Sonnet → Opus → Haiku сохранила tool results. Полная acceptance matrix остаётся открытой.

## Что переиспользовать и что заменить

| Сейчас                                              | В Mod                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `lib/config.mjs`, `lib/policy.mjs`, `lib/cost.mjs`  | Сохранить чистую логику, цены, context-fit, hysteresis и cache-cost gates          |
| `lib/facts.mjs`                                     | Адаптер из `turn.start`, `$.session.messages()`, tool outcomes и сохранённой usage |
| `lib/jev.mjs`                                       | Сохранить формат запроса и parser. Адаптировать HTTP, deadline и retry             |
| `lib/router.mjs`                                    | Координатор событий с решением на turn и отдельным состоянием subagents            |
| `lib/store.mjs`                                     | `$.state` для UI и решений, `$.store` для долговременных данных                    |
| `lib/gateway.mjs`, lifecycle scripts, `lib/sse.mjs` | Кандидаты на удаление после проверки нативной совместимости                        |
| `lib/rewrite.mjs`                                   | Удалять только после проверки всех нужных возможностей при смене моделей           |
| Statusline и tier skills                            | Нативная строка, `/router`, панель причин выбора и ручной override                 |

Модули Mod работают без Node API. `config`, `policy` и `cost` не требуют Node imports. `facts` использует `node:crypto`, `store` — файловые Node API. Для них нужны адаптеры. `askJev` принимает `fetchFn`, но ожидает Fetch Response и использует `AbortSignal.timeout`: одной подстановки `$.http.fetch` недостаточно. [Создание Mod](https://code.claude.com/docs/en/plugins/mods/create).

## Предлагаемая архитектура

1. На первом `turn.step` собрать текст из `turn.start`, последние сообщения и реальные context/usage figures. Получить совет Jev. Применить существующую policy и ручной pin.
2. Сохранить решение по turn. На tool continuations использовать его снова. Не переопределять нативный fallback без явного правила.
3. Передать полный model ID и поддерживаемый effort в `next`. Оставить движку отправку, streaming и выполнение tools.
4. После ответа обновить cache accounting из четырёх token counters и фактической модели. Не считать запрошенную модель фактической.
5. Над prompt показывать tier, модель, effort и причину. В `/router` открыть детали и ручной выбор. Команду и UI можно сделать без добавления инструкций в контекст модели.

Практический порядок миграции: сначала подключить Jev и policy к изолированному Mod, затем закрыть проверки совместимости. После этого переключить Team-launcher на нативную модель и убрать gateway из запуска. Личный профиль для экспериментов не нужен.

## Что пока нельзя считать решённым

- **Deadline Jev.** В локально сгенерированном `HttpInit` нет `timeout` или `signal`. Текущий router ограничивает ожидание 1500 мс. Для Mod нужно проверить deadline с fallback, остановку фонового запроса и circuit breaker. Hook budget не заменяет deadline: ожидание `$` calls не расходует его. [API](https://code.claude.com/docs/en/plugins/mods/api), [контракт](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts).
- **Совместимость моделей.** Один успешный Sonnet → Haiku не доказывает обработку длинной истории, tool additions, per-turn controls, 1M beta, max output и подписанных thinking blocks. `turn.step` не даёт менять эти части body. Если движок не адаптирует нужную возможность, для неё останется необходим gateway.
- **Effort и thinking.** Отсутствие `effort` в событии не доказывает отключение thinking. В успешном live-запросе Haiku usage содержала thinking tokens. Это отдельная проверка, не основание переносить `withoutThinking` буквально.
- **Cache economics.** Usage показывает cache read/write counts, но не полный request prefix и его TTL. Смена модели всё ещё создаёт холодный cache. Mod не устраняет эту цену. Нужно сохранить cost gates и проверить оценки на реальной смене моделей.
- **Fallback и ошибки.** Каждый вызов `next` делает запрос. Повторный вызов после частичного streaming способен повторить результат или расходы. Классификацию можно повторять по отдельному правилу. Model request не должен повторяться автоматически внутри catch.
- **Границы доступа.** Встроенные модели должны оставаться в разрешённом организацией наборе. Поведение `availableModels` при подмене через `turn.step` не подтверждено. Проверить отдельно. Отсутствие запрета в `sec-default` не означает разрешение любой модели.
- **Приватность.** Как и сейчас, Jev получает prompt и выбранные фрагменты истории. Смена транспорта это не меняет. Не отправлять raw tools, credentials или весь transcript. Использовать текущие ограничения текста. Mods исполняются с доступом Claude Code к машине. [Анонс](https://claude.com/blog/claude-code-mods).
- **Версии.** API имеет статус early access. GitHub declaration отмечена 2.1.277. Локальный движок — 2.1.289. Для разработки использовать типы, сгенерированные установленным Claude, и закрепить минимальную проверенную версию.

## Воспроизведение

Из корня репозитория:

```sh
ce team plugin validate "$PWD/experiments/mod-router"
CLAUDE_CONFIG_DIR="$HOME/.claude-team" claude plugin test "$PWD/experiments/mod-router"
node experiments/mod-router/scripts/live-roundtrip.mjs
```

`ce team` добавляет `--settings` перед subcommand, а `plugin test` требует отсутствие options перед `plugin`. Поэтому тесты запускаются напрямую с Team config directory. Они не вызывают модель или сеть. Live script использует `ce team`, выполняет три настоящих model requests, отключает tools и обычные MCP servers, не сохраняет transcript.

Для интерактивного просмотра:

```sh
ce team --plugin-dir "$PWD/experiments/mod-router" --model sonnet
```

Введите `[router-mod:haiku] Reply OK.`. Отображение дерева UI проверено native test kit для terminal и desktop. Ручная проверка отрисовки в окне приложения не выполнялась. [Нативные тесты](https://code.claude.com/docs/en/plugins/mods/test).

## Результат проверок

- Native plugin validation: passed, без предупреждений.
- Native tests: 3 passed, 0 failed. Проверяют маршрутизацию, продолжения, pass-through, usage и UI.
- TypeScript tests против локальных generated types: passed.
- Biome прототипа и текущего проекта: passed.
- Текущие production tests: 242 passed, 0 failed.
- Live roundtrip: 3 из 3 turns прошли, с проверкой фактической модели и памяти беседы.
- Проверки документа: ссылки passed, prose-lint 0 findings. Диаграмм нет. `render-mermaid.sh` ошибочно выдал `FAIL` для несуществующих диаграмм: на этом macOS `seq 1 0` возвращает `1` и `0`. Это сбой helper, а не пропущенная проверка существующей диаграммы.
- Jev end-to-end, реальные tools/subagents, resume/hot reload и полный набор request features: ещё не проверены.

Рабочая рекомендация: развивать **нативный Mod с существующей policy**. Gateway оставить рабочим до прохождения проверок совместимости, затем удалить его из обычного пути Claude Code. Отдельный Mod только для statusline даёт меньше пользы, чем уже подтверждённый нативный выбор модели.

## Trace evaluation

Теневая оценка нативной политики на санитизированном срезе `decisions.jsonl`: только сессии Claude Team, только агрегаты. Все числа — **shadow estimate** по list prices (план-модели, не счёт). Измеренной или контрфактической экономии здесь нет и быть не может.

Запуск: `node experiments/mod-router/scripts/trace-eval.mjs` (читает домашний каталог, пишет `results/trace-evaluation.json`; ни промптов, ни session ID, ни имён агентов, ни путей в результат не попадает). Тесты: `node --test test/trace-eval.test.mjs`.

Что делает:

- Team-сессии берутся по именам `<uuid>.jsonl` и каталогов `<uuid>` в каталоге проектов Team. Строки остальных сессий (общий лог с личным плагином) отбрасываются.
- Считает строки (все, Team, observations, main-решения, main с advice, subagent и прочие исключённые), переходы маршрута вверх/вниз/без изменения по парам tier и по дням UTC, гистограмму причин записанных решений.
- Для main-решений с advice прогоняет `lib/policy.mjs` `decide()` дважды из одного состояния: с `lib/cost.mjs` (legacy) и с `lib/native-cost.mjs` (консервативные границы), оба на текущем конфиге по умолчанию с подстановкой записанных ID моделей. После `decide()` применяется `fitTier`, как в `router.mjs` и `chooseRoute`. Цепочка состояния (голоса, hold) идёт по legacy-политике на данных трассы. Сверка: legacy-реплей воспроизводит записанные tier и reason (parity 1704/1704 на снимке).
- Нативный префикс кэша (`cache_read + cache_creation`) в трассе восстановить нельзя: нет разделения uncached/creation. Нативная ветка считается на двух границах префикса (только `cacheReadTokens` и весь запрос); решение учитывается как prefix-robust, только если обе границы дают один исход.
- Для различающихся переключений даётся диапазон стоимости следующего запроса (кандидат минус текущий, min/max USD) по формуле `chooseRoute`.

Покрытие и пробелы (подробнее в блоках `coverage` и `limitations` JSON):

- `uncached`, `cache_creation` и точный префикс: unavailable для 100% observations. Точный нативный реплей: 0 из 37 main-решений с advice; ограниченный (по границам) реплей: 37 из 37, prefix-robust: 37 из 37.
- TTL: залогированный `1h` — свидетельство, `5m` — значение по умолчанию, а не свидетельство. Нативная ветка по контракту игнорирует TTL.
- Escalation, hold после escalation и pin зависят от фактов, которых нет в трассе: они применяются к цепочке состояния, но не сравниваются.
- Выборка мала: на снимке 37 main-решений с advice из 11 619 main-строк (остальные — продолжения tool или без advice), 8 дошли до шага «налог против порога», различающихся решений 0. Subagent-строк в Team-сессиях нет. 251 строка до появления заголовка request class не классифицирована и исключена (6 из них с advice).
- Лог живой: числа в README — снимок, актуальные значения в JSON.
