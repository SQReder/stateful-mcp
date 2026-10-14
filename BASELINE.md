# Stateful Qwen Coding Worker — baseline v0.2

**Статус:** механика I0 принята пользователем; I1 и механика I2–I4 реализованы и проверены локально. Доступ и качество целевого Qwen отложены до deployment/пилота; состояние проверок — в IMPLEMENTATION_PLAN.md и TODO.md.
**Дата:** 2026-10-12.  
**Назначение:** универсальный stateful Coding Worker (MCP) и пилотная специализированная роль Qwen Test Supervisor в корпоративном Kilo Code.  
**Первый пилот:** написание тестов Vitest для существующего TypeScript-модуля. Пилот **не определяет архитектуру и публичный API**.

## 1. Назначение и границы

Разработчик работает в разрешённом корпоративном Kilo Code с Qwen3.6: через специализированную роль обсуждает задачу, выбирает необходимые материалы, проверяет варианты решения. Генерация кода поручается Qwen3-Next-80B-A3B-Instruct через самописный **stateful MCP**. Qwen3-Next используется как обычная instruct/chat-модель **без tool calls** и без доступа к репозиторию.

MCP хранит отдельный диалог с исполнителем, актуальный бриф, снимки переданных файлов, версии сгенерированных кандидатов, решения ревью и результаты проверки. До положительного ревью кандидат существует **только в хранилище MCP**, не в рабочем дереве. После ревью MCP временно применяет кандидат, запускает read-only компиляцию/проверку типов, при неудаче безопасно восстанавливает файлы. Только прошедший минимальную компиляцию кандидат получает raw Git commit без автоисправлений. Далее форматтер и линтер обрабатывают только файлы raw commit; изменения оформляются отдельным коммитом.

**Ключевой принцип:** универсален *worker*, а не роли, использующие его. Первый потребитель — специализированная Kilo-роль **Qwen Test Supervisor**. В дальнейшем через тот же протокол возможны реализация фич, исправление багов, рефакторинг, миграции, тесты и документация в коде. Переход к этим сценариям — отдельные расширения, не обещания текущего MVP.

### Что не делаем сейчас

- Второй LLM-харнесс и новый агентный фреймворк. Единственный разрешённый харнесс — корпоративный Kilo Code; MCP — самописный сервис и прокси к модели.
- Доступ Qwen3-Next к shell, git, файловой системе и tool calls.
- Автоматическое принятие кандидатов, самостоятельные инженерные решения MCP, автономный бесконечный цикл.
- Автоматический RAG, неявную компакцию, заполнение всех 96K токенов.
- Параллельное редактирование, несколько одновременно применяемых кандидатов, сложные worktree.
- `git reset`, squash и переписывание истории для KPI. Raw commit сохраняется в локальной истории; дальнейшая публикация находится вне MCP.
- Форматирование до raw commit.

## 2. Состав и ответственность

| Компонент | Отвечает за | Не отвечает за |
|---|---|---|
| Разработчик | Цель задачи, обсуждение подхода и ограничений, возможность вмешаться | Ручное копирование сообщений между моделями |
| Kilo Code / Qwen3.6 (Test Supervisor) | Проработка тестовых сценариев, выбор контекста, бриф, ревью тестов **до применения**, feedback и решение о принятии | Непосредственное редактирование исходников через собственные инструменты |
| Stateful MCP (Coding Worker) | Сессия, snapshots, сбор prompt, inference к Qwen3-Next, версии кандидатов, безопасное применение, проверки и Git | Архитектурные решения, семантическое ревью и выбор следующего шага |
| Qwen3-Next Instruct | Chat-ответы и код по переданному брифу и контексту | Работа с инструментами и самостоятельный поиск файлов |

В рамках пилота используем **специализированную роль Qwen Test Supervisor** (`qwen-test-supervisor` в `.kilocodemodes`). Она знает о тест-дизайне, сценариях, утверждениях и особенностях тестового кода. **MCP API и его состояние не знают про Vitest**. В дальнейшем другие роли (например, Feature Supervisor) могут работать с тем же Coding Worker без переписывания сервера.

## 3. Эталонный пилот: покрытие модуля тестами

1. Разработчик открывает в Kilo роль Qwen Test Supervisor и просит покрыть существующий TypeScript-модуль тестами.
2. Qwen3.6 анализирует реализацию, зависимости, типы, стиль существующих тестов и конфигурацию; вместе с разработчиком составляет тестовые сценарии и критерии приёмки. В MCP уходит уже готовый список сценариев.
3. Создаёт MCP-сессию **общей** задачи с одним `allowedPath`, например `src/pricing/calculate.test.ts`; передаёт brief, ожидаемый формат результата и пути к нужным исходникам.
4. MCP читает эти файлы, фиксирует их содержимое как snapshots и собирает ограниченный prompt. Qwen3-Next отвечает полным текстом тестового файла — кандидатом `c1`.
5. Qwen3.6 читает код и diff **без изменений проекта**. Если качество недостаточно, отправляет конкретные замечания в **тот же логический диалог** Qwen3-Next. Полученный `c2` снова проходит ревью. Число итераций определяется Supervisor и разработчиком; MCP сам не делает retry по смысловым ошибкам.
6. После `approve(cN)` MCP проверяет актуальность snapshots и чистоту рабочего дерева, временно записывает только разрешённый файл, запускает настроенный TypeScript typecheck, включающий `*.test.ts(x)`.
7. При неуспехе MCP восстанавливает исходное состояние целевого файла, возвращает диагностику в Kilo. Test Supervisor отправляет её Qwen3-Next с корректирующим брифом. **Новый кандидат снова проходит review loop до применения.**
8. При успешном typecheck MCP создаёт raw commit с обязательными Git hooks **до** форматирования, не затрагивая посторонние файлы. Hooks не обходятся. Если hooks изменили закоммиченный файл, MCP повторяет typecheck и сообщает `hooksModified` с diff изменений (решение пользователя 2026-10-13); сломанный hooks коммит остаётся в истории и возвращается как ошибка.
9. MCP сохраняет список изменённых raw-коммитом путей, затем запускает Prettier/ESLint fix только по этому списку, повторяет компиляцию и создаёт отдельный postprocess commit, если появились изменения.
10. MCP завершает задачу после локальных raw/postprocess коммитов. **Публикация — ответственность разработчика**, а не MCP: никаких push или проверок remote.
11. Kilo сообщает, что было сгенерировано, какие проверки действительно прошли, какие замечания устранены и что осталось проверить. Успешная компиляция **не равна** успешным тестам.

### Два независимых feedback loop

```text
Developer + Kilo / Qwen3.6: goal, design, context, acceptance criteria
                   │
                   ▼
       MCP session / Qwen3-Next chat
                   │
                   ▼
          Candidate (NOT applied)
                   │
                   ▼
           REVIEW / Qwen3.6
              │           │
          REJECT         APPROVE
              │           │
       feedback → chat   ▼
                    TEMPORARY APPLY
                          │
                    COMPILE / TYPECHECK
                       │       │
                     FAIL     PASS
                       │       │
                  restore     RAW COMMIT
                       │       │
                diagnostics   POSTPROCESS
                       │       │
                Qwen3.6 →    recheck +
                chat →       postprocess commit
                REVIEW
```

**Инварианты:** GENERATE не изменяет проект; REVIEW предшествует APPLY; неудачная компиляция не приводит к commit; каждый новый кандидат обязательно ревьюится заново; raw commit сохраняется в истории; auto-fix разрешён только после raw commit.

## 4. Общая доменная модель MCP

`Task` не должен знать, что такое Vitest. Различия сценариев передаются через бриф, контекст, целевые пути, формат выдачи и конфигурацию проверки.

```ts
type SessionId = string;
type CandidateId = string;

type ReviewFinding = {
  severity: 'blocker' | 'major' | 'minor';
  message: string;
  location?: string;
};

type ContextSnapshot = {
  path: string;           // workspace-relative
  content: string;        // immutable snapshot in MCP storage
  contentHash: string;    // detects staleness; not a Git commit SHA
  tokens: number;
};

type Candidate = {
  id: CandidateId;
  contextRevision: number;
  artifacts: Array<{ path: string; content: string }>;
  // PILOT: exactly one artifact with a complete *.test.ts(x) file.
  // FUTURE: multiple files or validated structured patch output.
  state: 'draft' | 'approved' | 'rejected' | 'committed';
  findings: ReviewFinding[];
};

type WorkerSession = {
  id: SessionId;
  workspaceRoot: string;
  objective: string;
  allowedPaths: string[];
  brief: string;
  acceptanceCriteria: string[];
  contextRevision: number;
  context: ContextSnapshot[];
  turns: Array<{ role: 'supervisor' | 'worker'; text: string }>;
  candidates: Candidate[];
  phase: 'draft' | 'review' | 'approved' | 'raw_committed' |
         'postprocessed' | 'conflict';
};
```

Stateful означает сохранение диалога, артефактов и истории **между** MCP-вызовами и перезапусками. Оно **не означает**, что все прежние сообщения и варианты повторно подаются в каждый prompt.

## 5. Общий MCP API

Названия ниже — проектируемый интерфейс, не существующие встроенные инструменты Kilo. В первом пилоте MCP реализует только один целевой файл и один validation profile, но названия и структура контрактов нейтральны к типу задачи.

```ts
session_start(input: {
  objective: string;
  allowedPaths: string[]; // PILOT: one *.test.ts(x) path
  acceptanceCriteria?: string[];
}): { sessionId: SessionId };

context_set(input: {
  sessionId: SessionId;
  files: string[];         // workspace-relative source paths
  brief: string;
  acceptanceCriteria: string[]; // required, non-empty: the agreed list the worker implements exactly
}): {
  contextRevision: number;
  estimatedInputTokens: number;
  warnings: string[];
};

worker_chat(input: {
  sessionId: SessionId;
  message: string;
}): {
  candidateId?: CandidateId;
  artifacts?: Array<{ path: string; content: string; edits?: Array<{ search: string; replace: string }> }>; // with candidateId: code ready for review
  responsePreview?: string;                     // raw reply, only when no candidate was created
  usage: { inputTokens: number | null; outputTokens: number | null };
  finishReason: string;
};

candidate_read(input: {
  sessionId: SessionId;
  candidateId: CandidateId;
}): {
  artifacts: Array<{ path: string; content: string; diff: string }>;
  contextRevision: number;
};

candidate_review(input: {
  sessionId: SessionId;
  candidateId: CandidateId;
  verdict: 'approve' | 'reject';
  findings: ReviewFinding[];
}): { state: 'approved' | 'rejected' };

candidate_apply(input: {
  sessionId: SessionId;
  candidateId: CandidateId;
  tsconfig?: string;       // workspace-relative tsconfig of the target's package; default WORKER_TSCONFIG
}): {
  status: 'committed' | 'validation_failed' | 'conflict' |
          'error' | 'no_changes';
  diagnostics: string[];
  changedFiles: string[];
};

postprocess(input: {
  sessionId: SessionId;
  packageDir?: string;     // where the tools run and resolve; default: directory of the apply tsconfig
}): {
  status: 'committed' | 'no_changes' | 'failed' | 'conflict';
  changedFiles: string[];
  diagnostics: string[];
};

session_status(input: { sessionId: SessionId }): {
  phase: string;
  latestCandidateId?: CandidateId;
  contextRevision: number;
  pendingAction?: string;
};
```

### Правила контракта

- `context_set` заменяет актуальный пакет контекста и увеличивает его revision; прежние candidates остаются в истории, но требуют повторного ревью на текущей revision.
- `worker_chat` делает ровно один inference request за вызов, не редактирует файлы, не принимает кандидатов и не запускает инструменты модели.
- `worker_chat` возвращает **содержимое** нового кандидата сразу; `candidate_read` даёт содержимое, diff и историю ревью конкретной версии (старые версии, после рестарта). Test Supervisor не полагается на описание исполнителя.
- Список сценариев (acceptance criteria) составляет роль вместе с разработчиком до генерации; `context_set` без него отклоняется, исполнитель реализует ровно этот список.
- `candidate_review(approve)` относится к конкретной версии и revision; без него `candidate_apply` запрещён.
- `candidate_apply` идемпотентен: повтор по тому же кандидату не должен создавать новый raw commit.
- MCP проверяет `allowedPaths`, snapshots и Git-предусловия, запрещает подмену/выход путей из workspace, изменения за пределами scope и частичное применение.
- При неудачной проверке восстановление возможно лишь если не перезаписывает чужих изменений. Иначе `conflict` и остановка.
- Оборванный ответ модели, некорректно распознанный output или переполнение бюджета не создаёт кандидат для одобрения.
- `postprocess` разрешён лишь после raw commit; он не изменяет другие файлы даже если formatter умеет широкие glob/`--fix`.
- Параллельные сессии могут храниться, но в v0.2 только одна сессия вправе менять workspace одновременно.

## 6. Контекст исполнителя

Фактическое доступное окно корпоративного Instruct endpoint — **96K токенов** (уточнено пользователем 2026-10-13). Это потолок, а не желательная длина запроса. Слабой модели полезен **не максимальный, а тщательно отобранный** контекст.

Политика (решение пользователя 2026-10-13 вместо стартовых 32K): безопасный hard input budget — 64K, warning после 48K, резерв на вывод 8192. Оценка — `ceil(UTF-8 bytes / 3) + 256`, консервативная эвристика до проверки tokenizer целевой модели. Учитывать system message, заголовки файлов, формат ответа и технические токены. Нельзя молча отрезать файлы.

Пакет для каждого запроса собирается заново:

```text
SYSTEM: constrained instruct coding worker; no tools
TASK: current objective + brief + acceptance criteria
CONTEXT: selected file snapshots, with path labels
CURRENT CANDIDATE: latest full version only, when needed
OPEN FEEDBACK: active unresolved review/compile findings
USER: current request from Qwen3.6
```

Полная история сообщений и все кандидаты хранятся в MCP storage, но не реплеятся целиком. Обновление требований — явное действие Supervisor. Для повторных итераций сохраняем актуальный кандидат и только релевантные нерешённые замечания. Если информация не помещается в бюджет, MCP возвращает предупреждение/ошибку, а Test Supervisor уточняет `context_set`.

## 7. Валидация и Git

### Общая политика

Минимальный обязательный gate для *программного кода* — **успешная компиляция / typecheck**, включающая реально изменённые файлы. Дополнительные проверки могут быть обязательными для конкретной задачи (например, тесты, линт, сборка), но на MVP не вводим абстрактный исполняемый pipeline от LLM. Validation commands определяются доверенной конфигурацией репозитория/MCP и **не** принимаются произвольной shell-строкой от Qwen3.6. Решение пользователя 2026-10-13 для монорепозиториев: Qwen3.6 выбирает **путь** к tsconfig пакета (`candidate_apply.tsconfig`) и каталог пакета для инструментов (`postprocess.packageDir`). Это пути к файлам внутри проекта с теми же проверками границ; команды, флаги и набор инструментов остаются фиксированными в MCP, а проверка `--listFilesOnly` по-прежнему доказывает, что целевой тест входит в typecheck.

Кандидат проходит: `review(approve)` → apply only allowed paths → read-only validation → `raw commit` с обязательными hooks → postprocess only paths changed in raw commit → повторная validation → postprocess commit при наличии изменений.

- Для пилота запускается TypeScript typecheck с включёнными Vitest-файлами; `tsc --noEmit` без подходящего `tsconfig` недостаточен.
- Если до raw commit validation не прошла, MCP восстанавливает старые файлы; диагностика идёт в feedback loop, новый кандидат снова проходит ревью.
- После raw commit история **не переписывается**. Список изменённых файлов определяется сразу после коммита через Git, например `git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r -z HEAD` (не нужно хранить SHA в публичном MCP API).
- Форматирование/ESLint auto-fix выполняются только на этом списке; после изменений обязательна повторная проверка компиляции.
- Если повторная проверка падает, postprocess не коммитится. Raw commit остаётся; инструменты должны безопасно вернуть рабочие файлы к состоянию raw commit, не удаляя пользовательские правки.
- Нельзя использовать `git add -A`. Stage только явно разрешённые изменённые пути. По решению пользователя 2026-10-13 требование мягче, чем «чистое дерево»: целевой файл не изменён и index пуст, иначе `conflict`; незастейдженная и неотслеживаемая работа в других файлах допустима и в коммит не попадает. Решение пользователя 2026-10-14: G5 требует отсутствия ошибок typecheck в целевом файле; ошибки только в других файлах (старые ошибки монорепо, незаконченная работа) не блокируют коммит и возвращаются как `typecheck_errors_outside_target`. Провал `tsc` без диагностики не считается прохождением.
- **Внешнее условие KPI:** учитывается код, который был закоммичен **и запушен**. MCP создаёт локальные коммиты; публикацией и её проверкой занимается разработчик. Никакого push, статусов публикации или обращения к remote в MCP API нет.

Безопасность при рестарте и внешних Git-изменениях требует внутренних проверок HEAD и изменённых путей. Это детали реализации MCP, не причины вводить пользовательские SHA-аргументы.

## 8. Приёмочные критерии пилота

1. Kilo с ролью **Qwen Test Supervisor** прорабатывает тестовые сценарии, создаёт сессию, формирует бриф и передаёт исходники Qwen3-Next.
2. Qwen3-Next не имеет инструментов; первый результат — полный кандидат **одного тестового файла**, не patch.
3. Ревью до применения позволяет несколько раз исправить кандидат в **той же** stateful-сессии; до approve рабочее дерево не меняется.
4. При ошибке компиляции исходные файлы безопасно восстановлены, нет raw-коммита, диагностика возвращается Supervisor.
5. Исправление после ошибки компиляции снова проходит review loop.
6. Компилируемый кандидат создаёт raw commit без предварительного auto-fix; postprocess трогает только изменённые raw-коммитом файлы.
7. Если formatter изменил код, повторный typecheck проходит до отдельного коммита форматирования.
8. Сессия, контекст, замечания и кандидаты восстанавливаются по sessionId после перезапуска MCP.
9. При превышении бюджета контекста, конфликте Git и посторонних изменениях выполнение безопасно останавливается.
10. **Базовый MCP API и модель сессии не предполагают, что это обязательно тесты.** Специализация на тестах находится в роли `qwen-test-supervisor`, пилотном brief и validation configuration, а не в Coding Worker.

## 9. После пилота (не входит в MVP)

- Многофайловые кандидаты, операции add/modify/delete/rename, атомарное применение.
- Генерация diffs и структурированных patches наряду с полными файлами.
- Профили проверок для feature, bugfix, refactoring, migrations.
- Изоляция через worktree, параллельные задачи, безопасное резюмирование длинных диалогов.
- Метрики качества: число итераций, реальное время принятия изменения, доля ручных исправлений, дефекты после ревью; корпоративный KPI отдельно.

## 10. Интеграционные вопросы

- Реальный API, идентификатор и tokenizer Qwen3-Next endpoint, применимый лимит 96K.
- Реальное подключение MCP и загрузка роли в корпоративном Kilo Code; форматы и возможности принимаются как в апстриме, кроме выбора моделей и отсутствующего `webfetch`.
- Обязательные check scripts проекта и путь к `tsconfig`, включающему тесты.
- Условие KPI известно: код должен быть закоммичен и запушен. Публикация полностью вне MCP; уточнять механизм push и проверки remote в этом проекте не требуется.

**Результат v0.2:** универсальный stateful Coding Worker с конкретной специализированной ролью **Qwen Test Supervisor** и намеренно узким Vitest-пилотом. В будущем можно добавлять другие роли без изменения базовой механики MCP; поддерживать их сейчас не требуется.
