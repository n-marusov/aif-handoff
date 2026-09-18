/**
 * Тонкий фасад над JSON-RPC клиентом codex app-server.
 *
 * Модуль не занимается транспортом: он лишь даёт типизированные методы под конкретные
 * методы протокола и следит за одним важным инвариантом - handshake `initialize`
 * выполняется ровно один раз. Однократность достигается тем, что в поле хранится сам
 * промис, а не его результат: второй параллельный вызов увидит уже созданный промис.
 *
 * Отдельная деталь протокола: после ответа на `initialize` клиент обязан отправить
 * отдельное уведомление "initialized" - сервер ждёт этого подтверждения, не считает
 * сессию готовой.
 */

import type { CodexAppServerMethod, CodexAppServerRequestMap } from "./protocol.js";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import { JsonlRpcClient, type JsonlRpcClientLogger } from "./jsonlRpcClient.js";

// Опции собраны в один объект, чтобы добавление новых полей не меняло сигнатуру
// конструктора. Все необязательные значения получают дефолт в конструкторе, а не здесь,
// поэтому интерфейс описывает только внешнюю форму вызова.
export interface CodexAppServerClientOptions {
  runtimeId: string;
  profileId?: string | null;
  transport?: string;
  requestTimeoutMs?: number;
  logger?: JsonlRpcClientLogger;
}

export class CodexAppServerClient {
  // rpcClient - единственная зависимость, отвечающая за реальный ввод-вывод;
  // класс намеренно не создаёт его сам, чтобы транспорт можно было подменить в тестах.
  private readonly rpcClient: JsonlRpcClient;
  private readonly logger?: JsonlRpcClientLogger;
  private readonly runtimeId: string;
  private readonly profileId: string | null;
  private readonly transport: string;
  private readonly requestTimeoutMs: number;
  // Кэш handshake: пока поле не null, повторные initialize() возвращают тот же промис,
  // а не запускают второй обмен сообщениями с сервером.
  private initializePromise: Promise<InitializeResponse> | null = null;

  constructor(rpcClient: JsonlRpcClient, options: CodexAppServerClientOptions) {
    // runtimeId/profileId/transport нужны только для логов: они позволяют понять, какое
    // из одновременно живых подключений сломалось.
    this.rpcClient = rpcClient;
    this.logger = options.logger;
    this.runtimeId = options.runtimeId;
    this.profileId = options.profileId ?? null;
    this.transport = options.transport ?? "app-server";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
  }

  async initialize(
    params: CodexAppServerRequestMap["initialize"]["params"],
  ): Promise<InitializeResponse> {
    if (this.initializePromise) {
      return this.initializePromise;
    }
    // Присваивание синхронное и происходит до первого await, поэтому два одновременных
    // вызова initialize() не могут создать два handshake: второй увидит уже готовый промис.
    this.initializePromise = this.request("initialize", params).then(async (result) => {
      // notify, а не request: подтверждение отправляется без id и без ожидания ответа,
      // поэтому оно не проходит через request() и не занимает pending-слот.
      await this.rpcClient.notify("initialized");
      // Пишем в лог после уведомления, а не после request(): только теперь сессия
      // действительно готова к работе, и запись честно отражает завершение handshake.
      this.logger?.debug?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
        },
        "DEBUG [runtime:codex] App-server initialize handshake completed",
      );
      return result;
    });
    return this.initializePromise;
  }

  // Этот метод инициализируется сам, не полагаясь на ensureInitialized: он публичный
  // и может быть вызван раньше любого другого обращения к клиенту.
  async listModels(
    params: CodexAppServerRequestMap["model/list"]["params"],
  ): Promise<CodexAppServerRequestMap["model/list"]["result"]> {
    await this.initialize({
      clientInfo: {
        name: "aif-runtime-codex-client",
        title: "AIF Runtime Codex Client",
        version: "1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    return await this.request("model/list", params);
  }

  // thread в терминологии codex - это диалог; thread/start создаёт новый,
  // ещё ни с чем не связанный.
  async startThread(
    params: CodexAppServerRequestMap["thread/start"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/start"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/start", params);
  }

  // Список нужен для возобновления работы после перезапуска процесса: id диалогов
  // переживают падение app-server, а in-memory состояние клиента - нет.
  async listThreads(
    params: CodexAppServerRequestMap["thread/list"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/list"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/list", params);
  }

  // Форк копирует историю диалога, чтобы можно было продолжить с развилки,
  // не изменяя оригинальный thread.
  async forkThread(
    params: CodexAppServerRequestMap["thread/fork"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/fork"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/fork", params);
  }

  // Чтение состояния не меняет диалог, поэтому его безопасно делать для инспекции
  // и восстановления позиции после перезапуска.
  async readThread(
    params: CodexAppServerRequestMap["thread/read"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/read"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/read", params);
  }

  // resume подключается к уже существующему thread id: новый процесс узнаёт о диалоге
  // только по идентификатору, вся остальная история хранится на стороне сервера.
  async resumeThread(
    params: CodexAppServerRequestMap["thread/resume"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/resume"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/resume", params);
  }

  // turn - один цикл "запрос пользователя -> ответ агента". Стриминг событий
  // начинается именно после старта turn, поэтому ответ и последующие уведомления
  // обрабатываются разными путями.
  async startTurn(
    params: CodexAppServerRequestMap["turn/start"]["params"],
  ): Promise<CodexAppServerRequestMap["turn/start"]["result"]> {
    await this.ensureInitialized();
    return await this.request("turn/start", params);
  }

  // interrupt - единственный штатный способ остановить генерацию, не убивая процесс:
  // убийство потеряло бы открытые диалоги и потребовало бы повторного handshake.
  async interruptTurn(
    params: CodexAppServerRequestMap["turn/interrupt"]["params"],
  ): Promise<CodexAppServerRequestMap["turn/interrupt"]["result"]> {
    await this.ensureInitialized();
    return await this.request("turn/interrupt", params);
  }

  close(reason = "client closed"): void {
    // Закрытие синхронное: вызывающий часто дёргает его из обработчика завершения
    // процесса, где ждать асинхронного результата уже некому и негде.
    this.rpcClient.close(reason);
  }

  private async ensureInitialized(): Promise<InitializeResponse> {
    // Единая точка с фиксированными capabilities: адаптер не использует экспериментальный
    // API и не поддерживает attestation, поэтому расширять эти флаги не нужно.
    return await this.initialize({
      clientInfo: {
        name: "aif-runtime-codex-client",
        title: "AIF Runtime Codex Client",
        version: "1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
  }

  private async request<M extends CodexAppServerMethod>(
    method: M,
    params: CodexAppServerRequestMap[M]["params"],
  ): Promise<CodexAppServerRequestMap[M]["result"]> {
    // Логируем до отправки: если запрос зависнет и упрётся в таймаут, в логе останется
    // след о том, какой именно метод не ответил.
    this.logger?.debug?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        method,
      },
      "DEBUG [runtime:codex] App-server RPC request",
    );

    // Соответствие "литерал метода -> тип результата" описано в CodexAppServerRequestMap,
    // но TypeScript не выводит его через дженерик M автоматически, поэтому результат
    // приводится к нужному типу вручную.
    return (await this.rpcClient.request(method, params, this.requestTimeoutMs)) as
      | CodexAppServerRequestMap[M]["result"]
      | Promise<CodexAppServerRequestMap[M]["result"]>;
  }
}
