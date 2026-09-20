import { expect, test } from "@playwright/test";
import { API_URL, openProjectBoard } from "./common";

// UC-auth.registration.sign-up-participant: регистрация и вход участника (основной источник).
// HF9.1: участники и аутентификация (контекст).
// BR-constraint.auth.sessions: сессии/CSRF (контекст).
// KI: «E2E GUI: сценарии auth/roles (L-08, L-06) невыполнимы на стенде с PARTICIPANTS_MODE_ENABLED=false» (контекст).
test("L-08: проверка состояния стенда — режим участников выключен, вход не требуется", async ({
  page,
  request,
}) => {
  // Стенд запущен с PARTICIPANTS_MODE_ENABLED=false. US-сценарий регистрации недостижим
  // (нет LoginPage, /participants возвращает participants_mode_disabled). Фиксируем
  // фактическое состояние контракта вместо имитации прохождения.
  const sessionResponse = await request.get(`${API_URL}/auth/session`);
  expect(sessionResponse.ok()).toBe(true);
  const session = (await sessionResponse.json()) as { participantsModeEnabled: boolean };
  expect(session.participantsModeEnabled).toBe(false);

  const participantsResponse = await request.get(`${API_URL}/participants`);
  expect(participantsResponse.ok()).toBe(false);
  const body = (await participantsResponse.json()) as { code?: string };
  expect(body.code).toBe("participants_mode_disabled");

  // UI не рендерит LoginPage — приложение открывается в режиме без аутентификации.
  await openProjectBoard(page);
  await expect(page.getByRole("heading", { name: "Sign in to AI Factory" })).toBeHidden();
});

// UC-auth.registration.sign-up-participant: полный сценарий регистрации первого admin (основной источник).
// HF9.1: участники и аутентификация (контекст).
// BR-constraint.auth.sessions: сессии (контекст).
// KI: «E2E GUI: сценарии auth/roles (L-08, L-06) невыполнимы на стенде с PARTICIPANTS_MODE_ENABLED=false» (контекст).
test.skip("L-08b: регистрация участника и вход — требуется PARTICIPANTS_MODE_ENABLED=true", () => {
  // Заблокировано окружением стенда (см. docs/known-issues.md).
  // При включении флага: регистрация первого участника (admin), вход, сессия+CSRF,
  // UI получает authenticated=true. Не имитируем прохождение на выключенном стенде.
});

// UC-auth.roles.assign-participant-role: администратор назначает роль участнику (основной источник).
// HF9.2: разграничение ролей и прав (контекст).
// BR-fact.auth.roles: роли участников (контекст).
// KI: «E2E GUI: сценарии auth/roles (L-08, L-06) невыполнимы на стенде с PARTICIPANTS_MODE_ENABLED=false» (контекст).
test.skip("L-06: управление ролями участников — требуется PARTICIPANTS_MODE_ENABLED=true", () => {
  // Заблокировано окружением стенда (см. docs/known-issues.md).
  // При включении флага: открыть ParticipantManagementDialog, сменить роль member↔admin,
  // проверить сохранение через PUT /participants/:id.
});

// Дополнительная проверка (negative): участники выключены — participant-меню недоступно.
// KI: «E2E GUI: сценарии auth/roles (L-08, L-06) невыполнимы на стенде с
// PARTICIPANTS_MODE_ENABLED=false» — компенсирующий UI-тест состояния без UC/US
// (явное исключение §4, аналог participants-mode.spec.ts).
test("L-06b: при выключенных участниках отсутствует participant-меню (negative)", async ({
  page,
}) => {
  await openProjectBoard(page);
  // ParticipantMenu рендерится только при participant != null; в legacy-режиме его нет.
  await expect(page.getByRole("button", { name: "Participant menu for" })).toBeHidden({
    timeout: 5_000,
  });
  // Элемент «Manage participants» отсутствует в DOM.
  await expect(page.getByText("Manage participants", { exact: true })).toBeHidden();
});
