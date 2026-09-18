import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertBox } from "@/components/ui/alert-box";
import { Spinner } from "@/components/ui/spinner";
import {
  useCancelCodexLogin,
  useCodexLoginCapabilities,
  useCodexLoginStatus,
  useStartCodexLogin,
} from "@/hooks/useCodexLogin";

type WizardStep = "idle" | "awaiting_completion" | "success" | "error";

interface ViewState {
  step: WizardStep;
  verificationUrl: string | null;
  userCode: string | null;
  sessionId: string | null;
  error: string | null;
}

const INITIAL_VIEW: ViewState = {
  step: "idle",
  verificationUrl: null,
  userCode: null,
  sessionId: null,
  error: null,
};

type FailureReason =
  | "exit_nonzero"
  | "signal"
  | "timeout"
  | "parse_timeout"
  | "cancel"
  | "spawn_failed";

function failureMessage(
  reason: string | undefined,
  exitCode: number | null,
  signal: string | null,
): string {
  switch (reason as FailureReason | undefined) {
    case "exit_nonzero":
      return `Codex CLI exited with code ${exitCode ?? "?"} before completing login. Check the agent logs (TLS / network).`;
    case "signal":
      return `Codex CLI was killed by signal ${signal ?? "?"} before completing login.`;
    case "timeout":
      return "Codex login session timed out after 5 minutes. Click Retry to start a fresh code.";
    case "parse_timeout":
      return "Codex CLI did not print a verification URL within 15 seconds. Check the agent logs and the codex binary version.";
    case "cancel":
      return "Codex login was cancelled.";
    case "spawn_failed":
      return "Could not spawn the codex CLI. Verify the binary is installed in the agent container.";
    default:
      return "Codex login ended without success and the broker did not report a reason.";
  }
}

/**
 * Пошаговый мастер для `codex login --device-auth`, запускаемого внутри
 * контейнера агента. CLI печатает фиксированный verification URL и одноразовый
 * код; пользователь открывает URL в браузере хоста, вводит код, и CLI
 * завершается после подтверждения ChatGPT. Запрос статуса опрашивает брокера
 * до выхода дочернего процесса.
 *
 * Собран только из существующих UI-примитивов — не добавляй новые примитивы
 * без синхронизации с дизайном Pencil.
 */
export function CodexLoginCard() {
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const [codeCopied, setCodeCopied] = useState(false);
  // Отслеживает, сообщал ли опрашиваемый статус об активной сессии
  // для текущего запуска мастера. Без этой защиты начальный неактивный
  // ответ статуса вступил бы в гонку с оптимистичным переходом
  // `awaiting_completion` из `handleStart` и сразу переключил мастер в
  // success — хотя пользователь ещё не прошёл флоу.
  const sawActiveRef = useRef(false);

  const capabilities = useCodexLoginCapabilities();
  // Начальная загрузка выполняется один раз, когда карточка впервые входит в
  // idle/awaiting_completion (чтобы подхватить существующую сессию). После
  // success/error запрос отключён. Опрос по интервалу идёт только в
  // awaiting_completion. Без этих защит брокер получал бы запросы на каждый
  // ремант StrictMode, на фокус окна, на реконнект — и раз в секунду в простое.
  const statusQuery = useCodexLoginStatus({
    enabled: view.step === "idle" || view.step === "awaiting_completion",
    pollIntervalMs: view.step === "awaiting_completion" ? 1_000 : false,
  });
  const startMutation = useStartCodexLogin();
  const cancelMutation = useCancelCodexLogin();

  // Подхватывает любую существующую сессию, о которой сообщает брокер (пользователь
  // перезагрузил страницу), и определяет терминальный статус (success / ненулевой
  // код выхода / сигнал / timeout / cancel), когда активная сессия становится
  // неактивной. Success требует явного `lastResult.ok === true` от брокера — мы
  // никогда не выводим успех из простого отсутствия активного дочернего процесса,
  // потому что codex `--device-auth` может завершиться с ошибкой (сбой сети,
  // отмена в браузере и т.п.), и UI не должен врать о состоянии аутентификации.
  useEffect(() => {
    const data = statusQuery.data;
    if (!data) return;
    if (data.active) {
      sawActiveRef.current = true;
      if (view.step === "idle") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setView({
          step: "awaiting_completion",
          verificationUrl: data.verificationUrl,
          userCode: data.userCode,
          sessionId: data.sessionId,
          error: null,
        });
      }
      return;
    }
    if (view.step !== "awaiting_completion" || !sawActiveRef.current) return;
    const result = data.lastResult;
    // Устаревший lastResult (другая сессия) — игнорируем, продолжаем ждать.
    if (result && view.sessionId !== null && result.sessionId !== view.sessionId) return;
    sawActiveRef.current = false;
    if (result?.ok) {
      setView({
        step: "success",
        verificationUrl: null,
        userCode: null,
        sessionId: null,
        error: null,
      });
      return;
    }
    setView({
      step: "error",
      verificationUrl: null,
      userCode: null,
      sessionId: null,
      error: failureMessage(result?.reason, result?.exitCode ?? null, result?.signal ?? null),
    });
  }, [statusQuery.data, view.step, view.sessionId]);

  const disabledStart = startMutation.isPending;

  const handleStart = async (): Promise<void> => {
    sawActiveRef.current = false;
    setView(INITIAL_VIEW);
    try {
      const res = await startMutation.mutateAsync();
      // Не ставим sawActiveRef здесь — авторитетный сигнал о том, что у брокера
      // есть активный дочерний процесс, даёт только опрос статуса. Если запрос
      // ещё не подтвердил active=true, а мы уже видим active=false, — это шум
      // из устаревшего снапшота, а не завершение.
      setView({
        step: "awaiting_completion",
        verificationUrl: res.verificationUrl,
        userCode: res.userCode,
        sessionId: res.sessionId,
        error: null,
      });
    } catch (err) {
      // 409 = у брокера уже есть активная сессия (например, после перезагрузки страницы).
      if (err instanceof ApiError && err.status === 409) {
        const body = err.data as
          | { sessionId?: string; verificationUrl?: string; userCode?: string }
          | undefined;
        if (body?.verificationUrl && body.userCode && body.sessionId) {
          setView({
            step: "awaiting_completion",
            verificationUrl: body.verificationUrl,
            userCode: body.userCode,
            sessionId: body.sessionId,
            error: null,
          });
          return;
        }
      }
      setView({
        ...INITIAL_VIEW,
        step: "error",
        error: err instanceof Error ? err.message : "Failed to start Codex login",
      });
    }
  };

  const handleCopyCode = async (): Promise<void> => {
    if (!view.userCode) return;
    try {
      await navigator.clipboard.writeText(view.userCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {
      // игнорируем — пользователь может скопировать код вручную с экрана
    }
  };

  const handleCancel = async (): Promise<void> => {
    try {
      await cancelMutation.mutateAsync();
    } catch {
      // Даже если отмена не удалась, UI сбрасывается, чтобы пользователь мог повторить.
    }
    sawActiveRef.current = false;
    setView(INITIAL_VIEW);
  };

  if (capabilities.data && capabilities.data.loginProxyEnabled !== true) {
    return <></>;
  }

  const heading = (() => {
    switch (view.step) {
      case "awaiting_completion":
        return "Waiting for browser confirmation…";
      case "success":
        return "Codex login succeeded";
      case "error":
        return "Codex login error";
      default:
        return "Codex OAuth login (Docker)";
    }
  })();

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{heading}</h3>
          <p className="text-xs text-muted-foreground">
            Use this wizard only when running inside Docker and you do not have
            <code className="mx-1">OPENAI_API_KEY</code> configured.
          </p>
        </div>

        {view.step === "idle" && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Click Start to spawn <code>codex login --device-auth</code> inside the agent container
              and receive a verification URL plus a one-time code.
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={disabledStart} onClick={handleStart}>
                {startMutation.isPending ? <Spinner /> : "Start Codex login"}
              </Button>
            </div>
            {view.error && <AlertBox variant="error">{view.error}</AlertBox>}
          </div>
        )}

        {view.step === "awaiting_completion" && view.verificationUrl && view.userCode && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">1. Open the verification page</span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    window.open(view.verificationUrl ?? "", "_blank", "noopener,noreferrer")
                  }
                >
                  Open verification page
                </Button>
              </div>
              <code className="text-3xs text-muted-foreground break-all">
                {view.verificationUrl}
              </code>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">2. Enter this one-time code</span>
              <div
                aria-label="Codex device authorization code"
                className="rounded border border-border bg-muted px-3 py-2 text-center font-mono text-2xl tracking-widest select-all"
              >
                {view.userCode}
              </div>
              <div className="flex gap-2">
                <Button type="button" size="xs" variant="outline" onClick={handleCopyCode}>
                  {codeCopied ? "Copied" : "Copy code"}
                </Button>
              </div>
              <p className="text-3xs text-muted-foreground">
                The code expires in 15 minutes. Once you finish in the browser, this card flips to
                success automatically.
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner />
              <span>Waiting for browser confirmation…</span>
            </div>

            {view.error && <AlertBox variant="error">{view.error}</AlertBox>}

            <div className="flex gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {view.step === "success" && (
          <div className="flex flex-col gap-2">
            <AlertBox variant="success">
              Codex is now authenticated. Restart the agent to pick up the new credentials:
              <code className="ml-1">docker compose restart agent</code>
            </AlertBox>
            <div>
              <Button type="button" size="sm" variant="ghost" onClick={() => setView(INITIAL_VIEW)}>
                Start over
              </Button>
            </div>
          </div>
        )}

        {view.step === "error" && (
          <div className="flex flex-col gap-2">
            <AlertBox variant="error">{view.error ?? "Unknown error"}</AlertBox>
            <div>
              <Button type="button" size="sm" onClick={handleStart}>
                Retry
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
