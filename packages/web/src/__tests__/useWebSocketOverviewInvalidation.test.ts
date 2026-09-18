import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateProjectTaskOverviews } from "@/hooks/useProjects";

/**
 * Регрессия дыры инвалидации overview по WS (#143 review, must-fix #2).
 *
 * `project:runtime_limit_updated` срабатывает при изменении сохранённых
 * лимитов runtime / последнего использования. Overview агрегирует поля
 * токенов/стоимости, поэтому событие должно инвалидировать запрос
 * `["projectTaskOverviews"]` — иначе шапка дашборда и карточки проектов
 * показывают устаревшие токены/стоимость после обновления использования.
 * В этой ветке обработчик useWebSocket вызывает
 * `invalidateProjectTaskOverviews` (из useProjects); тест закрепляет хелпер,
 * чтобы будущая потеря или переименование query-ключа сразу всплыли.
 */
describe("invalidateProjectTaskOverviews (WS runtime_limit_updated branch)", () => {
  it("invalidates the projectTaskOverviews query", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    invalidateProjectTaskOverviews(queryClient);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projectTaskOverviews"] });
  });
});
